#!/usr/bin/env node
// dsh-pocket 中继：桌面拨出到这里，手机连到这里，两边按房间号会合。
//
// 为什么中继不引 ws 库：这个服务要能一行 `node server.mjs` 跑在任何免费平台上
// （Fly/Render/小机器/VPS），装依赖就等于多一个失败点。所以这里自己实现
// RFC6455 的最小子集：握手、text 帧、分片重组、ping/pong、close。
// 不支持扩展（permessage-deflate 等）—— 我们的负载是 JSON，压不压无所谓。
//
// 中继**看得到明文**：它只按 id 配对请求/响应，不理解业务，但内容会经过它。
// 所以默认建议自建，见 README。
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8787);
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const PING_MS = 25000;
const MAX_ROOM_AGE_MS = 30 * 24 * 3600 * 1000;

/** @type {Map<string, {room: string, token: string, secret: string, createdAt: number, host: import('node:net').Socket|null, clients: Set<import('node:net').Socket>}>} */
const rooms = new Map();

function sameSecret(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

function tokenFor(secret, room) {
  return createHash('sha256').update(`${secret}:${room}`).digest('base64url').slice(0, 32);
}

// ── 最小 WebSocket ──────────────────────────────────────────────────────

function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, data]);
}

function send(socket, opcode, payload) {
  if (!socket || socket.destroyed) return;
  try {
    socket.write(encodeFrame(opcode, payload));
  } catch {
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
  }
}

function sendJson(socket, value) {
  send(socket, 0x1, JSON.stringify(value));
}

/** 每连接一个解析状态：分片重组缓冲 + 期望的 opcode。 */
function attachReader(socket, onMessage, onClose) {
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let fragmentOpcode = 0;
  let closed = false;

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let len = buffer[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffer.length < 4) return;
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return;
        len = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (buffer.length < offset + maskLen + len) return;
      const mask = masked ? buffer.subarray(offset, offset + 4) : null;
      const payload = Buffer.from(buffer.subarray(offset + maskLen, offset + maskLen + len));
      if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      buffer = buffer.subarray(offset + maskLen + len);

      if (opcode === 0x8) {
        send(socket, 0x8, Buffer.alloc(0));
        socket.destroy();
        return;
      }
      if (opcode === 0x9) {
        send(socket, 0xa, payload);
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x0) {
        fragments.push(payload);
        if (fin) {
          const whole = Buffer.concat(fragments);
          fragments = [];
          const op = fragmentOpcode;
          fragmentOpcode = 0;
          if (op === 0x1) onMessage(whole.toString('utf8'));
          continue;
        }
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2) {
        if (!fin) {
          fragmentOpcode = opcode;
          fragments = [payload];
          continue;
        }
        if (opcode === 0x1) onMessage(payload.toString('utf8'));
      }
    }
  });

  socket.on('close', () => {
    if (closed) return;
    closed = true;
    onClose();
  });
  socket.on('error', () => {
    if (closed) return;
    closed = true;
    onClose();
  });
}

function upgrade(socket, head) {
  if (head?.length) socket.unshift(head);
}

// ── 房间 ────────────────────────────────────────────────────────────────

function readJson(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 16 * 1024) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
  res.end(text);
}

function sweep() {
  const now = Date.now();
  for (const [room, entry] of rooms) {
    if (!entry.host && entry.clients.size === 0 && now - entry.createdAt > MAX_ROOM_AGE_MS) rooms.delete(room);
  }
}

// ── 服务 ────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/relay/health') {
    return json(res, 200, { ok: true, rooms: rooms.size, hosts: [...rooms.values()].filter((it) => it.host).length });
  }

  if (url.pathname === '/relay/register' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body || typeof body.secret !== 'string' || body.secret.length < 16) return json(res, 400, { error: 'bad-request' });
    const room = String(body.room ?? '').trim() || randomBytes(4).toString('hex');
    if (!/^[A-Za-z0-9_-]{4,32}$/.test(room)) return json(res, 400, { error: 'bad-room' });
    const existing = rooms.get(room);
    if (existing && !sameSecret(existing.secret, body.secret)) return json(res, 403, { error: 'room-taken' });
    if (!existing) rooms.set(room, { room, secret: body.secret, token: tokenFor(body.secret, room), createdAt: Date.now(), host: null, clients: new Set() });
    const entry = rooms.get(room);
    return json(res, 200, { room, roomToken: entry.token });
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('dsh-pocket relay: see /relay/health\n');
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  const room = String(url.searchParams.get('room') ?? '');
  const entry = rooms.get(room);

  if (url.pathname === '/relay/host') {
    const token = String(url.searchParams.get('token') ?? '');
    if (!entry || !sameSecret(token, entry.token)) {
      socket.write('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
    upgrade(socket, head);
    // 同一房间只保留一个 host：新 host 顶掉旧的（插件重启后必然是新的）
    if (entry.host && entry.host !== socket) {
      send(entry.host, 0x8, Buffer.alloc(0));
      entry.host.destroy();
    }
    entry.host = socket;
    for (const client of entry.clients) sendJson(client, { t: 'host', online: true });
    const pinger = setInterval(() => send(socket, 0x9, Buffer.alloc(0)), PING_MS);
    pinger.unref?.();
    attachReader(
      socket,
      (text) => {
        let frame;
        try {
          frame = JSON.parse(text);
        } catch {
          return;
        }
        if (frame?.t === 'res') {
          // 只发给发起这个 id 的客户端；找不到就广播（单手机场景下等于直达）
          let delivered = false;
          for (const client of entry.clients) {
            const ids = client.__pocketIds;
            if (ids?.has(frame.id)) {
              sendJson(client, frame);
              ids.delete(frame.id);
              delivered = true;
              break;
            }
          }
          if (!delivered) for (const client of entry.clients) sendJson(client, frame);
        } else if (frame?.t === 'pong' || frame?.t === 'host') {
          /* 心跳与状态，无需转发 */
        }
      },
      () => {
        clearInterval(pinger);
        if (entry.host === socket) entry.host = null;
        for (const client of entry.clients) sendJson(client, { t: 'host', online: false });
      },
    );
    return;
  }

  if (url.pathname === '/relay/client') {
    if (!entry) {
      socket.write('HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
    upgrade(socket, head);
    entry.clients.add(socket);
    socket.__pocketIds = new Set();
    sendJson(socket, { t: 'host', online: Boolean(entry.host) });
    const pinger = setInterval(() => send(socket, 0x9, Buffer.alloc(0)), PING_MS);
    pinger.unref?.();
    attachReader(
      socket,
      (text) => {
        let frame;
        try {
          frame = JSON.parse(text);
        } catch {
          return;
        }
        if (frame?.t === 'req') {
          if (!entry.host) {
            sendJson(socket, { t: 'res', id: frame.id, status: 503, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'host-offline' }) });
            return;
          }
          socket.__pocketIds.add(frame.id);
          sendJson(entry.host, frame);
        }
      },
      () => {
        clearInterval(pinger);
        entry.clients.delete(socket);
      },
    );
    return;
  }

  socket.write('HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n');
  socket.destroy();
});

setInterval(sweep, 3600 * 1000).unref?.();

server.listen(PORT, () => {
  const actual = server.address().port;
  console.log(`dsh-pocket relay listening on :${actual}`);
  console.log(`  桌面端在 dsh-pocket 配置里填：relayUrl = ws://<这台机器>:${actual}  relayRoom = <自选房间号>`);
});