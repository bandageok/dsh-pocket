// 把四块拼成一个能 listen 的 http.Server。
//
// 单独抽出来是为了让「插件入口」与「测试/单独运行」用**同一条**装配路径：
// 装配逻辑一旦分叉，就会出现「测试里好的、装进 dsh 里坏的」这类最难查的问题。
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDiag } from './diag.mjs';
import { createFollow } from './follow.mjs';
import { createLoop } from './loop.mjs';
import { createPocket } from './pocket.mjs';
import { createProxy, lanAddresses } from './proxy.mjs';
import { startRelay } from './relay.mjs';
import { createUploads } from './upload.mjs';
import { createUpstream } from './upstream.mjs';

export const MOUNT = '/__pocket__';

/**
 * @param {{
 *   dshPort: number,
 *   getToken: () => string,
 *   store: ReturnType<import('./store.mjs').createStore>,
 *   config: {port?: number, approvals?: string, approvalTimeoutMs?: number, loopPorts?: number[], loopAny?: boolean},
 *   pwaDir: string,
 *   home: string,
 *   log?: (msg: string) => void,
 * }} options
 */
export function createStack(options) {
  const log = options.log ?? (() => {});
  // home 缺省时落到临时目录：调用方漏传不能让插件往 cwd 里写文件（更别写出一个叫 "undefined" 的目录）
  const home = options.home ?? join(tmpdir(), 'dsh-pocket');
  const diag = createDiag();
  const uploads = createUploads({ dir: join(home, 'pocket-uploads'), diag, log });
  let selfPort = Number(options.config?.port) || 3081;
  const loop = createLoop({ config: options.config ?? {}, diag, log, selfPort: () => selfPort });

  const upstream = createUpstream({ port: options.dshPort, getToken: options.getToken, log, diag });
  // 双端同步：一个上游 WS 多路复用（每个会话一条逻辑流），断线自动重挂
  const follow = createFollow({ upstream, diag, log });

  // 中继：拨出到中继服务器（人不在同一网段时用）。
  // **状态以运行中的拨号为准**，不要读配置文件 —— 配置写了但没起来时，health 必须说实话。
  // 声明必须早于 createPocket：pocket 的 health 会调 relayStatus（否则就是 TDZ）。
  let relay = null;
  const relayStatus = () =>
    relay
      ? { room: String(options.config?.relayRoom ?? ''), connected: relay.connected }
      : options.config?.relayUrl
        ? { room: String(options.config?.relayRoom ?? ''), connected: false }
        : null;

  const pocket = createPocket({
    store: options.store,
    upstream,
    pwaDir: options.pwaDir,
    config: options.config ?? {},
    log,
    diag,
    loop,
    uploads,
    follow,
    relayStatus,
    addresses: () => lanAddresses().map((it) => it.address),
  });

  const proxy = createProxy({ upstream, getToken: options.getToken, pocket, log, getLoopPorts: () => loop.status().ports });

  const server = createServer((req, res) => {
    try {
      if (pocket.handle(req, res)) return;
      proxy.handle(req, res);
    } catch (err) {
      log(`stack: request failed — ${err?.message ?? err}`);
      try {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('dsh-pocket: internal error\n');
      } catch {
        /* 连接已断 */
      }
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const path = String(req.url ?? '/');
    if (path.startsWith(`${MOUNT}/loop/`)) {
      // 页面在手机侧认证过（同源 cookie），这里交给回环模块再判一次端口白名单
      const url = new URL(path, `http://${req.headers.host ?? '127.0.0.1'}`);
      const auth = pocket.authorize(req, url);
      if (!auth.ok) {
        socket.write('HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n');
        socket.destroy();
        return;
      }
      if (!loop.handleUpgrade(req, socket, head)) socket.destroy();
      return;
    }
    if (path.startsWith(MOUNT)) {
      socket.write('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    proxy.handleUpgrade(req, socket, head);
  });

  return {
    server,
    upstream,
    follow,
    pocket,
    proxy,
    loop,
    uploads,
    diag,
    setPort(port) {
      selfPort = Number(port) || selfPort;
    },
    /** 监听成功后再拨中继：拨号要把「本机端口」告诉中继侧转发器。 */
    startRelay(port) {
      const url = String(options.config?.relayUrl ?? '');
      const room = String(options.config?.relayRoom ?? '');
      if (!url || !room || relay) return relay;
      relay = startRelay({ relayUrl: url, room, secret: options.store.secret, localPort: Number(port) || selfPort, log });
      return relay;
    },
    stopRelay() {
      try {
        relay?.stop();
      } catch {
        /* ignore */
      }
      relay = null;
    },
    get relay() {
      return relay;
    },
  };
}

/** 端口被占就往后试 —— 默认 3081 很容易撞上别的工具。 */
export function listenWithRetry(server, port, bind, attempts, log = () => {}) {
  let attempt = 0;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const onError = (err) => {
        if (err?.code === 'EADDRINUSE' && attempt < attempts - 1) {
          attempt += 1;
          server.removeListener('error', onError);
          tryOnce();
          return;
        }
        reject(err);
      };
      server.once('error', onError);
      server.listen(port + attempt, bind, () => {
        server.removeListener('error', onError);
        const actual = port + attempt;
        log(`listening on ${bind}:${actual}`);
        resolve(actual);
      });
    };
    tryOnce();
  });
}