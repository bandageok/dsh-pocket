// 假 dsh web：只实现栅栏里被反代依赖的那几条规则。
//
// 它存在的意义不是「模拟 dsh」，而是把三条不变式钉成可回归的断言：
//   1. 只认 loopback 的 Host，否则 403（真实 dsh 是 401/403，语义相同）
//   2. 没有会话 cookie 且没带 launch token → 401
//   3. cookie 名带 authority 的 hash，换 authority 就换 cookie
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

export const LAUNCH_TOKEN = 'test-launch-token';

/** 真 dsh 解析 cookie 是按键取值，不是看前缀 —— 假 dsh 也得照做。 */
function hasCookie(header, name) {
  return String(header ?? "")
    .split(";")
    .map((it) => it.trim())
    .some((it) => it.startsWith(name + "="));
}

function cookieName(authority) {
  return `dsh-auth-${createHash('sha256').update(authority).digest('base64url').slice(0, 12)}`;
}

/**
 * @param {{sessions?: Array<object>}} [options]
 */
export async function startFakeDsh(options = {}) {
  const state = {
    sessions: options.sessions ?? [
      { sessionId: 'session-aaaa1111bbbb', running: true, agentAvailable: true, updatedAt: 1793805000, cwd: 'C:\\work\\pocket' },
      { sessionId: 'session-cccc2222dddd', running: false, agentAvailable: true, updatedAt: 1793804000, cwd: '/home/dev/other' },
    ],
    /** @type {Array<{method: string, args: unknown}>} */
    calls: [],
  };

  const server = createServer((req, res) => {
    const authority = req.headers.host ?? '';
    if (!/^127\.0\.0\.1:/.test(authority)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('bad host');
      return;
    }
    const url = new URL(req.url ?? '/', `http://${authority}`);

    if (url.pathname === '/' && req.method === 'GET') {
      if (url.searchParams.get('token') === LAUNCH_TOKEN) {
        res.writeHead(303, {
          location: './',
          'set-cookie': `${cookieName(authority)}=signed-blob; Path=/; HttpOnly; SameSite=Strict`,
        });
        res.end();
        return;
      }
      if (hasCookie(req.headers.cookie, cookieName(authority))) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>fake dsh</title></head><body><div id="app">ok</div></body></html>`);
        return;
      }
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('dsh web authentication required');
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      if (!hasCookie(req.headers.cookie, cookieName(authority))) {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('unauthorized');
        return;
      }
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          /* ignore */
        }
        const method = String(body?.method ?? url.pathname.replace('/api/', ''));
        state.calls.push({ method, args: body?.payload?.args });
        const reply = (value) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 'server-response', rpcId: body?.rpcId ?? 'x', result: { ok: true, value } }));
        };
        if (method === 'session/list') return reply({ items: state.sessions });
        if (method === 'session/prompt') return reply({ accepted: true });
        if (method === 'session/cancel') return reply({ accepted: true });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'server-response', rpcId: 'x', result: { ok: false, error: { code: 'unknown-endpoint' } } }));
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}