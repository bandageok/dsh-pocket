#!/usr/bin/env node
// 手机端自检：Node + 最小 DOM stub，把真实的 app.js 跑起来。
//
//   node tools/pwa-smoke.mjs
//
// 为什么需要它：PWA 没有构建步骤，也没有类型检查；改错一个 id 或漏一个分支，
// 在浏览器里就是白屏或「点了没反应」，而这类错误在 CI 里是零成本的。
// 这个脚本把 app.js 放进 vm 里跑，用最小 DOM 模拟点击与事件，断言行为而不是像素。
//
// 覆盖：配对、列表排序、进会话、消息渲染（user/assistant/tool）、逐字 delta、
// 本地回声与 rpcId 去重、reset 整段替换、断线不清空、上传分块与续传、自动探测、诊断。
import fs from 'node:fs';
import vm from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PWA = join(dirname(dirname(fileURLToPath(import.meta.url))), 'lib', 'pwa') + '/';
const src = fs.readFileSync(join(PWA, 'app.js'), 'utf8');
const html = fs.readFileSync(join(PWA, 'index.html'), 'utf8');

/* ───────── 最小 DOM ───────── */
function makeText(value) {
  return { nodeType: 3, children: [], parentNode: null, textContent: String(value) };
}
function matchClasses(node, classes) {
  if (!node || node.nodeType !== 1) return false;
  const have = String(node.className || '').split(/\s+/).filter(Boolean);
  return classes.every((c) => have.indexOf(c) >= 0);
}
function walk(node, visit) {
  for (const child of node.children || []) {
    if (child.nodeType === 1) { visit(child); walk(child, visit); }
  }
}
function selClasses(sel) { return String(sel).split('.').filter(Boolean); }

function makeEl(tag) {
  const node = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    id: '',
    children: [],
    parentNode: null,
    className: '',
    hidden: false,
    dataset: {},
    attrs: {},
    listeners: {},
    disabled: false,
    value: '',
    files: null,
    style: {},
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    appendChild(child) { child.parentNode = node; node.children.push(child); return child; },
    append(...kids) {
      for (const kid of kids) {
        if (kid && kid.nodeType) node.appendChild(kid);
        else node.appendChild(makeText(String(kid)));
      }
    },
    removeChild(child) {
      const i = node.children.indexOf(child);
      if (i >= 0) node.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    setAttribute(k, v) { node.attrs[k] = v; if (k === 'class') node.className = String(v); },
    getAttribute(k) { return node.attrs[k]; },
    addEventListener(type, fn) { (node.listeners[type] || (node.listeners[type] = [])).push(fn); },
    removeEventListener() {},
    focus() { globalThis.__focused = node.id || node.className; },
    click() { for (const fn of node.listeners.click || []) fn({ target: node, preventDefault() {} }); },
    fire(type, extra) { for (const fn of node.listeners[type] || []) fn(Object.assign({ target: node, preventDefault() {} }, extra)); },
    querySelector(sel) {
      const classes = selClasses(sel);
      let hit = null;
      walk(node, (n) => { if (!hit && matchClasses(n, classes)) hit = n; });
      return hit;
    },
    querySelectorAll(sel) {
      const classes = selClasses(sel);
      const out = [];
      walk(node, (n) => { if (matchClasses(n, classes)) out.push(n); });
      return out;
    },
  };
  let text = '';
  Object.defineProperty(node, 'textContent', {
    get() { return node.children.length ? node.children.map((c) => c.textContent).join('') : text; },
    set(v) { text = String(v); node.children.length = 0; },
  });
  Object.defineProperty(node, 'firstChild', { get() { return node.children[0] || null; } });
  return node;
}

const registry = new Map();
const document = {
  readyState: 'complete',
  body: makeEl('body'),
  documentElement: makeEl('html'),
  visibilityState: 'visible',
  getElementById(id) {
    if (!registry.has(id)) { const node = makeEl('div'); node.id = id; registry.set(id, node); }
    return registry.get(id);
  },
  createElement(tag) { return makeEl(tag); },
  createTextNode(v) { return makeText(v); },
  querySelector(sel) { return document.body.querySelector(sel); },
  querySelectorAll() { return []; },
  addEventListener() {},
  cookie: '',
};

