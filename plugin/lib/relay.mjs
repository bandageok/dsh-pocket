// 中继拨号（桌面 → 中继）：人不在同一网段时的唯一通路。
//
// 为什么要拨出（而不是等手机连进来）：家里/公司电脑没有公网 IP、也不该开端口。
// 拨出只需要能上网，中继替它做「会合点」。
//
// 帧协议见 docs/PROTOCOL.md §4。这里只做三件事：注册房间、保持连接、把收到的
// 请求转成本机 HTTP 打给自己的代理端口（复用整套鉴权与改写，不复制逻辑）。
import { request as httpRequest } from 'node:http';

const PING_MS = 25000;

function httpBase(wsUrl) {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '';
  url.search = '';
  return url.toString().replace(/\/$/, '');
}

function post(url, body) {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = httpRequest(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: res.statusCode, json: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, json: null, raw });
        }
      });
    });
    req.on('error', reject);
    req.end(text);
  });
}

/**
 * @param {{
 *   relayUrl: string, room: string, secret: string, localPort: number,
 *   log: (msg: string) => void,
 * }} options
 */
export function startRelay(options) {
  const log = options.log ?? (() => {});
  let socket = null;
  let roomToken = '';
  let closed = false;
  let attempt = 0;
  let pingTimer = null;
  let retryTimer = null;

  async function register() {
    const res = await post(`${httpBase(options.relayUrl)}/relay/register`, { room: options.room, secret: options.secret });
    if (res.status !== 200 || !res.json?.roomToken) throw new Error(`register failed (${res.status})`);
    roomToken = res.json.roomToken;
    log(`relay: room ${options.room} registered`);
  }

  function dispatch(frame) {
    return new Promise((resolve) => {
      const headers = { host: `127.0.0.1:${options.localPort}` };
      for (const [k, v] of Object.entries(frame.headers ?? {})) {
        if (typeof v === 'string' && !['host', 'connection', 'content-length'].includes(k.toLowerCase())) headers[k.toLowerCase()] = v;
      }
      const body = typeof frame.body === 'string' ? frame.body : '';
      if (body) headers['content-length'] = Buffer.byteLength(body);
      const req = httpRequest(
        { host: '127.0.0.1', port: options.localPort, method: frame.method ?? 'GET', path: frame.path ?? '/', headers, timeout: 20000 },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            resolve({
              t: 'res',
              id: frame.id,
              status: res.statusCode ?? 502,
              headers: { 'content-type': String(res.headers['content-type'] ?? 'application/json') },
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('local timeout')));
      req.on('error', (err) => resolve({ t: 'res', id: frame.id, status: 502, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'relay-dispatch', message: String(err?.message ?? err) }) }));
      if (body) req.write(body);
      req.end();
    });
  }

  async function connect() {
    if (closed) return;
    try {
      if (!roomToken) await register();
      const url = `${options.relayUrl}/relay/host?room=${encodeURIComponent(options.room)}&token=${encodeURIComponent(roomToken)}`;
      socket = new WebSocket(url);
      socket.addEventListener('open', () => {
        attempt = 0;
        log(`relay: connected (${options.relayUrl})`);
        clearInterval(pingTimer);
        pingTimer = setInterval(() => {
          try {
            socket?.send(JSON.stringify({ t: 'ping' }));
          } catch {
            /* ignore */
          }
        }, PING_MS);
      });
      socket.addEventListener('message', (event) => {
        let frame;
        try {
          frame = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (frame?.t === 'req') {
          void dispatch(frame).then((res) => {
            try {
              socket?.send(JSON.stringify(res));
            } catch {
              /* socket 没了，下一轮重连 */
            }
          });
        } else if (frame?.t === 'close' || frame?.t === 'register') {
          if (frame.t === 'register') roomToken = '';
        }
      });
      socket.addEventListener('close', () => {
        clearInterval(pingTimer);
        if (closed) return;
        attempt += 1;
        const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
        log(`relay: disconnected, retry in ${delay}ms`);
        retryTimer = setTimeout(() => void connect(), delay);
      });
      socket.addEventListener('error', () => {
        /* close 处理器统一重连 */
      });
    } catch (err) {
      attempt += 1;
      const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
      log(`relay: ${err?.message ?? err}; retry in ${delay}ms`);
      retryTimer = setTimeout(() => void connect(), delay);
    }
  }

  void connect();

  return {
    stop() {
      closed = true;
      clearInterval(pingTimer);
      clearTimeout(retryTimer);
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
    },
    get connected() {
      return socket?.readyState === 1;
    },
  };
}