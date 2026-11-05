// v0.2 的三个新能力：回环穿透、断点续传、诊断环。
//
// 每一条都对着一个「参考实现里值得学的判断」写断言，而不是照着它的代码写：
//   · 回环：白名单之外的端口必须被拒（默认关闭），白名单之内必须原样转发；
//   · 续传：offset 不对要回真实 offset（这是断点续传的全部意义），finish 不重放；
//   · 诊断：只有数字码，且环大小固定。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { createDiag, CODES } from '../lib/diag.mjs';
import { parseLoopPath } from '../lib/loop.mjs';
import { injectPolyfill } from '../lib/proxy.mjs';
import { boot, json } from './helpers/boot.mjs';

// ── 诊断环 ────────────────────────────────────────────────────────────

test('诊断环：定长、覆盖旧记录、只存数字', () => {
  const diag = createDiag({ size: 3 });
  for (let i = 0; i < 5; i += 1) diag.note(4, i, 0);
  const snap = diag.snapshot();
  assert.equal(snap.entries.length, 3, '环不能无限长');
  assert.equal(snap.dropped, 2);
  assert.deepEqual(snap.entries.map((it) => it.a), [2, 3, 4]);
  for (const entry of snap.entries) {
    for (const value of Object.values(entry)) assert.equal(typeof value, 'number', '只允许数字，不能漏内容');
  }
  assert.ok(snap.codes[4], '码表要跟着一起给出去，否则导出没法查');
});

test('诊断环：字符串参数会被折成 0，不会把内容写进诊断包', () => {
  const diag = createDiag({ size: 4 });
  diag.note(7, 'C:/secret/path', { a: 1 });
  const [entry] = diag.snapshot().entries;
  assert.equal(entry.a, 0);
  assert.equal(entry.b, 0);
  assert.equal(diag.text().includes('secret'), false);
});

test('诊断码表是最新的一份（改码要先改这里）', () => {
  assert.equal(CODES[17], 'loop forward');
  assert.equal(CODES[14], 'upload chunk');
});

// ── 回环穿透 ──────────────────────────────────────────────────────────

test('回环路径解析：端口、子路径、查询串都要对', () => {
  assert.deepEqual(parseLoopPath('/__pocket__/loop/9230/a/b', '?x=1'), { port: 9230, path: '/a/b?x=1' });
  assert.deepEqual(parseLoopPath('/__pocket__/loop/5173', ''), { port: 5173, path: '/' });
  assert.equal(parseLoopPath('/__pocket__/loop/0/x', ''), null);
  assert.equal(parseLoopPath('/__pocket__/api/state', ''), null);
});

test('回环：默认关闭，白名单之外的端口 403', async () => {
  const env = await boot();
  try {
    const token = env.token();
    const res = await fetch(`${env.base}/__pocket__/loop/18888/x`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 403);
    assert.match(await res.text(), /not allowed/);
    assert.equal(env.stack.loop.status().enabled, false, '装上不该自动开门');
  } finally {
    await env.close();
  }
});

