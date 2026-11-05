// LAN 反代：把只监听 127.0.0.1 的 `dsh web` 变成「手机能打开的东西」。
//
// 三道栅栏，一件都不能少（依据：dsh 0.2.0-rc.2 的 api-request-trust 源码）：
//
//   1. `dsh web` 只绑 127.0.0.1，别的设备连不上 —— 所以这里绑 0.0.0.0。
//   2. `/api` 有 Host/Origin 栅栏，只认 loopback 或 `--trusted-host` 白名单，
//      且 Origin 必须与 Host 同源 —— 所以入站请求的 Host/Origin 一律改写成
//      固定的 `127.0.0.1:<dshPort>`，栅栏永远看到 loopback。
//   3. 会话 cookie 名是 `dsh-auth-<authority 的 hash>`，校验时比对签发时的
//      authority —— 所以改写必须**每次都一致**，不能有时带端口有时不带。
//
// 另外两件小事，不做就「能打开但用不了」：
//   · 首屏要带一次 launch token（每次 dsh web 启动都变），否则拿不到 cookie；
//   · `crypto.randomUUID` 在 http://<IP> 这种非安全上下文里没有，
//     而 DSH 连接层拿它生成 RPC id —— 必须在页面脚本之前补上。
import { request as httpRequest } from 'node:http';
import { networkInterfaces } from 'node:os';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

export const INJECT_MARK = 'data-dsh-pocket';

/**
 * 页面级 polyfill。只在缺失时补，绝不覆盖浏览器原生实现。
 * 保持 ES5 语法：目标是最旧的那批 WebView，而不是最新那个 V8。
 */
export const POLYFILL = `<script ${INJECT_MARK}="1">(function(){
try{if(self.crypto&&!self.crypto.randomUUID){self.crypto.randomUUID=function(){
var b=new Uint8Array(16);self.crypto.getRandomValues(b);
b[6]=b[6]&15|64;b[8]=b[8]&63|128;
var h="";for(var i=0;i<16;i++){var x=b[i].toString(16);h+=x.length<2?"0"+x:x;
if(i===3||i===5||i===7||i===9)h+="-";}return h;};}}catch(e){}
try{if(self.AbortSignal&&!self.AbortSignal.any){self.AbortSignal.any=function(sigs){
var c=new AbortController(),list=Array.prototype.slice.call(sigs||[]),done=false;
function stop(s){if(done)return;done=true;try{c.abort(s&&s.reason);}catch(e){c.abort();}}
for(var i=0;i<list.length;i++){if(list[i].aborted){stop(list[i]);break;}
list[i].addEventListener("abort",(function(s){return function(){stop(s);};})(list[i]),{once:true});}
return c.signal;};}}catch(e){}
})();</script>`;

/**
 * 页面侧 shim 的第二段：回环穿透。
 *
 * 参考实现（DSHgo）在 Android 端监听手机的 `127.0.0.1:<port>` 再顺着 VPN 打回电脑，
 * 页面完全不用改。我们是 PWA，手机上没有进程能监听端口，所以换成「页面里改写地址」：
 * `http://127.0.0.1:9230/x` → `/__pocket__/loop/9230/x`（同源，cookie 照带）。
 *
 * 只改写**白名单端口**，且只碰 loopback 主机名；其余流量原样放行。
 * 没配白名单时这段脚本直接不注入（`window.__dshPocketLoops` 为空 = 零影响）。
 */
