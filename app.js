/* app.js · 碎片时间做题
   设计约束（见 ARCHITECTURE.md §4）：
   - 离线优先：打开即渲染，不等网络
   - 微会话：一道题也算产出，随时锁屏走人
   - 不显示「还剩 N 题」
   - 没有连续打卡
   - freeform / table 不在手机上做（打字成本太高），留给电脑
*/
import * as S from './sync.js';

const $ = s => document.querySelector(s);
const main = $('#main'), crumb = $('#crumb'), barFill = $('#barFill');
const syncBtn = $('#syncBtn'), stopBtn = $('#stopBtn'), dueDot = $('#dueDot');
const esc = t => String(t ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const KEYS = 'ABCDEFGHI';
const DESKTOP_ONLY = new Set(['freeform', 'table']);
const STEPS = [1, 3, 7, 21, 60];
const today = () => new Date().toISOString().slice(0, 10);

let snap = { quizzes: [], states: {}, assets: [], at: 0 };
let view = 'home';
let quiz = null, idx = 0, answers = [], startedAt = '', locked = false, cur = null;
let statePatch = {};

/* ---------------- 启动 ---------------- */
(async function boot() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  snap = await S.snapshot();
  const p = new URLSearchParams(location.search).get('v');
  go(p && ['due', 'gallery', 'settings'].includes(p) ? p : 'home');
  if (await recoverDraft().catch(() => false)) go(view);
  updateDot();
  if (await S.isConfigured()) {
    S.flush();
    if (Date.now() - (snap.at || 0) > 30 * 60e3) doSync(true);   // 30 分钟以上自动拉一次
  }
})();

/* ---------------- 草稿：答一题存一次 ----------------
   iPhone 会直接回收后台的 PWA，内存里的作答跟着没了。
   下次打开时把草稿当成「中途停下」保存 —— 中途停下就是完成。 */
function saveDraft() {
  if (!quiz || !answers.length) return;
  return S.kv.set('draft', { slug: quiz._slug, unit: quiz.unit, path: quiz._path || null, startedAt,
                             total: quiz.questions.length, answers, statePatch }).catch(() => {});
}
async function recoverDraft(who = '上次中途离开的') {
  const d = await S.kv.get('draft');
  if (!d || !d.answers || !d.answers.length) return false;
  const st = snap.states[d.slug] = snap.states[d.slug] || {};
  Object.assign(st, d.statePatch || {});
  await S.kv.set('snapshot', snap);
  toast(`${who} ${d.answers.length} 道已保存`);
  if (Object.keys(d.statePatch || {}).length) await S.queueState(d.slug, d.statePatch);
  await S.queueResult(d.slug, d.unit, { course: d.slug, unit: d.unit, startedAt: d.startedAt,
    endedAt: new Date().toISOString(), completed: d.answers.length, total: d.total,
    answers: d.answers, interrupted: true }, d.path);
  await S.kv.del('draft');
  return true;
}

/* ---------------- 适配：顶栏高度 · 键盘 ---------------- */
const hdr = document.querySelector('header');
const setHdr = () => document.documentElement.style.setProperty('--hdrh', hdr.offsetHeight + 'px');
if ('ResizeObserver' in window) new ResizeObserver(setHdr).observe(hdr);
setHdr();
// 手机弹键盘时藏底栏、按钮不吸底（iOS 的 fixed 元素遇到键盘会乱跑）
const isField = el => el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(checkbox|radio|button)$/.test(el.type)));
document.addEventListener('focusin', e => { if (isField(e.target)) document.body.classList.add('kb'); });
document.addEventListener('focusout', e => { if (isField(e.target)) document.body.classList.remove('kb'); });
addEventListener('pagehide', saveDraft);

// 做题中点底栏 = 这组先按「中途停下」存好，再切走（不拦截，也不丢）
document.querySelectorAll('nav button').forEach(b => {
  b.onclick = async () => {
    if (quiz) { await saveDraft(); quiz = null; await recoverDraft('刚才做的').catch(() => {}); updateDot(); }
    go(b.dataset.v);
  };
});

/* ---------------- 接近实时的同步 ----------------
   移动端没有「一直开着」这回事。真正需要的是：
   每次你把 app 切回前台，题库就是最新的。 */
const FG_MIN_GAP = 2 * 60e3;          // 前台同步的最小间隔，防止来回切时狂拉
let lastFg = 0;

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') { saveDraft(); return; }   // 切走前存一次（含刚写的单题笔记）
  if (quiz) return;                                  // 做题中绝不打断
  if (Date.now() - lastFg < FG_MIN_GAP) return;
  if (!(await S.isConfigured())) return;
  lastFg = Date.now();
  doSync(true);                                      // 静默：失败不弹 toast
});

// 回到线上就把离线队列推出去
addEventListener('online', () => { S.flush().then(r => { if (r.pushed) updateDot(); }); });

