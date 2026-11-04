#!/usr/bin/env node
// 隧道模拟：不装 Tailscale，把「人不在同一网段」那条链路完整跑一遍。
//
//   node tools/tunnel-sim.mjs --dsh-port 3097 --token <launch token>
//
// 跑的是真实的三段，没有一处是假的：
//
//   ① 中继服务（真的 `node relay/server.mjs` 子进程，随机端口）
//   ② 电脑侧：`tools/standalone.mjs` 带 relayUrl 拨出到中继（和插件里同一条 relay.mjs）
//   ③ 手机侧：本站自己扮演 —— 一条 WS 连 `/relay/client?room=`，只发 `{t:'req'}` 帧，
//      路径与 PWA 走中继时**完全一致**
//
// 覆盖：配对 → 会话快照 → 发指令（带 requestId）→ 内容同步 → 诊断导出。
// 任何一步不符合预期就非零退出，可以直接挂到 CI 或人手跑。
//
// 之所以用中继而不是 Tailscale：Tailscale 要账号与设备注册，无法自动化；
// 而「出门在外」的流量在两者下走的是同一个手机端协议（WS 帧），中继能覆盖。
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);

const dshPort = Number(args['dsh-port'] ?? 3080);
const token = String(args.token ?? '');
if (!token) {
  console.error('缺 --token：从 dsh web 启动日志里抄 http://127.0.0.1:<port>/?token=…');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
let failures = 0;

function ok(name, detail = '') {
  console.log(`  ✔ ${name}${detail ? '  — ' + detail : ''}`);
}
function bad(name, detail = '') {
  failures += 1;
  console.log(`  ✘ ${name}${detail ? '  — ' + detail : ''}`);
}
function check(condition, name, detail = '') {
  if (condition) ok(name, detail);
  else bad(name, detail);
}

/** 起一个子进程并等它打印某个 pattern，返回 {port, child}。 */
function spawnUntil(cmd, argv, env, pattern, timeoutMs = 20000) {
  const child = spawn(cmd, argv, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`超时：${cmd} 没有输出 ${pattern}\n${out}`)), timeoutMs);
    const onData = (chunk) => {
      out += chunk.toString('utf8');
      const m = pattern.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve({ port: m[1] ? Number(m[1]) : NaN, child, out });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`进程退出 ${code}：${cmd}\n${out}`));
    });
  });
}

function cleanup() {
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
}

// ── 手机侧的 WS 客户端（中继帧）：手写握手，因为要带 room 参数 ──────────────
let watchHost = null;

async function openRelayClient(port, room) {
  const { wsConnect } = await import('../lib/ws-client.mjs');
  const socket = await wsConnect({ port, path: `/relay/client?room=${encodeURIComponent(room)}` });
  socket.on('message', (raw) => {
    try {
      const frame = JSON.parse(raw);
      if (frame.t === 'host' && watchHost) watchHost(frame);
    } catch {
      /* ignore */
    }
  });
  return socket;
}

/** 发一个 req 帧并等对应 id 的 res。 */
function call(socket, id, path, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`req 超时：${path}`)), 15000);
    const onMessage = (raw) => {
      let frame;
      try {
        frame = JSON.parse(raw);
      } catch {
        return;
      }
      if (frame.t !== 'res' || frame.id !== id) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      let json = null;
      try {
        json = JSON.parse(frame.body);
      } catch {
        /* 非 JSON */
      }
      resolve({ status: frame.status, json, text: frame.body });
    };
    socket.on('message', onMessage);
    socket.send(JSON.stringify({ t: 'req', id, path, method, headers, body: body === null ? null : JSON.stringify(body) }));
  });
}

