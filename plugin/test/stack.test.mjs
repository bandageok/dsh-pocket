// 集成测试：真起一个 http.Server，前面挂我们自己的 stack，后面挂假 dsh。
//
// 打的是**不变式**，不是实现细节：
//   · Host/Origin 改写后上游才认；
//   · 闸门先于 token 注入；
//   · `?pocket=` 换 cookie 后不再需要令牌；
//   · PWA 首屏被注入 polyfill；
//   · prompt/cancel 的参数形状与 dsh 的 descriptor 一致（`request` / `_request`）。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createStack } from '../lib/stack.mjs';
import { createStore } from '../lib/store.mjs';
import { LAUNCH_TOKEN, startFakeDsh } from './helpers/fake-dsh.mjs';

const PWA_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), 'lib', 'pwa');

/** 起一整套：假 dsh + store + stack，监听随机端口。 */
async function boot(options = {}) {
  const fake = await startFakeDsh(options.fake);
  const dir = mkdtempSync(join(tmpdir(), 'pocket-stack-'));
  const store = createStore({ file: join(dir, 'pocket.json') });
  const stack = createStack({
    dshPort: fake.port,
    getToken: () => LAUNCH_TOKEN,
    store,
    config: { approvals: options.approvals ?? 'observe', approvalTimeoutMs: 2000 },
    pwaDir: PWA_DIR,
  });
  await new Promise((resolve) => stack.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${stack.server.address().port}`;
  return {
    fake,
    store,
    pocket: stack.pocket,
    base,
    async close() {
      await stack.pocket.shutdown();
      await new Promise((resolve) => stack.server.close(resolve));
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const json = async (res) => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { __raw: text };
  }
};

test('health 公开可读，且能看到上游活着', async () => {
  const env = await boot();
  try {
    const res = await fetch(`${env.base}/__pocket__/health`);
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.ok, true);
    assert.equal(body.paired, false);
    assert.equal(body.upstream.ready, true);
    assert.equal(body.upstream.port, env.fake.port);
  } finally {
    await env.close();
  }
});

test('未配对时，转发路径一律 401（闸门在注入 token 之前）', async () => {
  const env = await boot();
  try {
    const res = await fetch(`${env.base}/`, { headers: { accept: 'text/html' } });
    assert.equal(res.status, 401);
    assert.match(await res.text(), /unauthorized/);
  } finally {
    await env.close();
  }
});

test('配对码错 401，对了发令牌；错码会计次', async () => {
  const env = await boot();
  try {
    const bad = await fetch(`${env.base}/__pocket__/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '000000', name: 'test' }),
    });
    assert.equal(bad.status, 401);
    assert.equal((await json(bad)).attemptsLeft, 4);

    const good = await fetch(`${env.base}/__pocket__/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: env.store.code, name: 'test-phone' }),
    });
    assert.equal(good.status, 200);
    const body = await json(good);
    assert.ok(body.token && body.deviceId);
  } finally {
    await env.close();
  }
});

test('state 用 Bearer 拿到归一化快照；换 catsu 401', async () => {
  const env = await boot();
  try {
    const token = env.store.pair(env.store.code, 'phone').token;
    const res = await fetch(`${env.base}/__pocket__/api/state`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.sessions.length, 2);
    const running = body.sessions.find((it) => it.running);
    assert.ok(running);
    assert.equal(running.short, 'aaaa1111');
    assert.equal(running.cwd, 'C:\\work\\pocket');
    assert.deepEqual(running.approvals, []);
    assert.equal(body.capabilities.approvalAnswer, false);

    const anon = await fetch(`${env.base}/__pocket__/api/state`);
    assert.equal(anon.status, 401);
  } finally {
    await env.close();
  }
});

test('prompt 的参数形状符合 dsh descriptor（args.request.content）', async () => {
  const env = await boot();
  try {
    const token = env.store.pair(env.store.code, 'phone').token;
    const res = await fetch(`${env.base}/__pocket__/api/prompt`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-aaaa1111bbbb', text: '跑一下测试', mode: 'steer' }),
    });
    assert.equal(res.status, 200);
    const promptBody = await json(res);
    assert.equal(promptBody.accepted, true);
    // 手机靠这个 id 把本地回声替换成正式消息（双端同步的去重键）
    assert.equal(typeof promptBody.requestId, 'string');

    const call = env.fake.state.calls.find((it) => it.method === 'session/prompt');
    assert.ok(call, '上游必须收到 session/prompt');
    const request = call.args.request;
    assert.equal(request.sessionId, 'session-aaaa1111bbbb');
    assert.equal(request.mode, 'steer');
    assert.equal(request.content[0].type, 'text');
    assert.equal(request.content[0].text, '跑一下测试');
    assert.ok(request.requestId.length > 8, 'requestId 必须由客户端生成');
  } finally {
    await env.close();
  }
});

test('cancel 走 session/cancel 且只带 sessionId', async () => {
  const env = await boot();
  try {
    const token = env.store.pair(env.store.code, 'phone').token;
    const res = await fetch(`${env.base}/__pocket__/api/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-cccc2222dddd' }),
    });
    assert.equal(res.status, 200);
    const call = env.fake.state.calls.find((it) => it.method === 'session/cancel');
    assert.deepEqual(call.args, { request: { sessionId: 'session-cccc2222dddd' } });
  } finally {
    await env.close();
  }
});