/* ---------------- 下拉刷新 ---------------- */
(function () {
  let y0 = null, pulling = false;
  const ind = document.createElement('div');
  ind.className = 'ptr';
  ind.textContent = '下拉刷新';
  document.body.appendChild(ind);
  // 滚动的是页面本身，不是 main：只有页面在最顶上时才算下拉
  const atTop = () => (document.scrollingElement || document.documentElement).scrollTop <= 0;

  main.addEventListener('touchstart', e => {
    pulling = false; y0 = null;
    if (!atTop() || quiz) return;
    y0 = e.touches[0].clientY; pulling = true;
  }, { passive: true });

  main.addEventListener('touchmove', e => {
    if (!pulling || y0 === null) return;
    const dy = e.touches[0].clientY - y0;
    if (dy <= 0 || !atTop()) { ind.style.height = '0'; return; }
    const h = Math.min(dy * 0.45, 56);
    ind.style.height = h + 'px';
    ind.textContent = h >= 48 ? '松手刷新' : '下拉刷新';
  }, { passive: true });

  main.addEventListener('touchend', async () => {
    if (!pulling) return;
    const h = parseFloat(ind.style.height) || 0;
    pulling = false; y0 = null;
    if (h >= 48) {
      ind.textContent = '同步中…';
      lastFg = Date.now();
      await doSync(false);
      ind.textContent = '已更新';
      setTimeout(() => { ind.style.height = '0'; }, 500);
    } else {
      ind.style.height = '0';
    }
  }, { passive: true });
})();

syncBtn.onclick = () => doSync(false);
stopBtn.onclick = () => finish();

function go(v) {
  view = v; quiz = null;
  document.body.dataset.v = v;
  stopBtn.style.display = 'none';
  barFill.style.width = '0';
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  ({ home: vHome, due: vDue, gallery: vGallery, settings: vSettings }[v] || vHome)();
  scrollTo(0, 0);
}

/* ---------------- 同步 ---------------- */
async function doSync(quiet) {
  if (!(await S.isConfigured())) { if (!quiet && !quiz) go('settings'); return; }
  syncBtn.textContent = '⋯';
  try {
    const r = await S.flush();
    snap = await S.pull((d, t) => { syncBtn.textContent = t ? Math.round(d / t * 100) + '' : '⋯'; });
    syncBtn.textContent = '↻';
    updateDot();
    if (!quiet && !quiz) go(view);                   // 做题中点 ↻：只同步，不重画（重画会丢掉这组作答）
    if (r.left) toast(`还有 ${r.left} 条没推上去`);
  } catch (e) {
    syncBtn.textContent = '↻';
    if (!quiet) toast('同步失败：' + e.message);
  }
}

function toast(msg) {
  const d = document.createElement('div');
  d.className = 'toast';
  d.textContent = msg;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 3200);
}

function dueList() {
  const out = [];
  for (const q of snap.quizzes) {
    const st = snap.states[q._slug] || {};
    for (const item of (q.questions || [])) {
      if (DESKTOP_ONLY.has(item.type)) continue;
      const e = st[item.id];
      if (e && (e.nextDue || '9999') <= today())
        out.push({ ...item, _slug: q._slug, _unit: q.unit, _state: e });
    }
  }
  return out;
}
function updateDot() {
  const n = dueList().length;
  dueDot.style.display = n ? '' : 'none';
}

/* ---------------- 视图：做题 ---------------- */
function vHome() {
  crumb.innerHTML = '<b>做题</b>';
  if (!snap.quizzes.length) {
    main.innerHTML = `<div class="empty"><div class="big">◎</div>
      还没有题目<br><span style="font-size:13px">先去「设置」连上仓库，再点右上角 ↻ 同步</span></div>
      <button class="btn" id="toSet">去设置</button>`;
    $('#toSet').onclick = () => go('settings');
    return;
  }
  const by = {};
  for (const q of snap.quizzes) {
    const n = (q.questions || []).filter(x => !DESKTOP_ONLY.has(x.type)).length;
    if (!n) continue;
    (by[q._slug] = by[q._slug] || []).push({ q, n });
  }
  const parts = [`<div class="card" style="padding:16px">
     <div style="font-size:13.5px;color:var(--dim);line-height:1.7">
     做一道也算。随时锁屏走人，进度自己存。<br>
     <code>freeform</code> / <code>table</code> 这类要长打字的题留在电脑上做。</div></div>`];
  for (const [slug, list] of Object.entries(by)) {
    parts.push(`<div style="font-size:12.5px;color:var(--dim);margin:14px 4px 8px">${esc(slug)}</div>`);
    for (const { q, n } of list) {
      const st = snap.states[q._slug] || {};
      const seen = (q.questions || []).filter(x => st[x.id]).length;
      parts.push(`<button class="row" data-p="${esc(q._path)}">
        <span class="badge">U${q.unit ?? '?'}</span>
        <span><b>${esc(q.title || q._path.split('/').pop())}</b>
        <div class="sub">${n} 题可做${seen ? ` · 做过 ${seen}` : ''}</div></span></button>`);
    }
  }
  main.innerHTML = parts.join('');
  main.querySelectorAll('.row[data-p]').forEach(b => {
    b.onclick = () => {
      const q = snap.quizzes.find(x => x._path === b.dataset.p);
      start({ ...q, questions: q.questions.filter(x => !DESKTOP_ONLY.has(x.type)) });
    };
  });
}