function loopShim(ports) {
  if (!Array.isArray(ports) || ports.length === 0) return '';
  return `<script ${INJECT_MARK}-loop="1">window.__dshPocketLoops=${JSON.stringify(ports)};(function(){
var ports=window.__dshPocketLoops;
function rewrite(url){
  try{
    var u=new URL(String(url),location.href);
    if(u.hostname!=="127.0.0.1"&&u.hostname!=="localhost")return null;
    var p=Number(u.port||(u.protocol==="https:"?443:80));
    if(ports.indexOf(p)<0)return null;
    return "/__pocket__/loop/"+p+u.pathname+u.search;
  }catch(e){return null;}
}
try{
  var f=window.fetch;
  if(typeof f==="function"){
    window.fetch=function(input,init){
      try{
        if(typeof input==="string"){var r=rewrite(input);if(r)input=r;}
        else if(input&&typeof input.url==="string"){var r2=rewrite(input.url);if(r2)input=new Request(r2,input);}
      }catch(e){}
      return f.call(this,input,init);
    };
  }
}catch(e){}
try{
  var open=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(method,url){
    var r=null;try{r=rewrite(url);}catch(e){}
    var args=Array.prototype.slice.call(arguments);
    if(r)args[1]=r;
    return open.apply(this,args);
  };
}catch(e){}
try{
  var NativeWS=window.WebSocket;
  if(typeof NativeWS==="function"){
    function PocketWS(url,protocols){
      var r=null;try{r=rewrite(url);}catch(e){}
      var full=r?((location.protocol==="https:"?"wss://":"ws://")+location.host+r):url;
      return protocols===undefined?new NativeWS(full):new NativeWS(full,protocols);
    }
    PocketWS.prototype=NativeWS.prototype;
    ["CONNECTING","OPEN","CLOSING","CLOSED"].forEach(function(k){try{PocketWS[k]=NativeWS[k];}catch(e){}});
    window.WebSocket=PocketWS;
  }
}catch(e){}
})();</script>`;
}

/** 拼出注入片：polyfill 必须在最前（页面脚本之前），回环 shim 紧随。 */
export function pageShim(ports = []) {
  return POLYFILL + loopShim(ports);
}

/** 插到 `<head>` 之后（页面自己的脚本之前），没有 head 就放最前面。 */
export function injectPolyfill(html, ports = []) {
  if (typeof html !== 'string' || html.includes(INJECT_MARK)) return html;
  const shim = pageShim(ports);
  const m = /<head[^>]*>/i.exec(html);
  if (m) {
    const at = m.index + m[0].length;
    return html.slice(0, at) + shim + html.slice(at);
  }
  return shim + html;
}

function decodeBody(buf, encoding) {
  switch (String(encoding ?? '').toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return gunzipSync(buf);
    case 'deflate':
      return inflateSync(buf);
    case 'br':
      return brotliDecompressSync(buf);
    default:
      return buf;
  }
}

function isHtml(contentType) {
  return String(contentType ?? '').toLowerCase().includes('text/html');
}

function acceptsHtml(header) {
  return typeof header === 'string' && header.includes('text/html');
}

/** 本机所有非回环 IPv4 地址（给启动日志与健康检查用）。 */
export function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const it of list ?? []) {
      if (it.family === 'IPv4' && !it.internal) out.push({ name, address: it.address });
    }
  }
  return out;
}

/** Tailscale 从 100.64.0.0/10 发地址：第二个八位组 64–127。 */
export function isCgnatAddress(address) {
  const m = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(String(address ?? ''));
  if (!m) return false;
  const second = Number(m[1]);
  return second >= 64 && second <= 127;
}

/**
 * @param {{
 *   upstream: ReturnType<import('./upstream.mjs').createUpstream>,
 *   getToken: () => string,
 *   pocket: ReturnType<import('./pocket.mjs').createPocket>,
 *   log: (msg: string) => void,
 * }} options
 */
