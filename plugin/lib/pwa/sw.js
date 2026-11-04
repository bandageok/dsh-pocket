/* DSH Pocket — service worker
 *
 * 只缓存外壳（index.html / app.js / style.css / manifest），策略 network-first 回退 cache。
 * 任何 api/ 或 stream 请求一律不拦、不缓存：状态必须实时，缓存一帧旧快照比白屏更坏。
 * 在 http:// 的局域网地址下浏览器拒绝注册 SW，注册失败由上层的 .catch 静默吞掉。
 */

const CACHE = 'dshpocket-shell-v1';
const SHELL = ['./', './index.html', './app.js', './style.css', './manifest.webmanifest'];

/** 业务接口（鉴权、快照、SSE、配对、健康检查、中继）一律绕过缓存。 */
function bypass(url) {
  const path = url.pathname;
  if (path.includes('/api/')) return true;
  if (path.endsWith('/api/stream')) return true;
  if (path.endsWith('/pair')) return true;
  if (path.endsWith('/health')) return true;
  if (path.startsWith('/relay/')) return true;
  return false;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => {
        /* 单个资源缺失不该让整次安装失败 */
      })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok && response.type === 'basic') {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (error) {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (bypass(url)) return; // 不拦、不缓存实时接口

  event.respondWith(networkFirst(request));
});