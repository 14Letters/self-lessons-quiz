/* sync.js · GitHub 私有仓库当同步通道
   不需要在电脑上搭服务器：电脑关机也能用。
   认证用 fine-grained PAT，只给这一个 repo 的 Contents 读写。
*/
const DB_NAME = 'self-lessons';
const DB_VER = 1;

/* ---------------- IndexedDB ---------------- */
let _db;
function db() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if (!d.objectStoreNames.contains('queue')) d.createObjectStore('queue', { keyPath: 'k' });
    };
    r.onsuccess = () => { _db = r.result; res(_db); };
    r.onerror = () => rej(r.error);
  });
}
function tx(store, mode, fn) {
  return db().then(d => new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    const out = fn(s);
    // 请求就取 result：key 不存在时是 undefined。以前在这里把请求对象本身返回了（真值），
    // 全新安装时 snapshot() 拿到它当快照 → 首页 snap.quizzes.length 抛错，白屏
    t.oncomplete = () => res(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => rej(t.error);
  }));
}
export const kv = {
  get: k => tx('kv', 'readonly', s => s.get(k)),
  set: (k, v) => tx('kv', 'readwrite', s => s.put(v, k)),
  del: k => tx('kv', 'readwrite', s => s.delete(k)),
};
export const queue = {
  all: () => tx('queue', 'readonly', s => s.getAll()),
  put: item => tx('queue', 'readwrite', s => s.put(item)),
  del: k => tx('queue', 'readwrite', s => s.delete(k)),
  count: () => tx('queue', 'readonly', s => s.count()),
};

/* ---------------- 配置 ---------------- */
export async function getCfg() {
  return (await kv.get('cfg')) || { owner: '', repo: '', branch: 'main', token: '' };
}
export async function setCfg(c) { await kv.set('cfg', c); }
export async function isConfigured() {
  const c = await getCfg();
  return !!(c.owner && c.repo && c.token);
}

/* ---------------- GitHub API ---------------- */
const B64 = {
  enc: s => btoa(String.fromCharCode(...new TextEncoder().encode(s))),
  dec: b => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\s/g, '')), c => c.charCodeAt(0))),
};

