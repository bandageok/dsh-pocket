// 对上游 `dsh web`（127.0.0.1:<port>）的客户端：换 cookie、调 RPC。
//
// 为什么不走 ctx 的内部服务：内部服务名随版本改（sessionController 是 typert 的名字，
// 不是 cordis 服务的名字），而 HTTP `/api` 是**对外承诺**的东西 —— dsh 自己的 Web 前端
// 和 ACP 都走它。插件一旦只依赖这个面，dsh 升级打不挂我们。
//
// 已实测（dsh 0.2.0-rc.2）：
//   POST /api/session/list   {"payload":{"args":{"_request":{}}}}
//   POST /api/session/prompt {"payload":{"args":{"request":{requestId,sessionId,mode,content}}}}
//   POST /api/session/cancel {"payload":{"args":{"request":{sessionId}}}}
// 端点用斜杠（`session/list`），参数名就是 descriptor 里的名字（`_request` / `request`）。
import { Agent, request as httpRequest } from 'node:http';

/** 上游超时：手机端等不起 90 秒，本地回环 5 秒足够。 */
const UPSTREAM_TIMEOUT_MS = 5000;

/**
 * @param {{host?: string, port: number, getToken: () => string, log: (msg: string) => void}} options
 */
export function createUpstream(options) {
  const host = options.host ?? '127.0.0.1';
  const port = options.port;
  const authority = `${host}:${port}`;
  const log = options.log ?? (() => {});
  const diag = options.diag ?? null;
  // 连续失败计数：用来在 /health 里如实报告链路状态，也是「自愈」的触发条件
  let failures = 0;
  const agent = new Agent({ keepAlive: true, maxSockets: 4 });

  /** 缓存的会话 cookie 原文（`name=value`），401 时清空重取。 */
  let cookie = '';
  let minting = null;

  function call(method, path, headers, body) {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host, port, method, path, headers, agent, timeout: UPSTREAM_TIMEOUT_MS }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('upstream timeout')));
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  /**
   * 换一次会话 cookie。
   *
   * `dsh web` 的 launch token 每次进程启动都变，所以这里用 getToken() 现取，
   * 不缓存 token，只缓存 cookie；cookie 失效（上游 401）就重取一次。
   */
  async function mint() {
    if (minting) return minting;
    minting = (async () => {
      const token = options.getToken();
      if (!token) throw new Error('launch token unavailable');
      const res = await call('GET', `/?token=${encodeURIComponent(token)}`, { host: authority });
      const raw = res.headers['set-cookie'];
      const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
      const auth = list.find((it) => String(it).startsWith('dsh-auth-'));
      if (!auth) throw new Error(`no session cookie (status ${res.status})`);
      cookie = String(auth).split(';')[0];
      log(`upstream: session cookie minted (${cookie.slice(0, 16)}…)`);
      diag?.note(23, 1, failures);
      return cookie;
    })()
      .catch((err) => {
        cookie = '';
        throw err;
      })
      .finally(() => {
        minting = null;
      });
    return minting;
  }

  async function ensureCookie() {
    if (cookie) return cookie;
    return mint();
  }

  /**
   * 调一个 `/api` RPC。
   * @param {string} method 形如 `session/list`
   * @param {Record<string, unknown>} args descriptor 参数名 → 值
   * @returns {Promise<{ok: true, value: unknown} | {ok: false, error: {code?: string, message?: string}}>}
   */
  async function rpc(method, args) {
    const body = JSON.stringify({
      type: 'client-request',
      rpcId: `pocket-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      method,
      payload: { args },
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = await ensureCookie();
      const res = await call(
        'POST',
        `/api/${method}`,
        {
          host: authority,
          origin: `http://${authority}`,
          cookie: current,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
        body,
      );
      if (res.status === 401) {
        cookie = ''; // token 变了 / cookie 过期，重取一次
        continue;
      }
      if (res.status !== 200) return { ok: false, error: { code: `http-${res.status}`, message: res.body.slice(0, 200) } };
      let parsed;
      try {
        parsed = JSON.parse(res.body);
      } catch {
        return { ok: false, error: { code: 'bad-json', message: res.body.slice(0, 200) } };
      }
      const result = parsed?.result;
      if (result?.ok === true) {
        if (failures > 0) {
          diag?.note(5, 200, failures);
          failures = 0;
        }
        return { ok: true, value: result.value };
      }
      return { ok: false, error: result?.error ?? { code: 'unknown', message: 'empty result' } };
    }
    failures += 1;
    diag?.note(6, 401, failures);
    return { ok: false, error: { code: 'unauthorized', message: 'upstream rejected the session cookie twice' } };
  }

  /** 上游是否活着。401 也算活着 —— 那是栅栏，不是没起。 */
  async function ready() {
    try {
      const res = await call('GET', '/', { host: authority });
      return res.status === 200 || res.status === 401 || res.status === 303;
    } catch {
      return false;
    }
  }

  return {
    rpc,
    ready,
    ensureCookie,
    authority,
    host,
    port,
    mint,
    get cookie() {
      return cookie;
    },
    get failures() {
      return failures;
    },
    /** 自愈入口：丢掉缓存 cookie，下一次调用必然重新铸造。 */
    reset() {
      cookie = '';
    },
  };
}