/* ---------------- 视图：到期 ---------------- */
function vDue() {
  crumb.innerHTML = '<b>到期回忆</b>';
  const due = dueList();
  if (!due.length) {
    main.innerHTML = `<div class="empty"><div class="big">✓</div>
      今天没有到期的题<br><span style="font-size:13px">间隔 1 → 3 → 7 → 21 → 60 天，答错回到 1 天</span></div>`;
    return;
  }
  const by = {};
  due.forEach(q => (by[q._slug] = by[q._slug] || []).push(q));
  main.innerHTML = `<div class="card" style="padding:16px">
      <div class="q" style="font-size:18px;margin-bottom:10px">${due.length} 道今天到期</div>
      <div style="font-size:13.5px;color:var(--dim);line-height:1.7">
      到期 = 上次答对后的间隔走完了。<b>现在答得出来，才叫学会了。</b></div></div>` +
    Object.entries(by).map(([s, l]) => `<button class="row" data-c="${esc(s)}">
      <span class="badge">${l.length}</span><span><b>${esc(s)}</b>
      <div class="sub">${l.length} 道到期</div></span></button>`).join('') +
    `<button class="btn" id="allBtn" style="margin-top:8px">全部 ${due.length} 道</button>`;
  main.querySelectorAll('.row[data-c]').forEach(b => {
    b.onclick = () => start({ _slug: b.dataset.c, unit: '复习', title: '到期回忆', questions: by[b.dataset.c] });
  });
  $('#allBtn').onclick = () => start({ _slug: due[0]._slug, unit: '复习', title: '到期回忆', questions: due });
}

/* ---------------- 视图：图库 ---------------- */
function vGallery() {
  crumb.innerHTML = '<b>图库</b>';
  if (!snap.assets.length) {
    main.innerHTML = `<div class="empty"><div class="big">▦</div>
      还没有图解<br><span style="font-size:13px">课程 session 画的图会同步到这里</span></div>`;
    return;
  }
  main.innerHTML = '<div id="galleryView">' + snap.assets.map((a, i) => `<div class="fig">
      <h3>${esc(a.title || a.file)}</h3>
      <div class="meta">${esc(a.slug)}${a.unit ? ' · ' + esc(a.unit) : ''}</div>
      ${a.svg ? `<div class="wrap" data-i="${i}" role="button" aria-label="放大看">${a.svg}<span class="zh">⤢ 点开放大</span></div>`
              : '<div class="empty">图未同步</div>'}
      ${a.caption ? `<div class="cap">${esc(a.caption)}</div>` : ''}
      ${(a.recall && a.recall.length) ? `<details><summary>看图能不能答出这几个</summary>
        <ul>${a.recall.map(r => `<li>${esc(r)}</li>`).join('')}</ul></details>` : ''}
    </div>`).join('') + '</div>';
  main.querySelectorAll('.wrap[data-i]').forEach(w => { w.onclick = () => openViewer(snap.assets[+w.dataset.i]); });
}

/* 全屏看图：手机上默认原始大小（900 宽，字才看得清，左右拖）；屏幕够宽时默认适应屏幕。
   安卓返回键 = 关掉大图，不是退出 app */
const viewer = $('#viewer'), vSvg = $('#vSvg'), vFit = $('#vFit');
function setFit(on) { viewer.classList.toggle('fit', on); vFit.textContent = on ? '原始大小' : '适应屏幕'; }
function openViewer(a) {
  $('#vTitle').textContent = a.title || a.file || '';
  vSvg.innerHTML = a.svg || '';
  setFit(innerWidth >= 940);
  viewer.hidden = false;
  viewer.querySelector('.vbody').scrollTo(0, 0);
  history.pushState({ viewer: 1 }, '');
}
function closeViewer() { if (viewer.hidden) return; viewer.hidden = true; vSvg.innerHTML = ''; }
vFit.onclick = () => setFit(!viewer.classList.contains('fit'));
$('#vClose').onclick = () => { if (history.state && history.state.viewer) history.back(); else closeViewer(); };
addEventListener('popstate', closeViewer);

