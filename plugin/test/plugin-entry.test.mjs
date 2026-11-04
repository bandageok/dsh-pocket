// 插件入口（cordis 胶水）的测试。
//
// 单跑 proxy/pocket 都过了，不代表 `apply(ctx, config)` 也对：宿主给的是
// `ctx.webServer.port` + `ctx.connection.authenticatedUrl`，还有 `ctx.on` / `ctx.effect`
// 这两套生命周期。这里用假 ctx 把这些钉住 —— 否则「测试里好的、装进 dsh 里坏的」。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apply, inject, name, readConfig, describeApproval } from '../lib/index.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeCtx(port) {
  const events = [];
  const effects = [];
  return {
    events,
    effects,
    ctx: {
      webServer: { port },
      connection: { authenticatedUrl: (base) => `${base}/?token=entry-test-token` },
      on(event) {
        events.push(event);
        return () => {};
      },
      effect(callback) {
        effects.push(callback);
      },
    },
  };
}

async function freePort() {
  const probe = createServer(() => {});
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test('apply() 起服务、注册事件、dispose 后端口释放', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pocket-entry-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const port = await freePort();
  // 自带一个假上游：不依赖本机是否真的跑着 dsh web（否则这条测试会在别人机器上红）
  const upstream = createServer((req, res) => {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('gate');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;
  const { ctx, events, effects } = fakeCtx(upstreamPort);
  try {
    assert.equal(name, 'dsh-pocket');
    assert.deepEqual(inject, ['connection', 'webServer']);

    apply(ctx, { port, bind: '127.0.0.1' });
    // 监听是异步的，给一点时间
    let health = null;
    for (let i = 0; i < 40 && !health; i += 1) {
      await sleep(50);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/__pocket__/health`);
        health = await res.json();
      } catch {
        /* 还没起来 */
      }
    }
    assert.ok(health, '插件必须真的监听');
    assert.equal(health.ok, true);
    assert.equal(health.upstream.port, upstreamPort);
    assert.equal(health.upstream.ready, true, '上游 401 也算 ready（那是栅栏，不是没起）');

    assert.ok(events.includes('api-session/activity'), '必须订阅会话活动');
    assert.ok(events.includes('approval/request'), '必须挂审批');
    assert.equal(effects.length, 1, '必须注册一个 disposer');

    const cleanup = effects[0]();
    cleanup();
    await sleep(300);
    const probe = createServer(() => {});
    const freed = await new Promise((resolve) => {
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    assert.equal(freed, true, 'dispose 之后端口必须还给系统（否则热重载会撞端口）');
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test('没有 webServer 时安静退出，不抛错', () => {
  const { ctx } = fakeCtx(undefined);
  assert.doesNotThrow(() => apply(ctx, {}));
});

test('配置非法时回落到默认值，不炸', () => {
  const config = readConfig({ port: 99999, approvals: 'whatever', approvalTimeoutMs: 10, relayUrl: 'http://x' });
  assert.equal(config.port, 3081);
  assert.equal(config.approvals, 'observe');
  assert.equal(config.approvalTimeoutMs, 45000);
  assert.equal(config.relayUrl, '', '非 ws(s) 的中继地址直接丢掉');
});

test('审批请求字段名变体都能降级到可用值', () => {
  assert.deepEqual(describeApproval({ sessionId: 'session-1', toolName: 'bash', reason: 'ls' }), {
    sessionId: 'session-1',
    tool: 'bash',
    reason: 'ls',
  });
  assert.deepEqual(describeApproval({ agent: { session: { id: 'session-2' } } }).sessionId, 'session-2');
  const bare = describeApproval({});
  assert.equal(bare.tool, 'ai', '取不到工具名时要给一个可显示的默认值');
  assert.equal(bare.reason, '');
});