test('用 ?pocket= 打开完整界面：注入 polyfill，并把令牌换成 cookie', async () => {
  const env = await boot();
  try {
    const token = env.store.pair(env.store.code, 'phone').token;
    // 手动跟随跳转：模拟浏览器（Node 的 fetch 会自己跟 303，这里要看每一跳的 header）
    const first = await fetch(`${env.base}/?pocket=${encodeURIComponent(token)}`, { headers: { accept: 'text/html' }, redirect: 'manual' });
    assert.equal(first.status, 303);
    const cookies = first.headers.getSetCookie();
    assert.ok(cookies.some((c) => c.startsWith('pocket-auth=')), '必须下发 pocket-auth');
    assert.ok(cookies.some((c) => c.startsWith('dsh-auth-')), '必须同时保留上游的会话 cookie');

    const pocketCookie = cookies.find((c) => c.startsWith('pocket-auth=')).split(';')[0];
    const second = await fetch(`${env.base}/`, { headers: { accept: 'text/html', cookie: pocketCookie }, redirect: 'manual' });
    assert.equal(second.status, 303, '第二跳仍应拿到上游的 303（并带 dsh-auth）');
    const nextCookies = second.headers.getSetCookie();
    const picked = nextCookies.find((c) => c.startsWith('dsh-auth-'));
    assert.ok(picked, '第二跳必须带回上游的 dsh-auth cookie');
    const dshCookie = picked.split(';')[0];

    const third = await fetch(`${env.base}/`, {
      headers: { accept: 'text/html', cookie: `${pocketCookie}; ${dshCookie}` },
    });
    assert.equal(third.status, 200);
    const html = await third.text();
    assert.match(html, /data-dsh-pocket/, '首屏必须被注入 polyfill');
    assert.match(html, /randomUUID/, 'polyfill 内容要真的在');
  } finally {
    await env.close();
  }
});

test('SSE 先给一份全量快照', async () => {
  const env = await boot();
  try {
    const token = env.store.pair(env.store.code, 'phone').token;
    const controller = new AbortController();
    const res = await fetch(`${env.base}/__pocket__/api/stream`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    assert.match(String(res.headers.get('content-type')), /text\/event-stream/);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const deadline = Date.now() + 5000;
    while (!text.includes('event: state') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    controller.abort();
    assert.match(text, /event: state/);
    assert.match(text, /"sessions"/);
  } finally {
    await env.close();
  }
});

test('未鉴权的 WebSocket 升级被 401 拦下', async () => {
  const env = await boot();
  try {
    const port = env.base.split(':')[2];
    const response = await new Promise((resolve, reject) => {
      const socket = connect(Number(port), '127.0.0.1', () => {
        socket.write(
          'GET /api/remote.mux HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
        );
      });
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk.toString('utf8');
        if (data.includes('\r\n\r\n')) {
          socket.destroy();
          resolve(data);
        }
      });
      socket.on('error', reject);
      setTimeout(() => {
        socket.destroy();
        resolve(data);
      }, 3000);
    });
    assert.match(response, /^HTTP\/1\.1 401/);
  } finally {
    await env.close();
  }
});

test('审批：observe 模式下只展示；approvalAnswer=false 时 HTTP 拒绝答复', async () => {
  const env = await boot();
  try {
    const token = env.store.pair(env.store.code, 'phone').token;
    const entry = env.pocket.noteApproval({ sessionId: 'session-aaaa1111bbbb', tool: 'bash', reason: 'run tests', ttl: 500 });
    assert.ok(entry.id);

    const state = await json(await fetch(`${env.base}/__pocket__/api/state?force=1`, { headers: { authorization: `Bearer ${token}` } }));
    assert.equal(state.approvals.length, 1, '手机必须看到这条待审批');
    assert.equal(state.approvals[0].tool, 'bash');
    assert.equal(state.sessions.find((it) => it.running).approvals.length, 1, '会话上也要能一眼看到');

    const res = await fetch(`${env.base}/__pocket__/api/approval`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ approvalId: entry.id, decision: 'allow' }),
    });
    assert.equal(res.status, 403);
    assert.equal((await json(res)).error, 'approval-answer-disabled');
  } finally {
    await env.close();
  }
});