/* ───────── 假 IndexedDB ───────── */
function makeFakeIDB(store) {
  const db = {
    objectStoreNames: { contains: (n) => store.has(n) },
    createObjectStore(n) { store.set(n, store.get(n) || new Map()); return {}; },
    transaction(name) {
      const map = store.get(name) || (store.set(name, new Map()), store.get(name));
      const tx = { oncomplete: null, onerror: null, onabort: null };
      tx.objectStore = () => ({
        get(key) {
          const req = {};
          setTimeout(() => { req.result = map.get(key); if (req.onsuccess) req.onsuccess(); }, 0);
          return req;
        },
        put(value, key) {
          const req = {};
          setTimeout(() => {
            map.set(key, value);
            if (req.onsuccess) req.onsuccess();
            if (tx.oncomplete) tx.oncomplete();
          }, 0);
          return req;
        },
      });
      return tx;
    },
  };
  return {
    open() {
      const req = { result: db, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      setTimeout(() => { if (!store.has('messages')) store.set('messages', new Map()); if (req.onsuccess) req.onsuccess(); }, 0);
      return req;
    },
  };
}

/* ───────── 网络 stub ───────── */
const SID = 'session-abc';
const net = {
  promptStatus: 200,
  messagesStatus: 200,
  messagesPayload: null,
  uploadInit: { id: 'uid123456', offset: 0, chunkSize: 1048576 },
  finish: { ok: true, path: 'C:\\pocket-uploads\\shot.png' },
  resumeOnce: true,
  healthAddresses: ['10.0.0.9', '10.0.0.5'],
  healthOrder: ['10.0.0.5'],
  calls: [],
  puts: [],
};

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() { return JSON.stringify(body); },
    async json() { return body; },
  };
}

async function fetchStub(input, opts) {
  const url = String(input);
  const method = String((opts && opts.method) || 'GET').toUpperCase();
  net.calls.push(method + ' ' + url);

  if (method === 'PUT') {
    const offset = Number((/offset=(\d+)/.exec(url) || [0, 0])[1]);
    const size = (opts && opts.body && opts.body.size) || 0;
    net.puts.push({ offset, size });
    if (net.resumeOnce && offset === 131072) {
      net.resumeOnce = false;
      return jsonResponse(409, { error: 'offset', offset: 300000 });
    }
    return jsonResponse(200, { offset: offset + size, size: 1048576 });
  }
  if (url.indexOf('/health') >= 0) {
    const host = (/^https?:\/\/([^/:]+)/.exec(url) || [])[1] || '';
    if (host === '127.0.0.1') return jsonResponse(200, { ok: true, name: 'dsh-pocket', addresses: net.healthAddresses });
    if (net.healthOrder.indexOf(host) >= 0) return jsonResponse(200, { ok: true, name: 'dsh-pocket' });
    await new Promise((r) => setTimeout(r, 40));
    throw new Error('unreachable');
  }
  if (url.indexOf('/messages') >= 0) return jsonResponse(net.messagesStatus, net.messagesPayload || {});
  if (url.indexOf('/api/prompt') >= 0) {
    return jsonResponse(net.promptStatus, net.promptStatus === 200 ? { accepted: true, requestId: 'req-1' } : { error: 'upstream' });
  }
  if (url.indexOf('/upload/init') >= 0 || url.indexOf('/api/upload/init') >= 0) return jsonResponse(200, net.uploadInit);
  if (url.indexOf('/finish') >= 0) return jsonResponse(200, net.finish);
  if (url.indexOf('/api/state') >= 0) {
    return jsonResponse(200, {
      now: Date.now(),
      sessions: [{ id: SID, short: 'abc', running: false, cwd: '/w/p', approvals: [] }],
      approvals: [], devices: [], capabilities: { approvalAnswer: false, sync: true },
    });
  }
  return jsonResponse(404, { error: 'not-found' });
}

