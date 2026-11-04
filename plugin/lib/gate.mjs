// 访问闸门：谁能用这个端口。
//
// 三条硬规则，来自踩过的坑：
//
// 1. **闸门必须先于 launch token 注入。** 注入 token 等于「已登录」，
//    先注入再拦，闸门就成了摆设。
// 2. **App 与浏览器要的是同一个令牌。** 这里不做 UA 分流——分流只影响界面，
//    一旦有人以为 UA 决定权限，就会有人伪造 UA。
// 3. **静态外壳（配对页）必须免鉴权。** 否则手机第一次打开就 401，
//    永远看不到配对界面。
import { timingSafeEqual } from 'node:crypto';

/** 不需要令牌就能拿到的路径：配对页与它的四个资源 + 健康检查 + 配对接口。 */
const PUBLIC = new Set([
  '/__pocket__',
  '/__pocket__/',
  '/__pocket__/index.html',
  '/__pocket__/health',
  '/__pocket__/pair',
  '/__pocket__/app.js',
  '/__pocket__/style.css',
  '/__pocket__/sw.js',
  '/__pocket__/manifest.webmanifest',
]);

const COOKIE_NAME = 'pocket-auth';

/** 从 `a=1; pocket-auth=xxx; b=2` 取一个 cookie。 */
export function readCookie(header, name) {
  const text = String(header ?? '');
  for (const part of text.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return '';
}

function bearer(header) {
  const text = String(header ?? '');
  const m = /^Bearer\s+(.+)$/i.exec(text.trim());
  return m ? m[1].trim() : '';
}

/**
 * @param {{store: ReturnType<import('./store.mjs').createStore>, log?: (msg: string) => void}} options
 */
export function createGate(options) {
  const { store } = options;

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {URL} url
   * @returns {{ok: boolean, device?: object, cookie?: string}}
   */
  function authorize(req, url) {
    const path = url.pathname;

    // ① 首次带 `?pocket=<token>` 打开完整界面：换成 cookie 再继续，
    //    避免令牌一直留在地址栏与浏览器历史里。
    const fromQuery = url.searchParams.get('pocket');
    if (fromQuery) {
      const device = store.verify(fromQuery);
      if (device) return { ok: true, device, cookie: `${COOKIE_NAME}=${fromQuery}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax` };
      return { ok: false };
    }

    const token = bearer(req.headers.authorization) || readCookie(req.headers.cookie, COOKIE_NAME);
    const device = token ? store.verify(token) : null;
    if (device) return { ok: true, device };

    if (PUBLIC.has(path)) return { ok: true };
    return { ok: false };
  }

  return { authorize, COOKIE_NAME };
}

/** 常量时间比较，供对外暴露的字符串比对用（store 内部另有实现）。 */
export function sameSecret(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}