/* ---------------- 视图：设置 ---------------- */
async function vSettings() {
  crumb.innerHTML = '<b>设置</b>';
  const c = await S.getCfg();
  const left = await S.queue.count();
  main.innerHTML = `<div class="card">
    <div class="q" style="font-size:18px">连接私有仓库</div>
    <div style="font-size:13.5px;color:var(--dim);line-height:1.7;margin-bottom:18px">
      不需要在电脑上开服务器。题目和图解从 GitHub 拉，作答推回去。<br>
      Token 只存在这台设备上。</div>
    <label class="f"><span>GitHub 用户名</span><input type="text" id="fo" value="${esc(c.owner)}" autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="username"></label>
    <label class="f"><span>仓库名</span><input type="text" id="fr" value="${esc(c.repo)}" autocapitalize="none" autocorrect="off" spellcheck="false"></label>
    <label class="f"><span>分支</span><input type="text" id="fb" value="${esc(c.branch || 'main')}" autocapitalize="none" autocorrect="off" spellcheck="false"></label>
    <label class="f"><span>Fine-grained PAT（只给这个仓库的 Contents 读写）</span>
      <input type="password" id="ft" value="${esc(c.token)}" autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="off"></label>
    <button class="btn" id="save">保存并同步</button>
    <button class="btn sec" id="notif">开启到期提醒</button>
    <div style="font-size:12.5px;color:var(--dim);margin-top:14px;line-height:1.7">
      上次同步：${snap.at ? new Date(snap.at).toLocaleString('zh-CN') : '从未'}<br>
      题库 ${snap.quizzes.length} 组 · 图 ${snap.assets.length} 张${left ? ` · <b style="color:var(--bad)">${left} 条待推送</b>` : ''}
    </div>
  </div>
  <div class="card">
    <div style="font-size:13.5px;color:var(--dim);line-height:1.8">
      <b style="color:var(--ink)">怎么装到主屏</b><br>
      iPhone / iPad：<b>用 Safari</b> 打开 → 分享 ⎋ → 添加到主屏幕<br>
      安卓手机 / 平板：Chrome 打开 → 右上角 ⋮ → 安装应用（或「添加到主屏幕」）<br><br>
      装到主屏后才是全屏、离线、能收推送。
    </div>
  </div>`;
  $('#save').onclick = async () => {
    await S.setCfg({ owner: $('#fo').value.trim(), repo: $('#fr').value.trim(),
                     branch: $('#fb').value.trim() || 'main', token: $('#ft').value.trim() });
    await doSync(false);
    toast('已保存');
  };
  $('#notif').onclick = async () => {
    if (!('Notification' in window)) return toast('这个浏览器不支持通知');
    const p = await Notification.requestPermission();
    toast(p === 'granted' ? '已开启（需要推送服务端才会真的响，见 README）' : '没有授权');
  };
}

/* ---------------- 答题引擎 ---------------- */
function start(q) {
  quiz = q; idx = 0; answers = []; statePatch = {};
  startedAt = new Date().toISOString();
  stopBtn.style.display = '';
  render();
}

function render() {
  if (idx >= quiz.questions.length) return finish();
  const q = quiz.questions[idx];
  cur = { q, picked: null }; locked = false;
  document.body.dataset.v = 'quiz';
  crumb.innerHTML = `<b>${esc(quiz._slug)}</b> · 第 ${idx + 1} 题`;   // 不显示总数
  barFill.style.width = (idx / quiz.questions.length * 100) + '%';
  main.innerHTML = '';
  // 题干 .qa · 作答 .qb · 按钮 .acts —— 手机上竖排、按钮吸底；横屏宽屏左右两栏（CSS 管）
  const card = document.createElement('div'); card.className = 'card qcard';
  const qa = document.createElement('div'); qa.className = 'qa';
  qa.innerHTML = `<p class="q">${q.prompt || ''}</p>` +
    (q.code ? `<pre>${esc(q.code)}</pre>` : '') +
    (q.statement ? `<div class="stmt">${esc(q.statement)}</div>` : '');
  const qb = document.createElement('div'); qb.className = 'qb';
  const acts = document.createElement('div'); acts.className = 'acts';
  const dk = document.createElement('button');
  dk.className = 'btn sec'; dk.id = 'dkBtn'; dk.textContent = '不会';
  dk.onclick = onDunno;
  const go = document.createElement('button');
  go.className = 'btn'; go.id = 'goBtn'; go.textContent = '提交'; go.disabled = true;
  go.onclick = onGo;
  acts.append(dk, go);
  card.append(qa, qb, acts);
  main.appendChild(card);
  // 按钮先进 DOM 再渲染题型：排序题一开始就可以提交（setReady 要找得到 #goBtn）
  ({ mcq: rMcq, multi: rMcq, order: rOrder, match: rMatch, fill: rFill,
     place: rPlace, judge: rJudge }[q.type] || rMcq)(qb, q);
  scrollTo(0, 0);
}

function setReady(ok) { const b = $('#goBtn'); if (b) b.disabled = !ok; }