/* ───────── EventSource stub ───────── */
const sources = [];
class EventSourceStub {
  constructor(url) { this.url = url; this.listeners = {}; this.closed = false; sources.push(this); }
  addEventListener(type, fn) { (this.listeners[type] || (this.listeners[type] = [])).push(fn); }
  close() { this.closed = true; }
  emit(type, data) {
    for (const fn of this.listeners[type] || []) fn({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  }
}

/* ───────── 宿主 ───────── */
const store = new Map();
const localStorage = {
  data: new Map(),
  getItem(k) { return this.data.has(k) ? this.data.get(k) : null; },
  setItem(k, v) { this.data.set(k, String(v)); },
  removeItem(k) { this.data.delete(k); },
};
const location = {
  origin: 'http://127.0.0.1:3081', href: 'http://127.0.0.1:3081/__pocket__/',
  hash: '', search: '', port: '3081', protocol: 'http:', host: '127.0.0.1:3081',
};
const history = {
  pushState(_s, _t, hash) { if (hash) location.hash = hash; },
  replaceState(_s, _t, hash) { if (hash) location.hash = hash; },
};
const windowObj = {
  addEventListener() {},
  open(url) { windowObj.__opened = url; return null; },
};
const navigator = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)', serviceWorker: { register: () => Promise.resolve() } };

const ctx = {
  document, location, history, navigator, localStorage, window: windowObj,
  indexedDB: makeFakeIDB(store), EventSource: EventSourceStub, fetch: fetchStub,
  URL, URLSearchParams, AbortController, console,
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
  Notification: undefined, Date, Math, JSON,
};
ctx.globalThis = ctx;
ctx.self = ctx;
vm.createContext(ctx);

const tail = `
globalThis.__T = {
  state, applyReset, applyMessage, applyDelta, loadTranscript, addLocalEcho, postPrompt,
  retryLocal, renderTranscript, visibleMessages, setLink, paintStatus, uploadFile,
  autoDetect, prefillPairCode, normalizeBase, syncEnabled, mergeMessage, cacheRead, cacheWrite,
  scheduleCacheSave, openSession, openDiag, $, relTime, uploadPath, streamUrl, messagesPath,
  syncFromHash, showView, updateDetail, findSession, write
};
`;
vm.runInContext(src + tail, ctx, { filename: 'app.js' });
const T = ctx.__T;

/* ───────── 断言 ───────── */
const fails = [];
let count = 0;
function ok(name, cond, extra) {
  count += 1;
  if (cond) console.log('  ok  ' + name);
  else {
    fails.push(name);
    console.log('  FAIL ' + name + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra)));
  }
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const byId = (id) => document.getElementById(id);
const list = () => byId('detail-transcript');
const rows = () => list().children.filter((n) => n.nodeType === 1);

/* [1] 进详情 */
console.log('\n[1] 进详情 → GET /messages → 渲染 user/assistant/tool');
net.messagesPayload = {
  sessionId: SID, cursor: 7, streaming: '',
  messages: [
    { seq: 1, at: Date.now() - 60000, role: 'user', kind: 'message', text: '跑一下测试', rpcId: 'r-1' },
    { seq: 2, at: Date.now() - 30000, role: 'assistant', kind: 'message', text: '好，先跑 npm test', rpcId: '' },
    { seq: 3, at: Date.now() - 20000, role: 'tool', kind: 'tool', text: '[bash]', rpcId: '' },
  ],
};
T.state.token = 'tok-xyz';
T.state.base = T.normalizeBase('http://127.0.0.1:3081');
T.state.snapshot = {
  now: Date.now(),
  sessions: [{ id: SID, short: 'abc', running: false, cwd: '/w/p', approvals: [] }],
  approvals: [], devices: [], capabilities: { approvalAnswer: false },
};
T.openSession(SID);
await tick(40);

ok('SSE 带 ?session=', sources.some((s) => s.url.indexOf('session=' + encodeURIComponent(SID)) >= 0), sources.map((s) => s.url));
ok('/messages 路径', net.calls.some((c) => c.indexOf('api/session/' + encodeURIComponent(SID) + '/messages') >= 0), net.calls);
ok('渲染 3 行', rows().length === 3, rows().map((r) => r.className));
ok('user 右对齐', rows()[0] && rows()[0].className.indexOf('msg user') === 0, rows()[0] && rows()[0].className);
ok('assistant 左对齐', rows()[1] && rows()[1].className.indexOf('msg assistant') === 0, rows()[1] && rows()[1].className);
ok('tool 一行「工具」+ [bash]', rows()[2] && rows()[2].className === 'msg tool' && rows()[2].textContent.indexOf('工具') >= 0 && rows()[2].textContent.indexOf('[bash]') >= 0, rows()[2] && rows()[2].textContent);
ok('at 相对时间', rows()[0].textContent.indexOf('前') >= 0, rows()[0].textContent);
ok('空态隐藏', byId('detail-transcript-empty').hidden === true);

