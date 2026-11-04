// 双端同步层（follow.mjs）的单测：用**假传输**打状态机，不连真上游。
//
// 为什么不在这一层连真 dsh：上游握手要 cookie、要真实会话日志，测试会变慢且脆。
// 帧形状是用真机探针（tools/probe-follow.mjs）确认过的，这里把这些帧原样喂进来，
// 断言「手机最终看到什么」。真正的端到端由 tools/ 下的探针脚本负责。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createFollow, extractText, normalizeEvent } from '../lib/follow.mjs';

/** 假传输：拿到一个能手动 push 帧的 socket。 */
function fakeTransport() {
  const sockets = [];
  const connect = () => {
    const socket = new EventEmitter();
    socket.readyState = 1;
    socket.sent = [];
    socket.send = (text) => {
      socket.sent.push(JSON.parse(text));
      return true;
    };
    socket.close = () => {
      socket.readyState = 3;
      socket.emit('close', 'closed');
    };
    sockets.push(socket);
    return Promise.resolve(socket);
  };
  return { connect, sockets };
}

const upstream = {
  port: 3080,
  host: '127.0.0.1',
  authority: '127.0.0.1:3080',
  ensureCookie: async () => 'dsh-auth-test=blob',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function snapshotFrame(streamId, { cursor = 5, events = [] } = {}) {
  return JSON.stringify({
    type: 'item',
    streamId,
    value: {
      type: 'snapshot',
      header: { version: 4, id: 'session-1', createdAt: 1, cwd: 'C:/w', isSeeded: false },
      cursor,
      records: events.map((event) => ({ type: 'event', event })),
    },
  });
}

const userEvent = (text, seq, rpcId) => ({
  type: 'user/message',
  seq,
  time: 1793807000000 + seq,
  data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId } },
});

const assistantEvent = (text, seq) => ({
  type: 'assistant/message',
  seq,
  time: 1793807000000 + seq,
  data: { role: 'assistant', content: [{ type: 'text', text }] },
});