function rMcq(card, q) {
  const multi = q.type === 'multi', sel = new Set();
  const box = document.createElement('div');
  q.options.forEach((o, i) => {
    const b = document.createElement('button');
    b.className = 'opt';
    b.innerHTML = `<span class="k">${KEYS[i]}</span><span>${esc(o)}</span>`;   // 多选也标字母：反馈里要引用
    b.onclick = () => {
      if (locked) return;
      if (multi) { sel.has(i) ? sel.delete(i) : sel.add(i); b.classList.toggle('sel'); }
      else { box.querySelectorAll('.opt').forEach(x => x.classList.remove('sel')); b.classList.add('sel'); sel.clear(); sel.add(i); }
      cur.picked = multi ? [...sel].sort((a, c) => a - c) : [...sel][0];
      setReady(multi ? sel.size > 0 : true);
    };
    box.appendChild(b);
  });
  card.appendChild(box);
  cur.grade = () => {
    const ok = eq(cur.picked, q.answer);
    const right = multi ? q.answer : [q.answer];
    box.querySelectorAll('.opt').forEach((d, i) => {
      d.classList.remove('sel');
      if (right.includes(i)) d.classList.add('right');
      else if ((multi ? cur.picked : [cur.picked]).includes(i)) d.classList.add('wrong');
    });
    return ok;
  };
}

function rOrder(card, q) {
  const order = q.items.map((_, i) => i);
  const list = document.createElement('div'); list.className = 'dl';
  const draw = () => {
    list.innerHTML = '';
    order.forEach((oi, pos) => {
      const d = document.createElement('div'); d.className = 'di';
      d.innerHTML = `<span class="n">${pos + 1}</span><span style="flex:1">${esc(q.items[oi])}</span>
        <span class="mv"><button data-u="${pos}">↑</button><button data-d="${pos}">↓</button></span>`;
      list.appendChild(d);
    });
    list.querySelectorAll('[data-u]').forEach(b => b.onclick = () => { if (locked) return;
      const i = +b.dataset.u; if (i > 0) { [order[i - 1], order[i]] = [order[i], order[i - 1]]; cur.picked = [...order]; draw(); } });
    list.querySelectorAll('[data-d]').forEach(b => b.onclick = () => { if (locked) return;
      const i = +b.dataset.d; if (i < order.length - 1) { [order[i + 1], order[i]] = [order[i], order[i + 1]]; cur.picked = [...order]; draw(); } });
  };
  draw(); card.appendChild(list);
  cur.picked = [...order]; setReady(true);
  cur.grade = () => {
    const ok = eq(cur.picked, q.answer);
    list.querySelectorAll('.di').forEach((d, i) => {
      d.style.borderColor = cur.picked[i] === q.answer[i] ? 'var(--ok)' : 'var(--bad)';
      d.querySelector('.mv').style.display = 'none';
    });
    return ok;
  };
}

function rMatch(card, q) {
  const pairs = Array(q.left.length).fill(null); let active = null;
  const g = document.createElement('div'); g.className = 'mg';
  const cl = document.createElement('div'), cr = document.createElement('div');
  cl.style.cssText = cr.style.cssText = 'display:flex;flex-direction:column;gap:9px';
  g.append(cl, cr); card.appendChild(g);
  const draw = () => {
    cl.innerHTML = ''; cr.innerHTML = '';
    q.left.forEach((t, i) => {
      const b = document.createElement('button');
      b.className = 'mi' + (active === i ? ' active' : '') + (pairs[i] != null ? ' paired' : '');
      b.innerHTML = esc(t) + (pairs[i] != null ? `<span class="tg">${pairs[i] + 1}</span>` : '');
      b.onclick = () => { if (locked) return; active = active === i ? null : i; draw(); };
      cl.appendChild(b);
    });
    q.right.forEach((t, j) => {
      const b = document.createElement('button');
      const owner = pairs.indexOf(j);
      b.className = 'mi' + (owner >= 0 ? ' paired' : '');
      b.innerHTML = esc(t) + (owner >= 0 ? `<span class="tg">${j + 1}</span>` : '');
      b.onclick = () => {
        if (locked || active == null) return;
        const prev = pairs.indexOf(j); if (prev >= 0) pairs[prev] = null;
        pairs[active] = j; active = null; cur.picked = [...pairs];
        setReady(!pairs.some(x => x == null)); draw();
      };
      cr.appendChild(b);
    });
  };
  draw();
  cur.grade = () => {
    const ok = eq(cur.picked, q.answer);
    cl.querySelectorAll('.mi').forEach((d, i) => d.classList.add(pairs[i] === q.answer[i] ? 'right' : 'wrong'));
    return ok;
  };
}

function poolOf(q, onPick) {
  const pool = document.createElement('div'); pool.className = 'pool';
  (q.pool || q.blocks).forEach((t, i) => {
    const b = document.createElement('button'); b.className = 'tok'; b.textContent = t; b.dataset.i = i;
    b.onclick = () => onPick(i, b);
    pool.appendChild(b);
  });
  return pool;
}