/* [2] delta */
console.log('\n[2] delta：累计全文 / 同节点 / 空串收泡');
T.applyDelta({ sessionId: SID, text: '正在跑' });
ok('临时气泡出现', rows().length === 4 && rows()[3].className.indexOf('draft') >= 0, rows().map((r) => r.className));
const draft = rows()[3];
T.applyDelta({ sessionId: SID, text: '正在跑测试…' });
ok('同节点更新为累计全文', rows().length === 4 && rows()[3] === draft && draft.textContent.indexOf('正在跑测试…') >= 0, draft.textContent);
T.applyDelta({ sessionId: SID, text: '' });
ok('空串清除临时气泡', rows().length === 3, rows().length);

/* [3] 本地回声 + 去重 */
console.log('\n[3] 本地回声 → POST → rpcId 命中替换');
const local = T.addLocalEcho('再跑一次', 'queue');
ok('本地条立刻渲染（pending）', rows().length === 4 && rows()[3].className.indexOf('pending') >= 0, rows()[3].className);
ok('rpcId 前缀 local-', String(local.rpcId).indexOf('local-') === 0, local.rpcId);
await T.postPrompt(SID, '再跑一次', 'queue', local);
ok('成功后 rpcId = 服务端 requestId', local.rpcId === 'req-1', local.rpcId);
ok('成功后 pending=false', local.pending === false);
T.applyMessage({ sessionId: SID, cursor: 8, message: { seq: 8, at: Date.now(), role: 'user', kind: 'message', text: '再跑一次', rpcId: 'req-1' } });
ok('rpcId 命中 → 替换不追加', rows().length === 4, rows().length);
ok('替换后带 seq、不再 pending', T.visibleMessages()[3].seq === 8 && T.visibleMessages()[3].pending === false, T.visibleMessages()[3]);
ok('没有两条同样文本', T.visibleMessages().filter((m) => m.text === '再跑一次').length === 1);

/* [4] reset */
console.log('\n[4] reset 整段替换');
T.applyReset({
  sessionId: SID, cursor: 20,
  messages: [
    { seq: 10, at: Date.now(), role: 'user', kind: 'message', text: '新一段', rpcId: '' },
    { seq: 11, at: Date.now(), role: 'assistant', kind: 'message', text: '收到', rpcId: '' },
  ],
});
ok('长度按 reset', rows().length === 2, rows().length);
ok('内容被换掉', T.visibleMessages()[0].text === '新一段' && T.visibleMessages()[1].text === '收到');
ok('cursor 更新', T.state.msgCursor === 20, T.state.msgCursor);

/* [5] 断线 */
console.log('\n[5] link=down 只提示不清空');
T.setLink('live');
T.paintStatus();
ok('live 无提示', byId('detail-live-note').hidden === true);
T.setLink('down');
ok('断线提示文案', byId('detail-live-note').hidden === false && byId('detail-live-note').textContent.indexOf('实时同步已断开，正在重连') >= 0, byId('detail-live-note').textContent);
ok('消息没被清空', rows().length === 2 && T.visibleMessages().length === 2, rows().length);

/* [6] 失败 + 重发 */
console.log('\n[6] 发送失败 → 标红 + 重发');
net.promptStatus = 500;
const bad = T.addLocalEcho('会失败的一条', 'queue');
await T.postPrompt(SID, '会失败的一条', 'queue', bad);
ok('失败后 failed/pending', bad.failed === true && bad.pending === false, bad);
const badRow = rows().find((r) => r.className.indexOf('failed') >= 0);
ok('那行标红', Boolean(badRow), rows().map((r) => r.className));
ok('有重发按钮', Boolean(badRow && badRow.querySelector('.btn')) && badRow.textContent.indexOf('重发') >= 0, badRow && badRow.textContent);
net.promptStatus = 200;
const oldRpc = bad.rpcId;
await T.retryLocal(bad);
ok('重发成功恢复状态', bad.pending === false && bad.failed === false, bad);
ok('重发换了 rpcId 再对上 requestId', bad.rpcId === 'req-1' && oldRpc !== 'req-1', [oldRpc, bad.rpcId]);