export function createProxy(options) {
  const { upstream, getToken, pocket } = options;
  const getLoopPorts = typeof options.getLoopPorts === 'function' ? options.getLoopPorts : () => [];
  const log = options.log ?? (() => {});
  const authority = upstream.authority;

  /** 把入站请求改写成「上游以为自己在被本机浏览器访问」。 */
  function rewriteHeaders(req, extraCookie) {
    const headers = { ...req.headers };
    headers.host = authority;
    if (headers.origin !== undefined) headers.origin = `http://${authority}`;
    if (extraCookie) {
      const mine = String(extraCookie).split(';')[0];
      headers.cookie = headers.cookie ? `${headers.cookie}; ${mine}` : mine;
    }
    return headers;
  }

  function unauthorized(res) {
    const body = 'dsh-pocket: unauthorized — pair this device first\n';
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  /**
   * writeHead 但保留本层已经设的 set-cookie。
   *
   * 直接 `res.writeHead(status, upRes.headers)` 会把 `?pocket=` 换来的
   * `pocket-auth` cookie 冲掉（上游 303 自带 dsh-auth），手机于是每一跳都要重带令牌。
   */
  function writeHeadMerged(res, status, headers) {
    const out = { ...headers };
    const mine = res.getHeader('set-cookie');
    const up = out['set-cookie'];
    const merged = [].concat(mine ?? [], up ?? []).filter(Boolean);
    if (merged.length > 0) out['set-cookie'] = merged;
    else delete out['set-cookie'];
    res.writeHead(status, out);
  }

  /** 转发一个普通 HTTP 请求。返回 void，响应自己收尾。 */
  function forward(req, res, url, auth, targetPath) {
    const headers = rewriteHeaders(req, auth.cookie);
    const up = httpRequest({ host: upstream.host, port: upstream.port, method: req.method, path: targetPath, headers }, (upRes) => {
      const type = upRes.headers['content-type'];
      // 只拦 HTML：把二进制/图片读进内存是纯亏。
      if (!isHtml(type)) {
        writeHeadMerged(res, upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
        return;
      }
      const chunks = [];
      upRes.on('data', (c) => chunks.push(c));
      upRes.on('end', () => {
        let body;
        try {
          body = decodeBody(Buffer.concat(chunks), upRes.headers['content-encoding']).toString('utf8');
        } catch (err) {
          log(`proxy: html decode failed — ${err?.message ?? err}`);
          const raw = Buffer.concat(chunks);
          writeHeadMerged(res, upRes.statusCode ?? 502, upRes.headers);
          res.end(raw);
          return;
        }
        const out = Buffer.from(injectPolyfill(body, getLoopPorts()), 'utf8');
        const headersOut = { ...upRes.headers };
        delete headersOut['content-encoding'];
        delete headersOut['transfer-encoding'];
        headersOut['content-length'] = String(out.length);
        writeHeadMerged(res, upRes.statusCode ?? 200, headersOut);
        res.end(out);
      });
      upRes.on('error', () => res.destroy());
    });
    up.on('error', (err) => {
      log(`proxy: upstream error — ${err?.message ?? err}`);
      if (!res.headersSent) {
        const body = 'dsh-pocket: dsh web unreachable\n';
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(body) });
        res.end(body);
      } else {
        res.destroy();
      }
    });
    req.pipe(up);
  }

  return {
    /** @returns {boolean} 是否已处理 */
    handle(req, res) {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      const auth = pocket.authorize(req, url);
      if (!auth.ok) {
        unauthorized(res);
        return true;
      }

      // `?pocket=<token>` 只是首次进门的钥匙：换掉参数，改成 Set-Cookie。
      if (url.searchParams.has('pocket')) url.searchParams.delete('pocket');
      if (auth.cookie) res.setHeader('set-cookie', auth.cookie);

      const wantsHtml = acceptsHtml(req.headers.accept);
      // 只看**上游的**会话 cookie：pocket-auth 是我们自己的门禁，跟 dsh 的登录无关。
      const hasSession = String(req.headers.cookie ?? '').includes('dsh-auth-');
      const token = getToken();
      let targetPath = `${url.pathname}${url.search}`;
      if ((req.method === 'GET' || req.method === 'HEAD') && wantsHtml && !hasSession && token) {
        // 首屏必须带一次 token：不带就 401，永远拿不到会话 cookie。
        targetPath = `/?token=${encodeURIComponent(token)}`;
      }

      forward(req, res, url, auth, targetPath);
      return true;
    },

    /** WebSocket（`/api/remote.mux` 的实时流）必须原样双向穿透。 */
    handleUpgrade(req, socket, head) {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      const auth = pocket.authorize(req, url);
      if (!auth.ok) {
        socket.write('HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n');
        socket.destroy();
        return;
      }
      const headers = rewriteHeaders(req, auth.cookie);
      const up = httpRequest({ host: upstream.host, port: upstream.port, method: req.method, path: req.url, headers });
      up.on('upgrade', (upRes, upSocket, upHead) => {
        const lines = [`HTTP/1.1 101 Switching Protocols`];
        for (let i = 0; i < upRes.rawHeaders.length; i += 2) lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`);
        socket.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (upHead?.length) socket.write(upHead);
        if (head?.length) upSocket.write(head);
        upSocket.pipe(socket);
        socket.pipe(upSocket);
        upSocket.on('error', () => socket.destroy());
        socket.on('error', () => upSocket.destroy());
      });
      up.on('response', (upRes) => {
        // 上游拒绝升级（常见于版本太老没注册 remote.mux）——把状态如实回给客户端。
        const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage ?? ''}`];
        for (let i = 0; i < upRes.rawHeaders.length; i += 2) lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`);
        socket.write(`${lines.join('\r\n')}\r\n\r\n`);
        socket.destroy();
      });
      up.on('error', () => socket.destroy());
      up.end();
    },
  };
}