function rFill(card, q) {
  const n = (q.template.match(/__\d+__/g) || []).length;
  const picked = Array(n).fill(null); let armed = null;
  const tmpl = document.createElement('div'); tmpl.className = 'tmpl';
  tmpl.innerHTML = esc(q.template).replace(/__(\d+)__/g, (_, k) => `<span class="slot" data-k="${+k - 1}">?</span>`);
  card.appendChild(tmpl);
  const pool = poolOf(q, (i, el) => {
    armed = i; pool.querySelectorAll('.tok').forEach(t => t.classList.remove('armed')); el.classList.add('armed');
  });
  card.appendChild(pool);
  const sync = () => {
    pool.querySelectorAll('.tok').forEach((t, i) => t.classList.toggle('used', picked.includes(i)));
    tmpl.querySelectorAll('.slot').forEach((s, k) => {
      s.textContent = picked[k] == null ? '?' : q.pool[picked[k]];
      s.classList.toggle('filled', picked[k] != null);
    });
    cur.picked = [...picked]; setReady(!picked.some(x => x == null));
  };
  tmpl.querySelectorAll('.slot').forEach((s, k) => s.onclick = () => {
    if (locked) return;
    if (armed == null) { picked[k] = null; sync(); return; }
    const dup = picked.indexOf(armed); if (dup >= 0) picked[dup] = null;
    picked[k] = armed; armed = null;
    pool.querySelectorAll('.tok').forEach(t => t.classList.remove('armed'));
    sync();
  });
  sync();
  cur.grade = () => {
    const ok = eq(cur.picked, q.answer);
    tmpl.querySelectorAll('.slot').forEach((s, k) => s.style.borderColor = picked[k] === q.answer[k] ? 'var(--ok)' : 'var(--bad)');
    return ok;
  };
}

function rPlace(card, q) {
  const picked = Array(q.slots.length).fill(null); let armed = null;
  const rows = document.createElement('div');
  q.slots.forEach((lab, k) => {
    const r = document.createElement('div'); r.className = 'srow';
    r.innerHTML = `<span class="lab">${esc(lab)}</span>`;
    const s = document.createElement('span'); s.className = 'slot'; s.textContent = '点这里'; s.dataset.k = k;
    r.appendChild(s); rows.appendChild(r);
  });
  card.appendChild(rows);
  const pool = poolOf(q, (i, el) => {
    armed = i; pool.querySelectorAll('.tok').forEach(t => t.classList.remove('armed')); el.classList.add('armed');
  });
  card.appendChild(pool);
  const sync = () => {
    pool.querySelectorAll('.tok').forEach((t, i) => t.classList.toggle('used', picked.includes(i)));
    rows.querySelectorAll('.slot').forEach((s, k) => {
      s.textContent = picked[k] == null ? '点这里' : q.blocks[picked[k]];
      s.classList.toggle('filled', picked[k] != null);
    });
    cur.picked = [...picked]; setReady(!picked.some(x => x == null));
  };
  rows.querySelectorAll('.slot').forEach((s, k) => s.onclick = () => {
    if (locked) return;
    if (armed == null) { picked[k] = null; sync(); return; }
    const dup = picked.indexOf(armed); if (dup >= 0) picked[dup] = null;
    picked[k] = armed; armed = null;
    pool.querySelectorAll('.tok').forEach(t => t.classList.remove('armed'));
    sync();
  });
  sync();
  cur.grade = () => {
    const ok = eq(cur.picked, q.answer);
    rows.querySelectorAll('.slot').forEach((s, k) => s.style.borderColor = picked[k] === q.answer[k] ? 'var(--ok)' : 'var(--bad)');
    return ok;
  };
}

function rJudge(card, q) {
  let tf = null;
  const box = document.createElement('div'); box.className = 'tf';
  ['对', '错'].forEach((t, i) => {
    const b = document.createElement('button'); b.textContent = t;
    b.onclick = () => {
      if (locked) return;
      tf = i === 0;
      box.querySelectorAll('button').forEach(x => x.classList.remove('sel'));
      b.classList.add('sel'); check();
    };
    box.appendChild(b);
  });
  card.appendChild(box);
  const ta = document.createElement('textarea');
  ta.placeholder = '一句话理由。手机上写短的就行，我在电脑上批。';
  ta.oninput = check; card.appendChild(ta);
  function check() {
    cur.picked = { tf, reason: ta.value.trim() };
    setReady(tf !== null && (!q.requireReason || ta.value.trim().length >= 2));
  }
  check();
  cur.grade = () => {
    ta.disabled = true;
    box.querySelectorAll('button').forEach(b => b.disabled = true);
    return cur.picked.tf === q.answer;
  };
}