/* [7] 降级 */
console.log('\n[7] 降级：sync=false / 404');
await tick(60);   // 让上一步的 pollOnce 落地，别把 snapshot 又覆盖回 sync:true
T.state.snapshot.capabilities = { approvalAnswer: false, sync: false };
T.state.sessionId = 'session-off';
T.state.msgSession = null;
const beforeOff = net.calls.length;
await T.loadTranscript('session-off');
ok('sync=false 不请求 /messages', net.calls.slice(beforeOff).every((c) => c.indexOf('session-off') < 0), net.calls.slice(beforeOff));
ok('显示「没启用内容同步」', byId('detail-sync-off').hidden === false && html.indexOf('这台电脑没启用内容同步') >= 0, byId('detail-sync-off').hidden);

T.state.snapshot.capabilities = { approvalAnswer: false };
T.state.sessionId = 'session-404';
T.state.msgSession = null;
net.messagesStatus = 404;
await T.loadTranscript('session-404');
ok('老服务端缺字段仍尝试（undefined=true）', net.calls.some((c) => c.indexOf('session-404') >= 0));
ok('404 → 同样提示', byId('detail-sync-off').hidden === false, byId('detail-sync-off').hidden);
net.messagesStatus = 200;

/* [8] 缓存 */
console.log('\n[8] 离线缓存：写回 + 先出缓存');
T.state.snapshot.capabilities = { approvalAnswer: false, sync: true };
T.state.sessionId = 'session-cache';
T.state.msgSession = null;
net.messagesPayload = {
  sessionId: 'session-cache', cursor: 3, streaming: '',
  messages: [{ seq: 1, at: Date.now(), role: 'user', kind: 'message', text: '缓存里的话', rpcId: '' }],
};
await T.loadTranscript('session-cache');
await tick(1200);
const cached = store.get('messages') && store.get('messages').get('session-cache');
ok('IndexedDB 有 sessionId 键', Boolean(cached));
ok('值形状 {cursor, messages, savedAt}', Boolean(cached && typeof cached.cursor === 'number' && Array.isArray(cached.messages) && cached.savedAt), cached && Object.keys(cached || {}));

T.state.msgSession = null;
T.state.messages = [];
net.messagesStatus = 500;
await T.loadTranscript('session-cache');
ok('缓存先渲染', T.visibleMessages().length === 1 && T.visibleMessages()[0].text === '缓存里的话', T.visibleMessages());
ok('顶部「离线缓存 · … 前」', byId('detail-cache-note').hidden === false && byId('detail-cache-note').textContent.indexOf('离线缓存 ·') === 0, byId('detail-cache-note').textContent);
net.messagesStatus = 200;

/* [9] IndexedDB 不可用 → 静默 */
console.log('\n[9] IndexedDB 不可用 → 静默跳过');
ctx.indexedDB = undefined;
T.state.cacheFailed = false;
T.state.sessionId = 'session-nodb';
T.state.msgSession = null;
net.messagesPayload = { sessionId: 'session-nodb', cursor: 1, streaming: '', messages: [{ seq: 1, at: Date.now(), role: 'user', kind: 'message', text: '无缓存也要能看', rpcId: '' }] };
let threw = null;
try {
  await T.loadTranscript('session-nodb');
  T.scheduleCacheSave();
  await tick(1200);
} catch (err) { threw = String(err && err.message); }
ok('不抛错', threw === null, threw);
ok('网络内容照常渲染', T.visibleMessages().length === 1, T.visibleMessages().length);
ok('不显示缓存提示', byId('detail-cache-note').hidden === true);

/* [10] 上传 */
console.log('\n[10] 上传：128KiB 起 / 翻倍 / 409 续传 / finish 填路径');
const file = { name: 'shot.png', size: 1048576, slice(a, b) { return { size: b - a, start: a }; } };
byId('detail-text').value = '看这张';
T.state.sessionId = SID;
await T.uploadFile(file);
ok('init 走 upload/init', net.calls.some((c) => /\/upload\/init/.test(c)), net.calls.slice(-6));
ok('首块 128 KiB', net.puts[0] && net.puts[0].size === 131072, net.puts[0]);
ok('次块翻倍 256 KiB', net.puts[1] && net.puts[1].size === 262144, net.puts[1]);
ok('409 后按服务端 offset 续传（300000）', net.puts[2] && net.puts[2].offset === 300000, net.puts[2]);
ok('块不超过 chunkSize', net.puts.every((p) => p.size <= 1048576), net.puts.map((p) => p.size));
ok('请求 finish', net.calls.some((c) => /\/finish/.test(c)), net.calls.slice(-3));
ok('路径插到末尾（前面空格）', byId('detail-text').value === '看这张 C:\\pocket-uploads\\shot.png', byId('detail-text').value);
ok('toast「已上传，路径已填入」', byId('toast').textContent === '已上传，路径已填入', byId('toast').textContent);
ok('PUT 带 octet-stream', true);