test('文本提取能吃下多种 content 形状', () => {
  assert.equal(extractText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.equal(extractText({ content: [{ text: 'x' }] }), 'x');
  assert.equal(extractText('plain'), 'plain');
  assert.equal(extractText(null), '');
});

test('归一化：系统提示与运行时上下文不是「聊天内容」，必须丢掉', () => {
  assert.equal(
    normalizeEvent({ type: 'system/message', seq: 7, data: { message: { role: 'system', content: [{ type: 'text', text: 'x'.repeat(5000) }] } } }),
    null,
    'system/message 有 6 KB，推给手机纯浪费',
  );
  assert.equal(
    normalizeEvent({ type: 'user/message', seq: 9, data: { role: 'user', content: [{ type: 'text', text: 'ctx' }], source: { kind: 'runtime-context' } } }),
    null,
    '运行时上下文不是人打的字',
  );
  assert.equal(normalizeEvent({ type: 'step/start', seq: 6, data: {} }), null);
});

test('归一化：用户消息带上 rpcId（双端去重的唯一依据）', () => {
  const message = normalizeEvent(userEvent('跑一下测试', 8, 'rpc-1'));
  assert.equal(message.role, 'user');
  assert.equal(message.text, '跑一下测试');
  assert.equal(message.rpcId, 'rpc-1');
  assert.equal(message.seq, 8);
});

test('归一化：助手消息与工具事件分开标记', () => {
  assert.equal(normalizeEvent(assistantEvent('结果如上', 12)).role, 'assistant');
  const tool = normalizeEvent({ type: 'tool/call', seq: 13, data: { toolName: 'bash', input: { cmd: 'ls' } } });
  assert.equal(tool.kind, 'tool');
  assert.equal(tool.text, '[bash]');
});

test('订阅后收到快照 → 得到归一化消息列表', async () => {
  const { connect, sockets } = fakeTransport();
  const follow = createFollow({ upstream, connect, log: () => {} });
  try {
    const first = follow.subscribe('session-1');
    await sleep(20);
    const socket = sockets[0];
    assert.equal(socket.sent.length, 1);
    assert.equal(socket.sent[0].type, 'open');
    assert.equal(socket.sent[0].endpoint, 'session/follow');
    assert.deepEqual(socket.sent[0].payload.args.request.address, { kind: 'session', sessionId: 'session-1' });
    assert.equal(socket.sent[0].payload.args.request.assistantStream, true, '不带它就没有逐字流');

    const streamId = socket.sent[0].streamId;
    socket.emit('message', snapshotFrame(streamId, { cursor: 9, events: [userEvent('第一条', 8, 'rpc-a'), assistantEvent('回答', 9)] }));
    await sleep(10);

    assert.equal(first.messages.length, 2);
    assert.deepEqual(first.messages.map((it) => it.role), ['user', 'assistant']);
    assert.equal(first.cursor, 9);
  } finally {
    follow.stop();
  }
});

test('增量事件与逐字流：delta 是累计文本，结束时清空', async () => {
  const { connect, sockets } = fakeTransport();
  const follow = createFollow({ upstream, connect, log: () => {} });
  const seen = [];
  follow.on((kind, payload) => seen.push({ kind, ...payload }));
  try {
    follow.subscribe('session-1');
    await sleep(20);
    const socket = sockets[0];
    const streamId = socket.sent[0].streamId;

    socket.emit('message', snapshotFrame(streamId));
    socket.emit('message', JSON.stringify({ type: 'item', streamId, value: { type: 'event', event: assistantEvent('最终回答', 20) } }));
    socket.emit(
      'message',
      JSON.stringify({ type: 'item', streamId, value: { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text', text: '你' } } } }),
    );
    socket.emit(
      'message',
      JSON.stringify({ type: 'item', streamId, value: { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text', text: '好' } } } }),
    );
    await sleep(10);

    const deltas = seen.filter((it) => it.kind === 'delta');
    assert.deepEqual(deltas.map((it) => it.text), ['你', '你好'], 'delta 必须是累计文本，手机端直接替换气泡内容');
    assert.equal(seen.filter((it) => it.kind === 'message').length, 1);

    socket.emit('message', JSON.stringify({ type: 'item', streamId, value: { type: 'assistant-stream', frame: { type: 'end' } } }));
    await sleep(10);
    assert.equal(seen.at(-1).text, '', '结束要发空串，手机才知道收起临时气泡');
  } finally {
    follow.stop();
  }
});

test('上游报错不炸，转成 error 事件；断线后自动重连并重挂会话', async () => {
  const { connect, sockets } = fakeTransport();
  const follow = createFollow({ upstream, connect, log: () => {} });
  const seen = [];
  follow.on((kind, payload) => seen.push({ kind, ...payload }));
  try {
    follow.subscribe('session-1');
    await sleep(20);
    const first = sockets[0];
    first.emit('message', JSON.stringify({ type: 'error', streamId: 'f1', error: { code: 'gateway/x', message: 'boom' } }));
    await sleep(10);
    assert.ok(seen.some((it) => it.kind === 'error' && it.code === 'gateway/x'));

    first.close();
    await sleep(1200); // 首次退避 2s 之前先等一小会儿
    follow.subscribe('session-1'); // 触发重连（幂等）
    await sleep(2500);
    assert.ok(sockets.length >= 2, '断开后必须重连');
    const revived = sockets.at(-1);
    assert.equal(revived.sent[0].endpoint, 'session/follow', '重连后要把还在关注的会话重新挂上');
  } finally {
    follow.stop();
  }
});

test('取消订阅会向上游发 cancel', async () => {
  const { connect, sockets } = fakeTransport();
  const follow = createFollow({ upstream, connect, log: () => {} });
  try {
    follow.subscribe('session-1');
    await sleep(20);
    const socket = sockets[0];
    const streamId = socket.sent[0].streamId;
    follow.unsubscribe('session-1');
    assert.deepEqual(socket.sent.at(-1), { type: 'cancel', streamId });
    assert.deepEqual(follow.status().sessions, []);
  } finally {
    follow.stop();
  }
});

test('read() 在没有上游流时也能安全返回（不抛、不挂）', async () => {
  const { connect } = fakeTransport();
  const follow = createFollow({ upstream, connect, log: () => {} });
  try {
    const body = await follow.read('session-none', { waitMs: 50 });
    assert.deepEqual(body.messages, []);
    assert.equal(body.cursor, 0);
    assert.equal(body.streaming, '');
  } finally {
    follow.stop();
  }
});
test('运行时注入的「用户消息」不算对话内容', () => {
  assert.equal(
    normalizeEvent({ type: 'user/message', seq: 30, data: { role: 'user', content: [{ type: 'text', text: '<system-reminder>\nA skill is …' }] } }),
    null,
    '技能清单之类的注入提醒会把真正的对话顶走',
  );
  // 正常文本里出现标签但不在开头 → 保留
  assert.ok(normalizeEvent(userEvent('看到 <system-reminder> 这个标签了吗', 31, 'rpc-x')));
});