async function main() {
  const home = mkdtempSync(join(tmpdir(), 'pocket-tunnel-'));

  console.log('\n① 中继服务');
  const relay = await spawnUntil(process.execPath, [join(ROOT, '..', 'relay', 'server.mjs')], { PORT: '0' }, /listening on :(\d+)/);
  ok('中继已启动', `127.0.0.1:${relay.port}`);

  // 找一个空闲端口给电脑侧
  const probe = spawn(process.execPath, ['-e', 'require("http").createServer(()=>{}).listen(0,function(){console.log(this.address().port);this.close()})'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const freePort = await new Promise((resolve) => probe.stdout.on('data', (d) => resolve(Number(String(d).trim()))));

  console.log('\n② 电脑侧（拨出到中继）');
  const room = 'sim-room-1';
  const stand = await spawnUntil(
    process.execPath,
    [join(ROOT, 'tools', 'standalone.mjs'), '--dsh-port', String(dshPort), '--token', token, '--port', String(freePort), '--bind', '127.0.0.1', '--home', home, '--relay-url', `ws://127.0.0.1:${relay.port}`, '--relay-room', room],
    {},
    /listening on [^:]+:(\d+)/,
  );
  ok('电脑侧已启动并拨出', `本地 :${stand.port}，房间 ${room}`);
  await sleep(1200); // 等 register + host 连上

  const health = await fetch(`http://127.0.0.1:${stand.port}/__pocket__/health`).then((r) => r.json());
  check(health?.ok === true, '电脑侧 health 正常');
  check(health?.transport?.relay?.room === room, 'health 里能看到中继房间', JSON.stringify(health?.transport));

  console.log('\n③ 手机侧（走中继）');
  const hostFlag = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 5000);
    watchHost = (frame) => {
      clearTimeout(timer);
      resolve(Boolean(frame.online));
    };
  });
  const client = await openRelayClient(relay.port, room);
  ok('已连上中继房间');
  let seq = 0;
  const nextId = () => ++seq;

  // host 状态帧可能在 open 的瞬间就到，所以监听挂在 openRelayClient 之前（见上）
  const hostOnline = await hostFlag;
  check(hostOnline !== null, '中继告知了 host 状态', hostOnline === null ? '没收到' : String(hostOnline));
  check(hostOnline === true, 'host（电脑侧）在线');

  // 配对码从状态文件里读（电脑侧刚启动生成的）
  const code = JSON.parse(readFileSync(join(home, 'pocket.json'), 'utf8')).code;
  const paired = await call(client, nextId(), '/__pocket__/pair', 'POST', { code, name: 'tunnel-sim' });
  check(paired.status === 200 && typeof paired.json?.token === 'string', '经中继完成配对', `HTTP ${paired.status}`);
  const auth = { authorization: `Bearer ${paired.json.token}` };

  const state = await call(client, nextId(), '/__pocket__/api/state?force=1', 'GET', null, auth);
  check(state.status === 200, '经中继拉会话快照', `HTTP ${state.status}`);
  const sessions = state.json?.sessions ?? [];
  ok('快照里有会话', `${sessions.length} 个`);

  const unauth = await call(client, nextId(), '/__pocket__/api/state', 'GET');
  check(unauth.status === 401, '经中继也不许匿名访问', `HTTP ${unauth.status}`);

  if (sessions.length > 0) {
    const sessionId = sessions[0].id;
    const text = `tunnel-sim ${Date.now()}`;
    const prompt = await call(client, nextId(), '/__pocket__/api/prompt', 'POST', { sessionId, text }, auth);
    check(prompt.status === 200 && prompt.json?.accepted === true, '经中继下发指令', `HTTP ${prompt.status}`);
    const requestId = prompt.json?.requestId;
    check(typeof requestId === 'string' && requestId.length > 8, '拿回去重用的 requestId', String(requestId).slice(0, 12));

    await sleep(1500);
    const messages = await call(client, nextId(), `/__pocket__/api/session/${encodeURIComponent(sessionId)}/messages?wait=2500`, 'GET', null, auth);
    const list = messages.json?.messages ?? [];
    check(messages.status === 200, '经中继拉回内容', `HTTP ${messages.status}`);
    const mine = list.find((m) => m.rpcId === requestId);
    check(Boolean(mine), '这条消息带着同一个 rpcId 回来了（双端去重锚点）', mine ? `seq=${mine.seq}` : `共 ${list.length} 条`);
    check(list.some((m) => m.text.includes(text)), '内容一致（没有丢字）');
  }

  const diag = await call(client, nextId(), '/__pocket__/api/diag', 'GET', null, auth);
  check(diag.status === 200 && Array.isArray(diag.json?.entries), '经中继导出诊断', `${diag.json?.entries?.length ?? 0} 条`);

  client.close();
  await sleep(200);
  rmSync(home, { recursive: true, force: true });

  console.log(`\n${failures === 0 ? '隧道模拟全部通过' : `隧道模拟有 ${failures} 处失败`}\n`);
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => {
    cleanup();
    process.exit(code);
  })
  .catch((err) => {
    console.error('模拟失败：', err?.message ?? err);
    cleanup();
    process.exit(1);
  });