test('回环：白名单内的端口真的转发到 127.0.0.1:<port>', async () => {
  // 一个「本地服务」：把收到的 Host/Origin 原样回显，方便断言改写对不对
  const target = createServer((req, res) => {
    const body = JSON.stringify({ host: req.headers.host, origin: req.headers.origin ?? null, url: req.url, cookie: req.headers.cookie ?? null });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  const targetPort = target.address().port;

  const env = await boot({ config: { loopPorts: [targetPort] } });
  try {
    const token = env.token();
    const res = await fetch(`${env.base}/__pocket__/loop/${targetPort}/hello?q=1`, {
      headers: { authorization: `Bearer ${token}`, origin: 'http://192.168.1.9:3081' },
    });
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.url, '/hello?q=1');
    assert.equal(body.host, `127.0.0.1:${targetPort}`, 'Host 必须改写成目标 authority');
    assert.equal(body.origin, `http://127.0.0.1:${targetPort}`, 'Origin 也要跟着改写');
    assert.equal(body.cookie, null, '手机的门禁 cookie 不能漏给别的本地服务');

    // 同一台机器上的另一个端口没在白名单里 → 依然 403
    const other = await fetch(`${env.base}/__pocket__/loop/1/x`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(other.status, 403);
  } finally {
    await env.close();
    await new Promise((resolve) => target.close(resolve));
  }
});

test('回环：注入片只在配了端口时出现，且不覆盖页面自己的 fetch', () => {
  const inject = injectPolyfill;
  const html = '<html><head><title>t</title></head><body></body></html>';
  const none = inject(html, []);
  assert.match(none, /data-dsh-pocket/);
  assert.equal(none.includes('__dshPocketLoops='), false, '没白名单就不要改页面行为');

  const withPorts = inject(html, [9230]);
  assert.match(withPorts, /__dshPocketLoops=\[9230\]/);
  assert.match(withPorts, /XMLHttpRequest\.prototype\.open/);
  assert.ok(withPorts.indexOf('randomUUID') < withPorts.indexOf('__dshPocketLoops='), 'polyfill 必须在最前');

  // 二次注入会被标记挡住
  assert.equal(inject(withPorts, [9230]), withPorts);
});

// ── 断点续传 ──────────────────────────────────────────────────────────

test('续传：init 幂等，offset 错回真实 offset，finish 校验 sha256', async () => {
  const env = await boot();
  try {
    const token = env.token();
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    const init = await fetch(`${env.base}/__pocket__/upload/init`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: '../危险 名字.txt', size: 11, requestId: 'req-1' }),
    });
    assert.equal(init.status, 200);
    const created = await json(init);
    assert.equal(created.offset, 0);
    assert.equal(created.resumed, false);
    assert.equal(created.name.includes('/'), false, '文件名不能带路径');
    assert.equal(created.name.startsWith('.'), false, '不能写出隐藏文件');

    // 同一个 requestId 再来一次 = 同一条记录（回执丢了也不会重复建）
    const again = await json(await fetch(`${env.base}/__pocket__/upload/init`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: 'x.txt', size: 11, requestId: 'req-1' }),
    }));
    assert.equal(again.id, created.id);
    assert.equal(again.resumed, true);

    const put = (offset, body) =>
      fetch(`${env.base}/__pocket__/upload/${created.id}?offset=${offset}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
        body,
      });

    // offset 不对 → 409 + 真实 offset（断点续传的关键语义）
    const wrong = await put(5, 'hello');
    assert.equal(wrong.status, 409);
    assert.deepEqual(await json(wrong), { error: 'offset', offset: 0 });

    assert.equal((await json(await put(0, 'hello '))).offset, 6);
    // 模拟断线后重连：客户端再问一次偏移，然后接着传
    const status = await json(await fetch(`${env.base}/__pocket__/upload/${created.id}`, { headers: { authorization: `Bearer ${token}` } }));
    assert.equal(status.offset, 6);
    assert.equal((await json(await put(6, 'world'))).offset, 11);

    // 早收尾 → 409 incomplete
    const early = await boot();
    try {
      const t2 = early.token();
      const c2 = await json(await fetch(`${early.base}/__pocket__/upload/init`, {
        method: 'POST',
        headers: { authorization: `Bearer ${t2}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'a.bin', size: 4, requestId: 'req-2' }),
      }));
      const done = await fetch(`${early.base}/__pocket__/upload/${c2.id}/finish`, { method: 'POST', headers: { authorization: `Bearer ${t2}` } });
      assert.equal(done.status, 409);
      assert.equal((await json(done)).error, 'incomplete');
    } finally {
      await early.close();
    }

    const finish = await fetch(`${env.base}/__pocket__/upload/${created.id}/finish`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    assert.equal(finish.status, 200);
    const result = await json(finish);
    assert.equal(result.ok, true);
    assert.equal(result.size, 11);
    assert.equal(readFileSync(result.path, 'utf8'), 'hello world');
    assert.equal(result.sha256.length, 64);

    // finish 不重放：再调一次拿到同一结果，而不是再落一份
    const twice = await json(await fetch(`${env.base}/__pocket__/upload/${created.id}/finish`, { method: 'POST', headers: { authorization: `Bearer ${token}` } }));
    assert.equal(twice.path, result.path);
    assert.equal(twice.sha256, result.sha256);
    assert.ok(result.path.startsWith(join(env.home, 'pocket-uploads')), '必须落在插件自己的目录里');
  } finally {
    await env.close();
  }
});

test('续传：超过单文件上限直接 413，不占磁盘', async () => {
  const env = await boot();
  try {
    const token = env.token();
    const res = await fetch(`${env.base}/__pocket__/upload/init`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'huge.iso', size: 600 * 1024 * 1024, requestId: 'req-big' }),
    });
    assert.equal(res.status, 413);
    assert.equal((await json(res)).error, 'too-large');
  } finally {
    await env.close();
  }
});