/* ---- 每道题的独立笔记框 ---- */
function attachNote(card, ansRef) {
  const box = document.createElement('div');
  box.style.cssText = 'margin-top:12px;border-top:1px dashed var(--line);padding-top:12px';
  box.innerHTML = '<div style="font-size:12.5px;color:var(--dim);margin-bottom:8px">' +
    '这题有什么想法？<b style="color:var(--accent)">一句就行，空着也行</b></div>' +
    '<div id="qmini" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">' +
    '<button class="chip" data-c="其实是蒙的：">蒙的</button>' +
    '<button class="chip" data-c="没明白：">没明白</button>' +
    '<button class="chip" data-c="我觉得讲错了：">讲错了</button>' +
    '<button class="chip" data-c="追问：">追问</button></div>';
  const ta = document.createElement('textarea');
  ta.placeholder = '例：选对了，但说不清为什么。';
  ta.style.minHeight = '64px';
  box.appendChild(ta);
  card.appendChild(box);
  box.querySelectorAll('.chip').forEach(function (b) {
    b.onclick = function () {
      ta.value += (ta.value && !ta.value.endsWith('\n') ? '\n' : '') + b.dataset.c;
      ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length;
      ta.dispatchEvent(new Event('input'));
    };
  });
  ta.oninput = function () { ansRef.note = ta.value.trim(); };
}

/* ---------------- 提交 ---------------- */
function onGo() {
  const q = quiz.questions[idx], b = $('#goBtn');
  if (!locked) {
    locked = true; b.textContent = '下一题';
    const correct = cur.grade();
    const pending = q.type === 'judge' && q.requireReason;
    const dk = $('#dkBtn'); if (dk) dk.remove();       // 提交后「不会」没意义了，让「下一题」占满一行
    // 小屏上正确选项可能已经滚出屏幕：答错时反馈里直接写出来，不用往回翻
    const key = (q.type === 'mcq' || q.type === 'multi') && !correct
      ? ' · 正确答案 ' + [].concat(q.answer).map(i => KEYS[i]).join('、') : '';
    const fb = document.createElement('div');
    fb.className = 'fb ' + (pending ? 'pd' : correct ? 'ok' : 'no');
    fb.innerHTML = `<b>${pending ? (correct ? '判断对了 · 理由回电脑上批' : '判断错了 · 理由回电脑上批') : correct ? '对' : '错' + key}</b>` +
      esc(q.explain || '').replace(/\n/g, '<br>');
    main.querySelector('.qb').appendChild(fb);
    fb.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    bump(q.id, correct);
    answers.push({ id: q.id, type: q.type, correct: pending ? null : correct,
                   status: pending ? 'pending_review' : 'graded',
                   picked: cur.picked, reason: q.type === 'judge' ? cur.picked.reason : undefined });
    attachNote(main.querySelector('.qb'), answers[answers.length - 1]);
    saveDraft();
    if (navigator.vibrate) navigator.vibrate(correct ? 12 : [12, 60, 12]);
  } else { idx++; render(); }
}

function onDunno() {
  if (!quiz || locked) return;
  const q = quiz.questions[idx];
  locked = true;
  const go = $('#goBtn'); go.textContent = '下一题'; go.disabled = false;
  const dk = $('#dkBtn'); if (dk) dk.remove();
  try { cur.grade && cur.grade(); } catch (e) {}
  const fb = document.createElement('div');
  fb.className = 'fb pd';
  fb.innerHTML = '<b>记下了：不会</b>' +
    esc(q.explain || '（这题没写解释，回电脑上问）').replace(/\n/g, '<br>') +
    '<div style="font-size:12.5px;color:var(--dim);margin-top:8px;line-height:1.65">' +
    '标成了<b>需要重讲</b>，不是「答错」。1 天后回来，而且会换一种形式讲。<br>' +
    '<b style="color:var(--accent)">诚实说不会，比蒙对有价值得多。</b></div>';
  main.querySelector('.qb').appendChild(fb);
  fb.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  bump(q.id, false, true);
  answers.push({ id: q.id, type: q.type, correct: false, status: 'dont_know',
                 prompt: q.prompt || q.statement || '' });
  attachNote(main.querySelector('.qb'), answers[answers.length - 1]);
  saveDraft();
  if (navigator.vibrate) navigator.vibrate(20);
}

function bump(id, correct, dontKnow) {
  const slug = quiz._slug;
  const st = snap.states[slug] = snap.states[slug] || {};
  const e = st[id] || { seen: 0, correct: 0, interval: 0, dk: 0 };
  e.seen++;
  if (dontKnow) { e.dk = (e.dk || 0) + 1; e.needsTeaching = true; e.lastOutcome = 'dont_know'; }
  else { e.lastOutcome = correct ? 'right' : 'wrong'; if (correct) e.needsTeaching = false; }
  if (correct) { e.correct++; e.interval = STEPS[Math.min(STEPS.indexOf(e.interval) + 1, STEPS.length - 1)] || 1; }
  else e.interval = 1;
  const d = new Date(); d.setDate(d.getDate() + e.interval);
  e.lastSeen = today(); e.nextDue = d.toISOString().slice(0, 10);
  st[id] = e;
  statePatch[id] = e;
}

