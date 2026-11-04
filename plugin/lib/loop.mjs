// 回环穿透：让「手机打开的那个页面」能访问电脑上的 127.0.0.1:<port> 服务。
//
// ## 为什么需要
//
// DSH 的界面里有几个本地服务是**写死 loopback** 的（例如调试/文件资源通道
// `ws://127.0.0.1:9230`）。在手机上，`127.0.0.1` 指的是手机自己，于是这些面板
// 在手机上必然打不开 —— 而且页面代码不能改。
//
// ## 参考实现的做法与我们的差别
//
// DSHgo（just-a-FA-for-name/DSHgo）的做法是**原生 App + VPN**：Android 端在手机
// 的 `127.0.0.1:<port>` 起一个 TCP 监听，把每条连接顺着隧道打回电脑，页面一行都不用改。
// 那个办法很干净，但前提是有个能监听端口的原生 App。
//
// 我们是 PWA，手机上没有进程可以监听端口。所以换一条路：
//
//   页面里的 http://127.0.0.1:<port>/… → /__pocket__/loop/<port>/…（页面侧 shim 改写）
//   → 插件转发到电脑的 127.0.0.1:<port>
//
// 好处：不需要原生壳、不需要 VPN，iOS 也能用。
// 代价：只覆盖 fetch / XHR / WebSocket 三条路径，不覆盖 `<img src>` 这类
// 浏览器内建加载（那些得靠页面侧 DOM 观察，v0.3 再说）。
//
// ## 安全
//
// 这是把「本机任意端口」暴露给手机的能力，所以：
//   · **默认关闭**（`loopPorts: []`）—— 装上不会多开一扇门；
//   · 只允许显式列出的端口，且目标永远是 127.0.0.1（不是任意主机）；
//   · 不允许指向插件自己的端口（会造成自我递归）；
//   · 每次命中记一条 `17 loop forward`，被拒记 `18 loop reject`。
import { request as httpRequest } from 'node:http';

const PREFIX = '/__pocket__/loop/';

/** 解析 `/__pocket__/loop/9230/a/b?c=1` → {port: 9230, path: '/a/b?c=1'} */
export function parseLoopPath(pathname, search = '') {
  if (!pathname.startsWith(PREFIX)) return null;
  const rest = pathname.slice(PREFIX.length);
  const at = rest.indexOf('/');
  const port = Number(at < 0 ? rest : rest.slice(0, at));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const tail = at < 0 ? '/' : rest.slice(at);
  return { port, path: `${tail}${search}` };
}

/**
 * @param {{config: {loopPorts?: number[], loopAny?: boolean}, selfPort: () => number, diag: ReturnType<import('./diag.mjs').createDiag>, log?: (msg: string) => void}} options
 */
export function createLoop(options) {
  const log = options.log ?? (() => {});
  const diag = options.diag;

  const ports = new Set(
    (Array.isArray(options.config?.loopPorts) ? options.config.loopPorts : [])
      .map((it) => Number(it))
      .filter((it) => Number.isInteger(it) && it > 0 && it < 65536),
  );
  const any = options.config?.loopAny === true;

  function allowed(port) {
    if (port === options.selfPort()) return false; // 自己转发给自己 = 递归
    if (any) return true;
    return ports.has(port);
  }

  function status() {
    return { enabled: any || ports.size > 0, any, ports: [...ports] };
  }

  /** 转发一次（HTTP）。返回 void，响应自己收尾。 */
  function forward(req, res, target) {
    const headers = { ...req.headers };
    delete headers.cookie; // 手机的门禁 cookie 不该漏给别的本地服务
    delete headers.authorization;
    headers.host = `127.0.0.1:${target.port}`;
    if (headers.origin !== undefined) headers.origin = `http://127.0.0.1:${target.port}`;
    headers['x-dsh-pocket-loop'] = String(target.port);

    const up = httpRequest({ host: '127.0.0.1', port: target.port, method: req.method, path: target.path, headers }, (upRes) => {
      const out = { ...upRes.headers };
      res.writeHead(upRes.statusCode ?? 502, out);
      upRes.pipe(res);
    });
    up.setTimeout(20000, () => up.destroy(new Error('loop target timeout')));
    up.on('error', (err) => {
      diag?.note(18, target.port, 1);
      log(`loop: ${target.port} failed — ${err?.message ?? err}`);
      if (!res.headersSent) {
        const body = `dsh-pocket: loop target 127.0.0.1:${target.port} unreachable\n`;
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(body) });
        res.end(body);
      } else {
        res.destroy();
      }
    });
    req.pipe(up);
    diag?.note(17, target.port, 1);
  }

  return {
    status,
    allowed,
    /**
     * @returns {boolean} 是否已处理
     */
    handle(req, res, url) {
      const target = parseLoopPath(url.pathname, url.search);
      if (!target) return false;
      if (!allowed(target.port)) {
        diag?.note(18, target.port, 2);
        const body = 'dsh-pocket: loopback port not allowed\n';
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(body) });
        res.end(body);
        return true;
      }
      forward(req, res, target);
      return true;
    },

    /** 回环目标的 WebSocket（如 9230 的调试通道）也要能穿透。 */
    handleUpgrade(req, socket, head) {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      const target = parseLoopPath(url.pathname, url.search);
      if (!target) return false;
      if (!allowed(target.port)) {
        diag?.note(18, target.port, 3);
        socket.write('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n');
        socket.destroy();
        return true;
      }
      const headers = { ...req.headers };
      delete headers.cookie;
      headers.host = `127.0.0.1:${target.port}`;
      if (headers.origin !== undefined) headers.origin = `http://127.0.0.1:${target.port}`;
      const up = httpRequest({ host: '127.0.0.1', port: target.port, method: req.method, path: target.path, headers });
      up.on('upgrade', (upRes, upSocket, upHead) => {
        const lines = ['HTTP/1.1 101 Switching Protocols'];
        for (let i = 0; i < upRes.rawHeaders.length; i += 2) lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`);
        socket.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (upHead?.length) socket.write(upHead);
        if (head?.length) upSocket.write(head);
        upSocket.pipe(socket);
        socket.pipe(upSocket);
        upSocket.on('error', () => socket.destroy());
        socket.on('error', () => upSocket.destroy());
        diag?.note(17, target.port, 2);
      });
      up.on('response', (upRes) => {
        socket.write(`HTTP/1.1 ${upRes.statusCode ?? 502} ${upRes.statusMessage ?? ''}\r\ncontent-length: 0\r\n\r\n`);
        socket.destroy();
      });
      up.on('error', () => socket.destroy());
      up.end();
      return true;
    },
  };
}

/** 页面侧 shim 里用的端口列表注入（只暴露端口号，不暴露别的）。 */
export function loopBootstrap(loopStatus) {
  return `<script data-dsh-pocket-loop="1">window.__dshPocketLoops=${JSON.stringify(loopStatus.ports)};</script>`;
}