async function gh(path, opts = {}) {
  const c = await getCfg();
  if (!c.token) throw new Error('未配置 token');
  const r = await fetch('https://api.github.com' + path, {
    ...opts,
    headers: {
      Authorization: 'Bearer ' + c.token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...opts.headers,
    },
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error('GitHub ' + r.status + ': ' + t.slice(0, 160));
  }
  return r.status === 204 ? null : r.json();
}

/** 整棵树，一次请求拿全部路径 */
export async function tree() {
  const c = await getCfg();
  const j = await gh(`/repos/${c.owner}/${c.repo}/git/trees/${c.branch}?recursive=1`);
  return (j.tree || []).filter(n => n.type === 'blob').map(n => n.path);
}

export async function readFile(path) {
  const c = await getCfg();
  const j = await gh(`/repos/${c.owner}/${c.repo}/contents/${encodeURI(path)}?ref=${c.branch}`);
  return { text: B64.dec(j.content), sha: j.sha };
}

export async function writeFile(path, text, message) {
  const c = await getCfg();
  let sha;
  try { sha = (await readFile(path)).sha; } catch (_) { /* 新文件 */ }
  return gh(`/repos/${c.owner}/${c.repo}/contents/${encodeURI(path)}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: message || ('quiz: update ' + path),
      content: B64.enc(text),
      branch: c.branch,
      ...(sha ? { sha } : {}),
    }),
  });
}

/* ---------------- 拉取 ---------------- */
export async function pull(onProgress) {
  const paths = await tree();
  const quizPaths = paths.filter(p => /courses\/[^/]+\/exercises\/.*-quiz\.json$/.test(p));
  const statePaths = paths.filter(p => /courses\/[^/]+\/exercises\/quiz-state\.json$/.test(p));
  const assetIdx = paths.filter(p => /(courses\/[^/]+|hub)\/assets\/index\.json$/.test(p));

  const quizzes = [], states = {}, assets = [];
  let done = 0;
  const total = quizPaths.length + statePaths.length + assetIdx.length;
  const step = () => onProgress && onProgress(++done, total);

  for (const p of quizPaths) {
    try {
      const j = JSON.parse((await readFile(p)).text);
      j._path = p;
      j._slug = p.split('/')[1];
      quizzes.push(j);
    } catch (_) {}
    step();
  }
  for (const p of statePaths) {
    try { states[p.split('/')[1]] = JSON.parse((await readFile(p)).text); } catch (_) {}
    step();
  }
  for (const p of assetIdx) {
    const base = p.replace(/index\.json$/, '');
    try {
      const j = JSON.parse((await readFile(p)).text);
      for (const a of (j.assets || [])) {
        if (a.kind !== 'diagram') continue;
        let svg = '';
        try { svg = (await readFile(base + a.file)).text; } catch (_) {}
        assets.push({ ...a, slug: j.course || base.split('/')[1], svg });
      }
    } catch (_) {}
    step();
  }

  const snap = { quizzes, states, assets, at: Date.now() };
  await kv.set('snapshot', snap);
  return snap;
}

export async function snapshot() {
  return (await kv.get('snapshot')) || { quizzes: [], states: {}, assets: [], at: 0 };
}

/* ---------------- 推送（离线队列） ---------------- */
/** 把一次作答排进队列。有网就马上推，没网就等下次。
    quizPath：题目文件在仓库里的路径 → 结果写到同名的 -result.json（和电脑端同一规则） */
export async function queueResult(slug, unit, result, quizPath) {
  const k = `${slug}|${unit}|${result.endedAt}`;
  await queue.put({ k, slug, unit, result, path: quizPath || null, at: Date.now() });
  return flush();
}

/** 把 state 变更排队（键级合并，不整文件覆盖） */
export async function queueState(slug, patch) {
  const k = `state|${slug}`;
  const prev = (await queue.all()).find(x => x.k === k);
  const merged = { ...(prev ? prev.patch : {}), ...patch };
  await queue.put({ k, slug, patch: merged, at: Date.now() });
  return flush();
}

let flushing = false;
export async function flush() {
  if (flushing || !navigator.onLine) return { pushed: 0, left: await queue.count() };
  if (!(await isConfigured())) return { pushed: 0, left: await queue.count() };
  flushing = true;
  let pushed = 0;
  try {
    for (const item of await queue.all()) {
      try {
        if (item.k.startsWith('state|')) {
          const p = `courses/${item.slug}/exercises/quiz-state.json`;
          let cur = {};
          try { cur = JSON.parse((await readFile(p)).text); } catch (_) {}
          // 键级合并：同一题两端都答过，取 seen 更大的
          for (const [id, v] of Object.entries(item.patch)) {
            const old = cur[id];
            cur[id] = (!old || (v.seen || 0) >= (old.seen || 0)) ? v : old;
          }
          // 缩进和电脑端一致（2）：格式不同的话，每次写都会改动整个文件，git 合并必冲突
          await writeFile(p, JSON.stringify(cur, null, 2), `quiz: state ${item.slug} (mobile)`);
        } else {
          // 有题目路径：u07-math-quiz.json → u07-math-result.json（和电脑端 main.js 一致）
          // 没有（到期回忆、旧队列里的项）：按单元号 / 日期起名
          const u = String(item.unit);
          const name = /^\d+(\.\d+)?$/.test(u)
            ? `u${u.padStart(2, '0')}-result.json`
            : `review-${String(item.result.endedAt || '').slice(0, 10) || 'undated'}-result.json`;
          const p = (item.path && /-quiz\.json$/.test(item.path))
            ? item.path.replace(/-quiz\.json$/, '-result.json')
            : `courses/${item.slug}/exercises/${name}`;
          let runs = [];
          try {
            const old = JSON.parse((await readFile(p)).text);
            runs = Array.isArray(old.runs) ? old.runs
                 : Array.isArray(old.history)
                   ? old.history.map(h => (h.answers ? h : { ...h, answers: (old.answers || []) }))
                   : [old];
          } catch (_) {}
          const thisRun = {
            startedAt: item.result.startedAt, endedAt: item.result.endedAt,
            completed: item.result.completed, total: item.result.total,
            answers: item.result.answers, reflection: item.result.reflection || null,
            source: 'mobile',
          };
          const k2 = runs.findIndex(r => r.startedAt === item.result.startedAt);
          if (k2 >= 0) runs[k2] = thisRun; else runs.push(thisRun);
          if (runs.length > 20) runs = runs.slice(-20);
          const payload = { ...item.result, source: 'mobile', attempts: runs.length, runs };
          delete payload.history;
          await writeFile(p, JSON.stringify(payload, null, 2), `quiz: result ${item.slug} U${item.unit} (mobile)`);
        }
        await queue.del(item.k);
        pushed++;
      } catch (e) {
        console.warn('push failed, keep in queue', item.k, e.message);
        break;                       // 一个失败就停，保住顺序
      }
    }
  } finally { flushing = false; }
  return { pushed, left: await queue.count() };
}

addEventListener('online', () => flush());