test('续传与诊断都要令牌', async () => {
  const env = await boot();
  try {
    assert.equal((await fetch(`${env.base}/__pocket__/upload/init`, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(`${env.base}/__pocket__/api/diag`)).status, 401);
  } finally {
    await env.close();
  }
});

// ── /health 的新字段 ──────────────────────────────────────────────────

test('health 带地址清单、回环状态、上传状态，手机可据此「自动找电脑」', async () => {
  const env = await boot({ config: { loopPorts: [9230] } });
  try {
    const body = await json(await fetch(`${env.base}/__pocket__/health`));
    assert.ok(Array.isArray(body.addresses) && body.addresses.length > 0);
    assert.deepEqual(body.loop, { enabled: true, any: false, ports: [9230] });
    assert.equal(typeof body.upload.maxFile, 'number');
    assert.equal(body.diag, 0);
    assert.equal(body.version, '0.2.1');
  } finally {
    await env.close();
  }
});

test('诊断端点可导出，且内容不含路径与令牌', async () => {
  const env = await boot();
  try {
    // 走一次真实配对（而不是直接 store.pair），才会落下 1 pair ok 这条事件
    const paired = await json(await fetch(`${env.base}/__pocket__/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: env.store.code, name: 'diag-phone' }),
    }));
    const token = paired.token;
    const snap = await json(await fetch(`${env.base}/__pocket__/api/diag`, { headers: { authorization: `Bearer ${token}` } }));
    assert.ok(Array.isArray(snap.entries));
    assert.ok(snap.entries.length > 0, '至少应该有配对与上游调用的事件');

    const text = await (await fetch(`${env.base}/__pocket__/api/diag?download=1`, { headers: { authorization: `Bearer ${token}` } })).text();
    assert.match(text, /^# dsh-pocket diagnostics/);
    assert.equal(text.includes(token), false, '令牌绝不能进诊断包');
    assert.equal(text.includes(env.home), false, '路径也不能进');
  } finally {
    await env.close();
  }
});
// ── 内容同步的 HTTP 面 ────────────────────────────────────────────────

test('messages 端点：要令牌；上游没有流时返回空数组而不是报错', async () => {
  const env = await boot();
  try {
    assert.equal((await fetch(`${env.base}/__pocket__/api/session/session-1/messages`)).status, 401);

    const token = env.token();
    const res = await fetch(`${env.base}/__pocket__/api/session/session-1/messages?wait=50`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.sessionId, 'session-1');
    assert.deepEqual(body.messages, []);
    assert.equal(body.cursor, 0);
    assert.equal(body.streaming, '');
  } finally {
    await env.close();
  }
});

test('state 里带 capabilities.sync，手机据此决定是否显示转录视图', async () => {
  const env = await boot();
  try {
    const token = env.token();
    const body = await json(await fetch(`${env.base}/__pocket__/api/state`, { headers: { authorization: `Bearer ${token}` } }));
    assert.equal(body.capabilities.sync, true);
    const health = await json(await fetch(`${env.base}/__pocket__/health`));
    assert.equal(health.sync.connected, false, '没人订阅时不该占着上游 WS');
    assert.deepEqual(health.sync.sessions, []);
  } finally {
    await env.close();
  }
});

test('SSE 带 ?session= 时先回一份 reset，之后才谈增量', async () => {
  const env = await boot();
  try {
    const token = env.token();
    const controller = new AbortController();
    const res = await fetch(`${env.base}/__pocket__/api/stream?session=session-abc`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const deadline = Date.now() + 6000;
    while (!text.includes('event: reset') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    controller.abort();
    assert.match(text, /event: reset/, '手机进会话要靠这条 reset 拿到首屏内容');
    assert.match(text, /"sessionId":"session-abc"/);
    assert.match(text, /"messages":\[\]/);
  } finally {
    await env.close();
  }
});

test('配了中继但拨不出去时，health 要如实报「未连接」而不是 null', async () => {
  // 指向一个没人监听的端口：register 会失败，但插件必须给出「配了、没连上」这个状态
  const env = await boot({ config: { relayUrl: 'ws://127.0.0.1:9', relayRoom: 'room-dead' } });
  try {
    env.stack.startRelay(env.port);
    const health = await json(await fetch(`${env.base}/__pocket__/health`));
    assert.deepEqual(health.transport.relay, { room: 'room-dead', connected: false });
  } finally {
    env.stack.stopRelay();
    await env.close();
  }
});