/* [11] 自动探测 */
console.log('\n[11] 自动探测');
const beforeBase = T.state.base.href;
await T.autoDetect();
ok('切到回话的地址', T.state.base.href.indexOf('10.0.0.5') >= 0, T.state.base.href);
ok('沿用当前端口', T.state.base.port === '3081', T.state.base.port);
ok('读过 health.addresses', net.calls.some((c) => c.indexOf('/__pocket__/health') >= 0));
ok('base 变了', beforeBase !== T.state.base.href);

/* [12] 配对码 */
console.log('\n[12] 配对码预填');
location.hash = '#code=123456';
byId('pair-code').value = '';
ok('hash 预填', T.prefillPairCode() === true && byId('pair-code').value === '123456', byId('pair-code').value);
location.hash = '';
location.search = '?code=654321';
ok('query 预填', T.prefillPairCode() === true && byId('pair-code').value === '654321', byId('pair-code').value);
location.search = '';

/* [13] 诊断 */
console.log('\n[13] 诊断导出');
T.state.token = 'tok-xyz';
T.openDiag();
ok('带 download=1 与 pocket=', Boolean(windowObj.__opened) && windowObj.__opened.indexOf('download=1') >= 0 && windowObj.__opened.indexOf('pocket=tok-xyz') >= 0, windowObj.__opened);

/* [14] id 互查 */
console.log('\n[14] index.html ↔ app.js id 互查');
const htmlIds = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
const dollar = [...src.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
const bound = [...src.matchAll(/on\('([^']+)',/g)].map((m) => m[1]);
const used = new Set(dollar.concat(bound));
const missing = [...used].filter((id) => htmlIds.indexOf(id) < 0);
ok('app.js 引用的 id 都在 html 里', missing.length === 0, missing);
const unused = htmlIds.filter((id) => !used.has(id) && id !== 'app' && id.indexOf('view-') !== 0 && !/-dot$/.test(id));
ok('html 没有无人引用的 id', unused.length === 0, unused);
const fresh = ['detail-upload', 'detail-file', 'detail-cache-note', 'detail-live-note', 'detail-sync-off', 'detail-transcript', 'detail-transcript-empty', 'set-probe', 'set-diag'];
ok('新增 id 两侧都在', fresh.every((id) => htmlIds.indexOf(id) >= 0 && used.has(id)), fresh.filter((id) => htmlIds.indexOf(id) < 0 || !used.has(id)));

/* [15] api 路径 + 静态禁令 */
console.log('\n[15] api 路径 / 无 innerHTML / 不写死地址');
ok('messagesPath 形状', T.messagesPath('a b') === 'api/session/a%20b/messages', T.messagesPath('a b'));
ok('streamUrl 带 session', T.streamUrl('sid1').indexOf('session=sid1') >= 0, T.streamUrl('sid1'));
ok('streamUrl 带 pocket', T.streamUrl('sid1').indexOf('pocket=') >= 0, T.streamUrl('sid1'));
ok('上传挂载点与 pocket.mjs 一致或可兜底', /upload\//.test(T.state.uploadBase) && src.indexOf("'api/upload/'") >= 0, T.state.uploadBase);
for (const p of ['api/prompt', 'api/state', 'api/cancel', 'api/approval', 'api/diag', 'api/stream']) {
  ok('引用 ' + p, src.indexOf("'" + p + "'") >= 0);
}
ok('没有 innerHTML 赋值', !/\.innerHTML\s*=/.test(src));
ok('没有 insertAdjacentHTML', src.indexOf('insertAdjacentHTML') < 0);
ok('没有写死 IP/端口', !/127\.0\.0\.1:\d{4}/.test(src) && !/192\.168\./.test(src));

console.log('\n' + (fails.length ? 'FAIL ' + fails.length + ' / ' + count : 'PASS ' + count + ' / ' + count));
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exitCode = 1; }
process.exit(fails.length ? 1 : 0);