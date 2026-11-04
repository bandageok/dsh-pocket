// 最小 WebSocket 客户端（RFC6455 子集）：只用 node 内置模块。
//
// 为什么不用全局 `WebSocket`：上游 `/api/remote.mux` 要求带 **cookie** 才能升级，
// 而标准 WebSocket API 不允许自定义请求头。`ws` 包能用，但那会让整个插件
// 从「零依赖」变成「装包才能跑」—— 这条底线不值得为 100 行代码破掉。
//
// 支持：握手（可带任意头）、text 帧、分片重组、ping/pong、close。
// 不支持：扩展协商（permessage-deflate）、二进制消息（我们只过 JSON）。
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { connect } from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
import { createHash } from 'node:crypto';

function maskFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  const mask = randomBytes(4);
  const masked = Buffer.from(data);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

/**
 * @param {{host?: string, port: number, path: string, headers?: Record<string,string>, timeoutMs?: number}} options
 * @returns {Promise<EventEmitter & {send:(text:string)=>void, close:()=>void, readyState:number}>}
 */
export function wsConnect(options) {
  const host = options.host ?? '127.0.0.1';
  const port = options.port;
  const key = randomBytes(16).toString('base64');
  const expected = createHash('sha1').update(key + GUID).digest('base64');

  return new Promise((resolve, reject) => {
    const socket = connect(port, host);
    const emitter = new EventEmitter();
    emitter.readyState = 0;
    let handshaken = false;
    let buffer = Buffer.alloc(0);
    let fragments = [];
    let fragmentOpcode = 0;
    let closed = false;
    const timer = setTimeout(() => {
      if (!handshaken) {
        socket.destroy();
        reject(new Error('ws handshake timeout'));
      }
    }, options.timeoutMs ?? 8000);

    const fail = (err) => {
      clearTimeout(timer);
      if (closed) return;
      closed = true;
      emitter.readyState = 3;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      if (!handshaken) reject(err);
      else emitter.emit('close', err?.message ?? 'socket error');
    };

    socket.on('error', fail);
    socket.on('close', () => {
      clearTimeout(timer);
      if (closed) return;
      closed = true;
      emitter.readyState = 3;
      emitter.emit('close', 'closed');
    });

    socket.on('connect', () => {
      const lines = [
        `GET ${options.path} HTTP/1.1`,
        `Host: ${host}:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
      ];
      for (const [name, value] of Object.entries(options.headers ?? {})) lines.push(`${name}: ${value}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (!handshaken) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buffer.subarray(0, end).toString('latin1');
        buffer = buffer.subarray(end + 4);
        const match = /^HTTP\/1\.1 (\d{3})/.exec(head);
        const status = match ? Number(match[1]) : 0;
        if (status !== 101) return fail(new Error(`ws upgrade rejected (${status})`));
        const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head);
        if (!accept || accept[1] !== expected) return fail(new Error('ws accept mismatch'));
        handshaken = true;
        clearTimeout(timer);
        emitter.readyState = 1;
        resolve(Object.assign(emitter, {
          send(text) {
            if (emitter.readyState !== 1) return false;
            try {
              socket.write(maskFrame(0x1, text));
              return true;
            } catch {
              return false;
            }
          },
          close() {
            if (emitter.readyState === 3) return;
            try {
              socket.write(maskFrame(0x8, Buffer.alloc(0)));
            } catch {
              /* ignore */
            }
            emitter.readyState = 2;
            socket.end();
          },
        }));
      }

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
          emitter.readyState = 3;
          socket.end();
          return;
        }
        if (opcode === 0x9) {
          try {
            socket.write(maskFrame(0xa, payload));
          } catch {
            /* ignore */
          }
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
            if (op === 0x1) emitter.emit('message', whole.toString('utf8'));
          }
          continue;
        }
        if (opcode === 0x1 || opcode === 0x2) {
          if (!fin) {
            fragmentOpcode = opcode;
            fragments = [payload];
            continue;
          }
          if (opcode === 0x1) emitter.emit('message', payload.toString('utf8'));
        }
      }
    });
  });
}