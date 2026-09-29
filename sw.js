/* Service Worker · 离线优先
   壳：cache-first（打开即渲染，不等网络）
   数据：由 app 走 IndexedDB，SW 不缓存 GitHub API 响应（避免拿到陈旧的 sha 导致写冲突）
*/
const VERSION = 'v3';   // 2026-09-29 手机 / 平板适配：改了壳就要升版本，装好的 app 才会换新
const SHELL = 'shell-' + VERSION;
const ASSETS = 'assets-' + VERSION;

const SHELL_FILES = [
  './',
  './index.html',
  './app.js',
  './sync.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(SHELL)
      .then(c => c.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())          // 某个文件 404 也不要卡住安装
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== SHELL && k !== ASSETS).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // GitHub API：永远走网络，失败就让 app 自己回退到 IndexedDB
  if (url.hostname === 'api.github.com' || url.hostname === 'raw.githubusercontent.com') return;

  if (e.request.method !== 'GET') return;

  // 同源壳文件：cache-first，后台更新
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(e.request).then(hit => {
        const net = fetch(e.request).then(res => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(SHELL).then(c => c.put(e.request, copy));
          }
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
  }
});

// 推送（iOS 16.4+ 加到主屏后可用；需要一个推送服务端，见 README）
self.addEventListener('push', e => {
  let d = { title: '到期回忆', body: '有题目今天到期了' };
  try { d = Object.assign(d, e.data.json()); } catch (_) {}
  e.waitUntil(self.registration.showNotification(d.title, {
    body: d.body,
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag: 'due',
    data: { url: './?v=due' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) if ('focus' in c) return c.focus();
      return self.clients.openWindow(target);
    })
  );
});
