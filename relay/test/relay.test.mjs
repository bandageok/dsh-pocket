// 中继的端到端测试：真起一个子进程，真开三条 WebSocket。
//
// 验的是「不在同一网段时能不能用」的最小闭环：
//   注册房间 → host 拨入 → client 拨入 → client 发 req → host 收 → host 回 res → client 收。
// 顺带验三条拒绝路径：房间不存在、房间令牌不对、host 离线时快速失败。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SERVER = join(dirname(dirname(fileURLToPath(import.meta.url))), 'server.mjs');

async function startRelay() {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`relay did not start: ${out}`)), 8000);
    child.stdout.on('data', (chunk) => {
      out += chunk.toString('utf8');
      const m = /listening on :(\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.stderr.on('data', (chunk) => {
      out += chunk.toString('utf8');
    });
    child.on('exit', (code) => reject(new Error(`relay exited ${code}: ${out}`)));
  });
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    ws: `ws://127.0.0.1:${port}`,
    stop: () =>
      new Promise((resolve) => {
        child.removeAllListeners('exit');
        child.on('exit', () => resolve());
        child.kill();
        setTimeout(resolve, 2000); // 进程没退也要把测试放过去
      }),
  };
}

/** 打开一条 WS；失败（含握手被拒）就 reject，不会挂住。 */
function openWs(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      reject(new Error(`ws timeout: ${url}`));
    }, timeoutMs);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`ws rejected: ${url}`));
    });
  });
}

function nextMessage(socket, predicate = () => true, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener('message', onMessage);
      reject(new Error('timeout waiting for message'));
    }, timeoutMs);
    function onMessage(event) {
      let frame;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!predicate(frame)) return;
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      resolve(frame);
    }
    socket.addEventListener('message', onMessage);
  });
}

async function register(relay, room, secret) {
  const res = await fetch(`${relay.base}/relay/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ room, secret }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

/** 收集本测试打开的 socket，收尾统一关掉，避免 test runner 等句柄。 */
function tracker() {
  const sockets = [];
  return {
    async open(url) {
      const socket = await openWs(url);
      sockets.push(socket);
      return socket;
    },
    close() {
      for (const socket of sockets) {
        try {
          socket.close();
        } catch {
          /* ignore */
        }
      }
      sockets.length = 0;
    },
  };
}

test('注册 → host → client → 请求/响应 往返', async () => {
  const relay = await startRelay();
  const socks = tracker();
  try {
    const reg = await register(relay, 'room-main', 'x'.repeat(40));
    assert.equal(reg.status, 200);
    assert.ok(reg.body.roomToken);

    // 令牌错 → 握手被拒
    await assert.rejects(() => openWs(`${relay.ws}/relay/host?room=room-main&token=wrong`));

    const hostSocket = await socks.open(`${relay.ws}/relay/host?room=room-main&token=${reg.body.roomToken}`);
    const clientSocket = await socks.open(`${relay.ws}/relay/client?room=room-main`);
    const online = await nextMessage(clientSocket, (f) => f.t === 'host');
    assert.equal(online.online, true);

    clientSocket.send(JSON.stringify({ t: 'req', id: 1, path: '/__pocket__/api/state', method: 'GET', headers: { authorization: 'Bearer t' }, body: null }));
    const received = await nextMessage(hostSocket, (f) => f.t === 'req');
    assert.equal(received.id, 1);
    assert.equal(received.path, '/__pocket__/api/state');
    assert.equal(received.headers.authorization, 'Bearer t');

    hostSocket.send(JSON.stringify({ t: 'res', id: 1, status: 200, headers: { 'content-type': 'application/json' }, body: '{"now":1}' }));
    const reply = await nextMessage(clientSocket, (f) => f.t === 'res');
    assert.equal(reply.id, 1);
    assert.equal(reply.status, 200);
    assert.equal(reply.body, '{"now":1}');
  } finally {
    socks.close();
    await relay.stop();
  }
});

test('房间不存在时 client 连不上；同房间换密钥被拒', async () => {
  const relay = await startRelay();
  try {
    await assert.rejects(() => openWs(`${relay.ws}/relay/client?room=nosuchroom`));

    const first = await register(relay, 'room-two', 'y'.repeat(40));
    assert.equal(first.status, 200);

    const clash = await register(relay, 'room-two', 'z'.repeat(40));
    assert.equal(clash.status, 403);
    assert.equal(clash.body.error, 'room-taken');
  } finally {
    await relay.stop();
  }
});

test('host 离线时请求立刻拿到 503，而不是挂死', async () => {
  const relay = await startRelay();
  const socks = tracker();
  try {
    assert.equal((await register(relay, 'room-off', 'w'.repeat(40))).status, 200);
    const client = await socks.open(`${relay.ws}/relay/client?room=room-off`);
    const status = await nextMessage(client, (f) => f.t === 'host');
    assert.equal(status.online, false);

    client.send(JSON.stringify({ t: 'req', id: 7, path: '/x', method: 'GET', headers: {}, body: null }));
    const reply = await nextMessage(client, (f) => f.t === 'res');
    assert.equal(reply.status, 503);
    assert.equal(JSON.parse(reply.body).error, 'host-offline');
  } finally {
    socks.close();
    await relay.stop();
  }
});

test('房间号格式不合法时直接 400', async () => {
  const relay = await startRelay();
  try {
    const res = await register(relay, 'a', 'q'.repeat(40));
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'bad-room');
  } finally {
    await relay.stop();
  }
});