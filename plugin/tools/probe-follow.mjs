#!/usr/bin/env node
// 真机探针：在一个真实的 dsh 上验证「双端同步」这条链路。
//
//   node tools/probe-follow.mjs --port 3080 --token <launch token>
//
// 做四件事并把结果打出来：
//   1. 用 launch token 换会话 cookie（这是所有 /api 调用的前提）
//   2. 建一个会话、发一条带标记的消息（模拟手机输入）
//   3. 打开 `session/follow`，打印前几帧的原始形状（协议就是从这里读出来的）
//   4. 之后任何时刻，服务端把这条消息带着同一个 rpcId 吐回来 —— 那是去重的锚点
//
// 为什么单独一个工具而不是测试：它需要真 dsh + 真 token，属于「人工验一次」的东西；
// 自动化测试用 test/follow.test.mjs 里的假传输打状态机。
import { wsConnect } from '../lib/ws-client.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);
const PORT = Number(args.port ?? 3080);
const TOKEN = String(args.token ?? '');
const LIMIT = Number(args.frames ?? 6);
if (!TOKEN) {
  console.error('缺 --token：在 dsh web 的启动日志里找 http://127.0.0.1:<port>/?token=…');
  process.exit(2);
}

const base = `http://127.0.0.1:${PORT}`;
const res = await fetch(`${base}/?token=${encodeURIComponent(TOKEN)}`, { redirect: 'manual' });
const cookie = res.headers.getSetCookie().find((it) => it.startsWith('dsh-auth-'));
if (!cookie) {
  console.error(`换 cookie 失败（status ${res.status}）—— token 过期了，重启 dsh web 后重新取`);
  process.exit(1);
}
const dshCookie = cookie.split(';')[0];
console.log('① cookie ok', dshCookie.slice(0, 18));

const rpc = async (method, request) => {
  const response = await fetch(`${base}/api/${method}`, {
    method: 'POST',
    headers: { cookie: dshCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `probe-${Date.now()}`, method, payload: { args: { request } } }),
  });
  return response.json();
};

const created = await rpc('session/create', { cwd: process.cwd().split('\\').join('/') });
const sessionId = created?.result?.value?.sessionId;
if (!sessionId) {
  console.error('② 建会话失败：', JSON.stringify(created).slice(0, 300));
  process.exit(1);
}
console.log('② session', sessionId);

const marker = `probe ${Date.now()}`;
await rpc('session/prompt', { requestId: `probe-req-${Date.now()}`, sessionId, mode: 'queue', content: [{ type: 'text', text: marker }] });
console.log('③ prompt 已发（含标记）:', marker);

const ws = await wsConnect({ port: PORT, path: '/api/remote.mux', headers: { cookie: dshCookie, origin: `http://127.0.0.1:${PORT}` } });
ws.send(
  JSON.stringify({
    type: 'open',
    streamId: 'probe1',
    endpoint: 'session/follow',
    payload: { args: { request: { address: { kind: 'session', sessionId }, assistantStream: true, maxMessages: 30 } } },
  }),
);
let n = 0;
ws.on('message', (raw) => {
  n += 1;
  console.log(`④ frame ${n} (${raw.length}B):`, raw.slice(0, 700));
  if (n >= LIMIT) process.exit(0);
});
ws.on('close', (why) => {
  console.log('ws 关闭:', why);
  process.exit(0);
});
setTimeout(() => {
  console.log(`超时，收到 ${n} 帧`);
  process.exit(0);
}, 12000);