async function finish() {
  const done = answers.length;
  const graded = answers.filter(a => a.status === 'graded');
  const right = graded.filter(a => a.correct).length;
  const slug = quiz._slug, unit = quiz.unit, qpath = quiz._path || null;
  const result = { course: slug, unit, startedAt, endedAt: new Date().toISOString(),
                   completed: done, total: quiz.questions.length, answers };
  quiz = null; stopBtn.style.display = 'none'; barFill.style.width = '100%';
  document.body.dataset.v = 'done';
  crumb.innerHTML = '<b>完成</b>';
  main.innerHTML = `<div class="card">
    <div class="q" style="margin-bottom:6px">做了 ${done} 道</div>
    <div style="color:var(--dim);font-size:14px;margin-bottom:18px">中途停下就是完成。</div>
    <div style="display:flex;gap:26px;margin-bottom:18px">
      <div><div style="font-size:30px;font-weight:700;color:var(--accent);line-height:1.2">${right}/${graded.length || 0}</div>
        <div style="font-size:11.5px;color:var(--dim)">自动判分</div></div>
      <div><div style="font-size:30px;font-weight:700;color:var(--accent);line-height:1.2">${answers.filter(a => a.status === 'pending_review').length}</div>
        <div style="font-size:11.5px;color:var(--dim)">待电脑上批</div></div>
      <div><div style="font-size:30px;font-weight:700;color:var(--accent);line-height:1.2">${answers.filter(a => a.status === 'dont_know').length}</div>
        <div style="font-size:11.5px;color:var(--dim)">标了不会</div></div>
    </div>
    <div id="pushInfo" style="font-size:13px;color:var(--dim)">保存中…</div>
  </div>
  <div class="card" style="border-color:var(--accent)">
    <div style="font-size:16px;color:var(--accent);font-weight:600;margin-bottom:4px">整组还有什么想说的？</div>
    <div style="font-size:13px;color:var(--dim);line-height:1.7;margin-bottom:12px">
      单题的想法写在每题下面就行。这里放<b>整组层面</b>的。空着也行。</div>
    <div id="chips" style="display:flex;flex-wrap:wrap;gap:7px;margin-bottom:10px">
      <button class="chip" data-c="最没把握的是：">最没把握</button>
      <button class="chip" data-c="这个解释我没看懂：">没看懂</button>
      <button class="chip" data-c="我觉得这里讲错了：">讲错了</button>
      <button class="chip" data-c="想追问：">想追问</button>
    </div>
    <textarea id="reflectBox" placeholder="例：第 4 题选对了，其实是蒙的。"></textarea>
    <div id="savedTip" style="font-size:12px;color:var(--dim);margin-top:8px;height:16px"></div>
  </div>
  <button class="btn" id="more">再来一组</button>
  <button class="btn sec" id="back">回到做题</button>`;
  $('#more').onclick = () => go(view === 'due' ? 'due' : 'home');
  $('#back').onclick = () => go('home');
  // 「哪里没明白」
  (function () {
    const box = $('#reflectBox'), tip = $('#savedTip');
    if (!box) return;
    main.querySelectorAll('#chips .chip').forEach(function (b) {
      b.onclick = function () {
        box.value += (box.value && !box.value.endsWith('\n') ? '\n' : '') + b.dataset.c;
        box.focus();
        box.selectionStart = box.selectionEnd = box.value.length;
        box.dispatchEvent(new Event('input'));
      };
    });
    let t = null;
    box.oninput = function () {
      tip.textContent = '写着…'; tip.style.color = 'var(--dim)';
      clearTimeout(t);
      t = setTimeout(async function () {
        result.reflection = { text: box.value.trim(), at: new Date().toISOString() };
        try {
          const r = await S.queueResult(slug, unit, result, qpath);   // 同 key 覆盖队列里那条
          tip.style.color = 'var(--accent)';
          tip.textContent = r.left ? '已存本机，等有网推送' : '已推回仓库 ✓';
        } catch (e) { tip.textContent = '已存本机'; }
      }, 800);
    };
  })();

  scrollTo(0, 0);
  if (!done) { $('#pushInfo').textContent = '没有作答，不记录。'; S.kv.del('draft').catch(() => {}); updateDot(); return; }
  try {
    await S.kv.set('snapshot', snap);
    if (Object.keys(statePatch).length) await S.queueState(slug, statePatch);
    const r = await S.queueResult(slug, unit, result, qpath);
    await S.kv.del('draft');
    $('#pushInfo').innerHTML = r.left
      ? `已存在本机，<b>${r.left} 条等有网时推送</b>`
      : '已推回仓库 ✓';
  } catch (e) {
    $('#pushInfo').textContent = '已存在本机（' + e.message + '）';
  }
  updateDot();
}
