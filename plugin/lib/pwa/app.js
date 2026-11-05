'use strict';
/*! DSH Pocket — 手机端 PWA 客户端（原生 JS，无构建 / 无框架 / 无 CDN / 无依赖）
 *  契约：docs/PROTOCOL.md v0.1 —— 端点、字段名、SSE 事件名一律照用，这里不发明协议。
 *  直连：fetch + EventSource。中继：WebSocket(/relay/client) + 每 3 秒 rpc('api/state') 轮询。
 *  结构：常量 → state → storage → utils → transport → data → render → actions → boot */

/* ═════════ 常量 ═════════ */
const LS_PREFIX = 'dshpocket.';
const LS_KEYS = ['base', 'token', 'deviceId', 'deviceName', 'relayUrl', 'room', 'notify'];
const POLL_MS = 3000;          // 协议：每 3 秒一次 state
const RPC_TIMEOUT_MS = 15000;  // 中继单次请求超时
const WS_BACKOFF_MAX = 10000;  // 中继重连退避 1s → 10s
const MAX_EVENTS = 50;         // 详情页原始事件日志上限
const LINK_TEXT = { live: 'SSE 在线', poll: '轮询降级', down: '断线' };
const VIEWS = ['connect', 'home', 'list', 'tasks', 'detail', 'settings'];

/* 双端同步 / 离线缓存 / 续传：名字与尺寸照任务约定，改成别的对端就认不出了 */
const IDB_NAME = 'dshpocket';
const IDB_STORE = 'messages';
const CACHE_SAVE_MS = 1000;         // 写 IndexedDB 的节流窗口
const UP_CHUNK_START = 128 * 1024;  // 上传起始块
const UP_CHUNK_MIN = 32 * 1024;     // 慢网的下限
const UP_FAST_MS = 1500;            // 单块 < 1.5s → 翻倍
const UP_SLOW_MS = 8000;            // 单块 > 8s → 减半
const PROBE_TIMEOUT_MS = 3000;      // 自动探测：单地址超时

/* ═════════ 状态 ═════════ */
function emptySnapshot() {
  return { now: 0, sessions: [], approvals: [], devices: [], capabilities: { approvalAnswer: false } };
}

const state = {
  base: null, token: '', deviceId: '', deviceName: '', relayUrl: '', room: '', notify: true, // 配置
  snapshot: emptySnapshot(), view: 'list', sessionId: null,                                 // 数据 / 界面
  link: 'down', es: null, esErrors: 0, pollTimer: null, pollBusy: false,                      // 连接
  ws: null, wsTries: 0, wsTimer: null, rpcSeq: 0, pending: new Map(),
  events: [], seenApprovals: Object.create(null), primed: false,                             // 日志 / 通知去重
  cancelArmed: 0, toastTimer: 0,
  // 转录：只装「当前会话」的一屏；切会话就整体换掉，免得多会话混在一起
  messages: [], msgSession: null, msgCursor: 0, msgDraft: '', msgState: 'idle',
  msgSavedAt: 0, msgFromCache: false, cacheTimer: 0, cacheFailed: false,
  esSession: null,                       // SSE 当前挂在哪个会话上（null = 只收状态）
  uploadBase: 'upload/', uploadBusy: false, uploadSlashed: false, probeBusy: false,
};

/* ═════════ localStorage ═════════ */
function lsGet(key, fallback) {
  try { const v = localStorage.getItem(LS_PREFIX + key); return v === null ? fallback : v; } catch { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(LS_PREFIX + key, String(value)); } catch { /* 隐私模式 / 配额满：只用内存态 */ }
}
function lsDel(key) {
  try { localStorage.removeItem(LS_PREFIX + key); } catch { /* ignore */ }
}
function loadConfig() {
  state.token = lsGet('token', '');
  state.deviceId = lsGet('deviceId', '');
  state.deviceName = lsGet('deviceName', '');
  state.relayUrl = lsGet('relayUrl', '');
  state.room = lsGet('room', '');
  state.notify = lsGet('notify', '1') !== '0';
  state.base = normalizeBase(lsGet('base', '') || location.origin);
}
function saveConfig() {
  lsSet('base', state.base ? state.base.href : '');
  lsSet('token', state.token);
  lsSet('deviceId', state.deviceId);
  lsSet('deviceName', state.deviceName);
  lsSet('relayUrl', state.relayUrl);
  lsSet('room', state.room);
  lsSet('notify', state.notify ? '1' : '0');
}

/* ═════════ 小工具 ═════════ */
const $ = (id) => document.getElementById(id);

/** 建节点。文本一律走 textContent —— cwd / 审批理由 / 报错都从这里过，不拼 innerHTML。 */
function el(tag, props, ...kids) {
  const node = document.createElement(tag);
  for (const key of Object.keys(props || {})) {
    const value = props[key];
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.slice(0, 2) === 'on' && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const kid of kids) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid && kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

/** 本地回声的临时 id：只用来和服务端回吐的 rpcId 对账，不发给服务端。 */
function randKey() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** 中文相对时间。时间戳可能是秒（协议示例）也可能是毫秒（实现是 Date.now()）。 */
function relTime(ts) {
  const raw = Number(ts);
  if (!raw) return '—';
  const secs = Math.max(0, Math.round((Date.now() - (raw < 1e12 ? raw * 1000 : raw)) / 1000));
  if (secs < 5) return '刚刚';
  if (secs < 60) return secs + ' 秒前';
  if (secs < 3600) return Math.round(secs / 60) + ' 分钟前';
  if (secs < 86400) return Math.round(secs / 3600) + ' 小时前';
  return Math.round(secs / 86400) + ' 天前';
}

function clock(ts) {
  const d = new Date(Number(ts) < 1e12 ? Number(ts) * 1000 : Number(ts));
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

function dirName(cwd) {
  const parts = String(cwd || '').split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '未命名会话';
}
function shortOf(s) {
  return !s ? '—' : (s.short ? String(s.short) : String(s.id || '').replace(/^session-/, '').slice(0, 8));
}
function sessionLabel(s) { return !s ? '—' : (s.title ? String(s.title) : dirName(s.cwd)); }

function guessDeviceName() {
  const ua = navigator.userAgent || '';
  if (/iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return '平板';
  if (/iPhone/i.test(ua)) return 'iPhone';
  return /Android/i.test(ua) ? 'Android' : '手机';
}

/** 地址归一：补协议、补 /__pocket__/、去 query/hash。 */
function normalizeBase(raw) {
  let text = String(raw || '').trim() || location.origin;
  if (!/^https?:\/\//i.test(text)) text = 'http://' + text;
  let url;
  try { url = new URL(text); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  let path = url.pathname.replace(/\/+$/, '');
  if (!/\/__pocket__$/.test(path)) path += '/__pocket__';
  url.pathname = path + '/';
  url.search = '';
  url.hash = '';
  return url;
}

/** 展示用：去掉末尾的 /__pocket__/。 */
function displayBase(url) {
  return !url ? '' : url.origin + url.pathname.replace(/\/+$/, '').replace(/\/__pocket__$/, '');
}

function toast(message, ms) {
  const node = $('toast');
  if (!node) return;
  node.textContent = message;
  node.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { node.hidden = true; }, ms || 2400);
}

/* ═════════ 传输：rpc ═════════ */
function isRelay() { return Boolean(state.relayUrl && state.room); }
function hostLabel() { return isRelay() ? '中继 · ' + state.room : (state.base ? state.base.host : '—'); }

function setLink(next) {
  if (state.link === next) return;
  state.link = next;
  paintStatus();
}

/** 唯一出口：async (path, {method, body}) -> {status, json}；status 0 = 请求没出去。 */
async function rpc(path, options) {
  const opts = options || {};
  const method = String(opts.method || 'GET').toUpperCase();
  const body = opts.body === undefined ? null : opts.body;
  return isRelay() ? rpcRelay(path, method, body) : rpcDirect(path, method, body);
}

async function rpcDirect(path, method, body) {
  let url;
  try { url = new URL(path, state.base); } catch { return { status: 0, json: null }; }
  const headers = { 'content-type': 'application/json' };
  if (state.token) headers.authorization = 'Bearer ' + state.token;
  let res;
  try {
    res = await fetch(url.href, {
      method, headers, cache: 'no-store', credentials: 'same-origin',
      body: body === null ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    return { status: 0, json: null, error: String((err && err.message) || err) };
  }
  let json = null;
  try {
    const text = await res.text();
    if (text) { try { json = JSON.parse(text); } catch { json = null; } }
  } catch { json = null; }
  return { status: res.status, json };
}

/** 写操作通用收尾：401 统一重新配对，0 统一提示断线，其余按 status 表给文案。 */
async function write(path, body, opts) {
  const res = await rpc(path, { method: 'POST', body });
  const table = (opts && opts.status) || {};
  const mapped = table[res.status];
  // status 表的值可以是字符串，也可以是 (res) => 文案（502 要读 body 里的 detail）
  const known = typeof mapped === 'function' ? mapped(res) : mapped;
  if (res.status === 200) { if (opts && opts.ok) opts.ok(res); return res; }
  if (res.status === 401) { onUnauthorized(); return res; }
  if (res.status === 0) toast((opts && opts.offline) || '连接断了，没发出去');
  else toast(known || ((opts && opts.unknown) || '操作失败') + '（HTTP ' + res.status + '）');
  return res;
}

/** 上游错误文案（502 body 带 detail/message）。 */
function upstreamText(res) {
  return (res.json && (res.json.detail || res.json.message)) || '未知';
}

/* ── 传输：中继 WS ── */
function relaySocketUrl() {
  if (!isRelay()) return null;
  let url;
  try { url = new URL(state.relayUrl); } catch { return null; }
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
  url.pathname = url.pathname.replace(/\/+$/, '') + '/relay/client';
  url.search = '?room=' + encodeURIComponent(state.room);
  url.hash = '';
  return url.href;
}

function relaySend(frame) {
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try { ws.send(JSON.stringify(frame)); return true; } catch { return false; }
}

function scheduleRelayRetry() {
  if (!isRelay()) return;
  clearTimeout(state.wsTimer);
  state.wsTries += 1;
  const delay = Math.min(1000 * 2 ** Math.min(state.wsTries - 1, 4), WS_BACKOFF_MAX);
  state.wsTimer = setTimeout(() => { state.wsTimer = null; relayConnect(); }, delay);
}

function relayConnect() {
  if (!isRelay()) return;
  if (state.ws && (state.ws.readyState === WebSocket.CONNECTING || state.ws.readyState === WebSocket.OPEN)) return;
  const href = relaySocketUrl();
  if (!href) return;
  let ws;
  try { ws = new WebSocket(href); } catch { scheduleRelayRetry(); return; }
  state.ws = ws;
  ws.onopen = () => { state.wsTries = 0; setLink('poll'); pollOnce(); };  // 中继没有 SSE → 黄灯
  ws.onmessage = (event) => relayOnFrame(event.data);
  ws.onerror = () => { /* 交给 onclose 统一重连 */ };
  ws.onclose = () => {
    if (state.ws === ws) state.ws = null;
    failPending();
    setLink('down');
    scheduleRelayRetry();
  };
}

function relayOnFrame(raw) {
  let frame;
  try { frame = JSON.parse(raw); } catch { return; }
  if (!frame || typeof frame !== 'object') return;
  if (frame.t === 'res') {
    const pending = state.pending.get(frame.id);
    if (!pending) return;
    state.pending.delete(frame.id);
    clearTimeout(pending.timer);
    let json = null;
    if (typeof frame.body === 'string' && frame.body) { try { json = JSON.parse(frame.body); } catch { json = null; } }
    pending.resolve({ status: Number(frame.status) || 0, json });
  } else if (frame.t === 'host') {
    setLink(frame.online === false ? 'down' : 'poll');
  } else if (frame.t === 'ping') {
    relaySend({ t: 'pong' });
  }
}

function failPending() {
  for (const pending of state.pending.values()) {
    clearTimeout(pending.timer);
    pending.resolve({ status: 0, json: null, offline: true });
  }
  state.pending.clear();
}

function rpcRelay(path, method, body) {
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve({ status: 0, json: null, offline: true });
  const id = ++state.rpcSeq;
  const headers = { 'content-type': 'application/json' };
  if (state.token) headers.authorization = 'Bearer ' + state.token;
  const frame = {
    t: 'req', id, method, headers,
    path: state.base.pathname.replace(/\/+$/, '/') + String(path).replace(/^\/+/, ''),
    body: body === null ? null : JSON.stringify(body),
  };
  return new Promise((resolve) => {
    const timer = setTimeout(() => { if (state.pending.delete(id)) resolve({ status: 0, json: null, timeout: true }); }, RPC_TIMEOUT_MS);
    state.pending.set(id, { resolve, timer });
    if (relaySend(frame)) return;
    state.pending.delete(id);
    clearTimeout(timer);
    resolve({ status: 0, json: null, offline: true });
  });
}

/* ── 传输：SSE / 轮询 ── */
/** SSE 地址。详情页必须带 ?session=<id>，插件才把这个会话的消息推给这条连接。 */
function streamUrl(sessionId) {
  const url = new URL('api/stream', state.base);
  const sid = sessionId === undefined ? state.esSession : sessionId;
  if (sid) url.searchParams.set('session', sid);
  // EventSource 设不了请求头，令牌只能走 cookie 或查询参数。
  if (state.token) url.searchParams.set('pocket', state.token);
  return url.href;
}

/** 让 SSE 跟着当前视角挂会话：进详情带 session，回列表摘掉；退化成轮询时不抢。 */
function refreshStreamSession(sessionId) {
  if (!state.token || isRelay()) return;
  if (state.pollTimer) return;
  if (state.es && state.esSession === (sessionId || null)) return;
  state.esSession = sessionId || null;
  openSSE();
}

function startStream() {
  stopStream();
  if (isRelay()) { relayConnect(); startPolling(); return; }
  state.esErrors = 0;
  // 重连也要保持「SSE 挂在当前会话上」，否则详情页只剩状态、没有内容
  state.esSession = state.view === 'detail' ? state.sessionId : null;
  openSSE();
}

function openSSE() {
  if (isRelay() || !state.token) return;
  if (state.es) { try { state.es.close(); } catch { /* ignore */ } state.es = null; }
  let es;
  try { es = new EventSource(streamUrl()); } catch { setLink('down'); startPolling(); return; }
  state.es = es;
  es.addEventListener('open', () => { state.esErrors = 0; setLink('live'); stopPolling(); });
  es.addEventListener('state', (e) => { setLink('live'); parseJSON(e.data, onSnapshot); });
  es.addEventListener('approval', (e) => { setLink('live'); parseJSON(e.data, onApprovalEvent); });
  es.addEventListener('approval-resolved', (e) => parseJSON(e.data, onResolvedEvent));
  // 双端同步的三个事件：reset 整段换、message 追加一条、delta 累计全文（'' = 本轮结束）
  es.addEventListener('reset', (e) => { setLink('live'); parseJSON(e.data, applyReset); });
  es.addEventListener('message', (e) => { setLink('live'); parseJSON(e.data, applyMessage); });
  es.addEventListener('delta', (e) => { setLink('live'); parseJSON(e.data, applyDelta); });
  es.addEventListener('error', () => {
    state.esErrors += 1;
    setLink('poll');
    if (state.esErrors < 3) return;
    // 浏览器内建重连连续失手：退化为 3 秒轮询，功能仍完整
    try { es.close(); } catch { /* ignore */ }
    if (state.es === es) state.es = null;
    startPolling();
  });
}

function parseJSON(raw, fn) {
  if (!raw) return;
  let data;
  try { data = JSON.parse(raw); } catch { return; }
  try { fn(data); } catch (err) { console.error('handler failed', err); }
}

function startPolling() {
  if (state.pollTimer) return;
  pollOnce();
  state.pollTimer = setInterval(pollOnce, POLL_MS);
}
function stopPolling() {
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
}

function stopStream() {
  if (state.es) { try { state.es.close(); } catch { /* ignore */ } state.es = null; }
  state.esSession = null;
  stopPolling();
  clearTimeout(state.wsTimer);
  state.wsTimer = null;
  if (state.ws) { const ws = state.ws; state.ws = null; try { ws.close(); } catch { /* ignore */ } }
  failPending();
}

async function pollOnce() {
  if (state.pollBusy || !state.token) return;
  state.pollBusy = true;
  try {
    const res = await rpc('api/state');
    if (res.status === 200 && res.json) { if (isRelay()) setLink('poll'); onSnapshot(res.json); }
    else if (res.status === 401) onUnauthorized();
    else if (res.status === 0) setLink('down');
    else showBanner('读取状态失败（HTTP ' + res.status + '）');
  } finally {
    state.pollBusy = false;
  }
}

/* ═════════ 数据 ═════════ */
function onSnapshot(snap) {
  if (!snap || typeof snap !== 'object') return;
  state.snapshot = {
    now: Number(snap.now) || Date.now(),
    sessions: Array.isArray(snap.sessions) ? snap.sessions : [],
    approvals: Array.isArray(snap.approvals) ? snap.approvals : [],
    devices: Array.isArray(snap.devices) ? snap.devices : [],
    capabilities: Object.assign({ approvalAnswer: false }, snap.capabilities || {}),
    upstreamError: snap.upstreamError || null,
  };
  hideBanner();
  trackApprovals();
  updateCurrentView();
}

function trackApprovals() {
  const list = [];
  for (const session of state.snapshot.sessions) for (const a of session.approvals || []) list.push(a);
  for (const a of state.snapshot.approvals) list.push(a);
  const fresh = [];
  for (const a of list) {
    if (!a || !a.id || state.seenApprovals[a.id]) continue;
    state.seenApprovals[a.id] = 1;
    fresh.push(a);
  }
  if (!state.primed) { state.primed = true; return; }  // 首帧只登记，免得一进页面炸一堆通知
  for (const a of fresh) notifyApproval(a);
}

function onApprovalEvent(approval) {
  if (!approval || !approval.id) return;
  const seen = Boolean(state.seenApprovals[approval.id]);
  state.seenApprovals[approval.id] = 1;
  pushEvent('approval', (approval.tool || '未知工具') + (approval.reason ? ' · ' + approval.reason : ''));
  if (!seen) notifyApproval(approval);
  updateCurrentView();
}

function onResolvedEvent(data) {
  if (!data || !data.id) return;
  pushEvent('approval-resolved', data.id + ' → ' + (data.outcome || '未知结果'));
  updateCurrentView();
}

function notifyApproval(approval) {
  if (!state.notify || document.visibilityState !== 'visible') return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    new Notification('需要审批：' + (approval.tool || '未知工具'), { body: approval.reason || '', tag: 'dshpocket-' + approval.id });
  } catch { /* iOS 未安装到主屏时没有构造器 */ }
}

function pushEvent(kind, text) {
  state.events.push({ at: Date.now(), kind, text });
  if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
  const list = $('detail-log');
  if (list && !list.hidden) renderLog();
}

function findSession(id) { return id ? state.snapshot.sessions.find((s) => s.id === id) || null : null; }

/** 排序：有审批 > 运行中 > 最近活动。 */
function sortedSessions() {
  const weight = (s) => ((s.approvals && s.approvals.length) ? 2 : 0) + (s.running ? 1 : 0);
  return state.snapshot.sessions.slice().sort((a, b) => {
    const wa = weight(a), wb = weight(b);
    if (wa !== wb) return wb - wa;
    return Number(b.lastActivityAt || b.updatedAt || 0) - Number(a.lastActivityAt || a.updatedAt || 0);
  });
}

function latestSession() {
  const sorted = sortedSessions();
  return sorted.length ? sorted[0] : null;
}

function approvalsFor(session) {
  if (!session) return [];
  return Array.isArray(session.approvals) ? session.approvals : state.snapshot.approvals.filter((a) => a.sessionId === session.id);
}

/* ═════════ 渲染 ═════════ */
function paintStatus() {
  for (const dot of document.querySelectorAll('.dot')) dot.dataset.link = state.link;
  const host = null; // 旧的 statusbar 已拆成「列表头」，主机名显示在别处
  if (host) host.textContent = hostLabel();
  const link = $('list-link');
  if (link) link.textContent = LINK_TEXT[state.link] || '—';
  // 断线只提示，绝不清空已有消息 —— 手机上「突然白屏」比「停住」糟得多
  const live = $('detail-live-note');
  if (live) {
    const stagnant = state.view === 'detail' && state.link !== 'live';
    live.hidden = !stagnant;
    if (stagnant) live.textContent = isRelay() ? '中继模式没有实时推送，正在用轮询' : '实时同步已断开，正在重连';
  }
}

function showBanner(message) {
  const node = $('list-banner');
  if (node) { node.textContent = message; node.hidden = !message; }
}

function hideBanner() {
  const node = $('list-banner');
  if (!node) return;
  const upstream = state.snapshot.upstreamError;
  node.textContent = upstream ? '上游 dsh 异常：' + (upstream.code || 'error') : '';
  node.hidden = !upstream;
}

function updateCurrentView() {
  if (state.view === 'list') updateList();
  else if (state.view === 'detail') updateDetail();
  else if (state.view === 'connect') updateConnect();
  else if (state.view === 'settings') updateSettings();
  paintStatus();
}

function showView() {
  if (state.view === 'detail' && !state.sessionId) state.view = 'list';
  // 没有 token 时任何页面都回到连接屏（否则深链接会把未配对的人丢进设置页）
  if (!state.token) state.view = 'connect';
  for (const name of VIEWS) {
    const section = $('view-' + name);
    if (section) section.hidden = name !== state.view;
  }
  document.body.dataset.view = state.view;
  // 连接屏与会话详情是全屏的，底部导航让位
  const tabbar = $('tabbar');
  if (tabbar) tabbar.hidden = state.view === 'connect' || state.view === 'detail';
  const inDetail = state.view === 'detail' && Boolean(state.sessionId);
  if (inDetail && state.msgSession !== state.sessionId) void loadTranscript(state.sessionId);
  refreshStreamSession(inDetail ? state.sessionId : null);
  updateCurrentView();
}

function hashFor(view) {
  return view === 'detail' ? '#/s/' + encodeURIComponent(state.sessionId || '') : '#/' + view;
}

function navigate(view, options) {
  const opts = options || {};
  if (opts.sessionId !== undefined) state.sessionId = opts.sessionId;
  state.view = VIEWS.indexOf(view) >= 0 ? view : (state.token ? 'home' : 'connect');
  const hash = hashFor(state.view);
  try {
    if (opts.replace) history.replaceState(null, '', hash);
    else if (location.hash !== hash) history.pushState(null, '', hash);
  } catch { /* 老 WebView 上 pushState 可能抛错，不影响视图切换 */ }
  showView();
}

function syncFromHash() {
  const raw = String(location.hash || '');
  const picked = /^#\/s\/(.+)$/.exec(raw);
  if (picked) {
    state.sessionId = decodeURIComponent(picked[1]);
    state.view = 'detail';
  } else {
    const plain = /^#\/(\w+)$/.exec(raw);
    const name = plain ? plain[1] : '';
    const known = VIEWS.indexOf(name) >= 0 && (name !== 'connect' || !state.token);
    state.view = known ? name : (state.token ? 'list' : 'connect');
  }
  showView();
}

/* ── A. 连接屏 ── */
function updateConnect() {
  const base = $('pair-base');
  if (base) {
    // 占位示例从当前页面推出来，不写死 IP 和端口
    base.placeholder = displayBase(normalizeBase(location.origin)) || 'http://…';
    if (!base.value) base.value = displayBase(state.base) || location.origin;
  }
  const name = $('pair-name');
  if (name && !name.value) name.value = state.deviceName || guessDeviceName();
  const button = $('pair-submit');
  if (button) button.disabled = false;
}

function setPairError(message) {
  const node = $('pair-error');
  if (!node) return;
  node.textContent = message || '';
  node.hidden = !message;
}

/* ── B. 会话列表 ── */
function badgeFor(session) {
  if (session.approvals && session.approvals.length) return el('span', { class: 'badge warn', text: '🟠 待审批' });
  if (session.running) return el('span', { class: 'badge ok', text: '🟢 运行中' });
  return el('span', { class: 'badge idle', text: '⚪ 空闲' });
}

function cardFor(session) {
  const approvals = session.approvals || [];
  const main = el('button', { class: 'card-main', type: 'button', onclick: () => openSession(session.id) },
    el('div', { class: 'card-row' }, el('span', { class: 'card-title', text: sessionLabel(session) }), badgeFor(session)),
    el('div', { class: 'card-sub' },
      el('span', { class: 'mono', text: shortOf(session) }),
      el('span', { class: 'card-time', text: relTime(session.lastActivityAt || session.updatedAt) })));
  if (approvals.length) {
    main.append(el('div', { class: 'card-approval', text: approvals[0].tool + (approvals[0].reason ? ' · ' + approvals[0].reason : '') }));
  }
  return el('li', { class: 'card' + (approvals.length ? ' has-approval' : '') }, main);
}

function updateList() {
  const cards = $('list-cards');
  if (!cards) return;
  const sessions = sortedSessions();
  clear(cards);
  for (const session of sessions) cards.append(cardFor(session));
  const empty = $('list-empty');
  if (empty) empty.hidden = sessions.length > 0;
  const input = $('quick-input');
  const send = $('quick-send');
  if (input) {
    input.disabled = sessions.length === 0;
    input.placeholder = sessions.length ? '快速指令 → ' + sessionLabel(sessions[0]) : '还没有会话';
  }
  if (send) send.disabled = sessions.length === 0;
  hideBanner();
  paintStatus();
}

function openSession(id) {
  state.sessionId = id;
  if (state.msgSession !== id) {
    state.messages = [];
    state.msgSession = null;
    state.msgCursor = 0;
    state.msgDraft = '';
    state.msgState = 'idle';
    state.msgSavedAt = 0;
    state.msgFromCache = false;
    renderTranscript();
  }
  navigate('detail', { sessionId: id });
  updateDetail();
}

/* ── C. 会话详情：只更新文本与列表，绝不重绘 textarea ── */
function approvalRow(approval) {
  const row = el('div', { class: 'approval' },
    el('div', { class: 'approval-head' },
      el('span', { class: 'approval-tool', text: approval.tool || '未知工具' }),
      el('span', { class: 'muted small', text: relTime(approval.createdAt) })),
    el('p', { class: 'approval-reason', text: approval.reason || '（没有给出理由）' }));
  if (state.snapshot.capabilities.approvalAnswer) {
    row.append(el('div', { class: 'approval-actions' },
      el('button', { class: 'btn primary small', type: 'button', text: '允许', onclick: () => answerApproval(approval.id, 'allow') }),
      el('button', { class: 'btn danger small', type: 'button', text: '拒绝', onclick: () => answerApproval(approval.id, 'deny') })));
  } else {
    row.append(el('p', { class: 'muted small', text: '需在电脑上批准' }));
  }
  return row;
}

function renderLog() {
  const list = $('detail-log');
  if (!list) return;
  clear(list);
  if (!state.events.length) { list.append(el('li', { class: 'log-empty', text: '还没有收到事件' })); return; }
  for (const event of state.events.slice().reverse()) {
    list.append(el('li', { class: 'log-item' },
      el('span', { class: 'log-time mono', text: clock(event.at) }),
      el('span', { class: 'log-kind', text: event.kind }),
      el('span', { class: 'log-text', text: event.text })));
  }
}

function toggleLog() {
  const list = $('detail-log');
  if (!list) return;
  list.hidden = !list.hidden;
  const button = $('detail-log-toggle');
  if (button) button.setAttribute('aria-expanded', String(!list.hidden));
  if (!list.hidden) renderLog();
}

function updateDetail() {
  if (!state.sessionId) { state.view = 'list'; showView(); return; }
  const session = findSession(state.sessionId);

  const title = $('detail-title');
  if (title) title.textContent = session ? sessionLabel(session) : '会话已结束';
  const sub = $('detail-sub');
  if (sub) {
    sub.textContent = session
      ? shortOf(session) + ' · ' + (session.running ? '运行中' : '空闲')
      : shortOf({ id: state.sessionId });
  }

  const wrap = $('detail-approvals');
  if (wrap) {
    clear(wrap);
    const approvals = approvalsFor(session);
    if (!approvals.length) wrap.append(el('p', { class: 'muted small', text: '没有待审批的请求' }));
    else {
      wrap.append(el('h2', { class: 'section-title', text: '审批（' + approvals.length + '）' }));
      for (const approval of approvals) wrap.append(approvalRow(approval));
    }
  }

  const activity = $('detail-activity');
  if (activity) {
    activity.textContent = session
      ? '最近活动 ' + relTime(session.lastActivityAt || session.updatedAt)
      : '这个会话不在当前列表里（可能已结束）';
  }
  updateTranscriptNotes();
  renderLog();
  paintStatus();
}

/* ── D. 设置 ── */
function updateSettings() {
  const base = $('set-base');
  if (base) base.value = displayBase(state.base);
  const name = $('set-name');
  if (name) name.value = state.deviceName || guessDeviceName();
  const token = $('set-token');
  if (token) token.textContent = state.token ? state.token.slice(0, 8) + '…' : '—';
  const relay = $('set-relay');
  if (relay) relay.value = state.relayUrl;
  const room = $('set-room');
  if (room) room.value = state.room;
  const notify = $('set-notify');
  if (notify) notify.checked = state.notify;

  // Runtime 卡：把快照里能确证的事实摆出来（上游端口、连接方式、设备、同步能力）
  const upstream = $('set-upstream');
  if (upstream) {
    upstream.textContent = state.snapshot && state.snapshot.upstreamPort
      ? '本机代理 · ' + state.snapshot.upstreamPort
      : (state.base ? state.base.host : '—');
  }
  const link = $('set-link');
  if (link) {
    link.textContent = state.link === 'live' ? 'SSE 实时' : state.link === 'poll' ? '轮询降级' : '断开';
  }
  const device = $('set-device');
  if (device) device.textContent = state.deviceName || guessDeviceName();
  const sync = $('set-sync');
  if (sync) {
    const cap = state.snapshot && state.snapshot.capabilities;
    sync.textContent = cap ? (cap.sync ? '内容同步已启用' : '仅快照（无内容同步）') : '—';
  }
  const ver = $('set-version');
  if (ver) ver.textContent = 'DSH Mobile · ' + (state.version || '0.4.x');
  paintStatus();
}

/* ═════════ 同步：会话转录 ═════════ */
/* 数据形状以 plugin/lib/follow.mjs 为准：
 *   GET  api/session/<id>/messages → {sessionId, cursor, streaming, messages[]}
 *   SSE  reset   {sessionId, cursor, messages[]}   整段替换
 *        message {sessionId, cursor, message}      追加（rpcId 命中就替换本地回声）
 *        delta   {sessionId, text}                 累计全文，'' = 这一轮结束
 * 消息字段：{seq, at, role, kind, text, rpcId}（normalizeEvent 的返回值）。 */

/** 老服务端没有 capabilities.sync —— 缺省当「有」，别把老插件当残废。 */
function syncEnabled() { return state.snapshot.capabilities.sync !== false; }
function messagesPath(id) { return 'api/session/' + encodeURIComponent(id) + '/messages'; }
/** 只展示属于当前会话的那一份；切会话时旧数据的晚到帧不许串进来。 */
function visibleMessages() { return state.msgSession && state.msgSession === state.sessionId ? state.messages : []; }

function normalizeMessage(raw) {
  const m = raw && typeof raw === 'object' ? raw : {};
  const role = m.role === 'user' || m.role === 'assistant' || m.role === 'tool' ? m.role : 'other';
  return {
    seq: Number(m.seq) || 0,
    at: Number(m.at) || Date.now(),
    role,
    kind: String(m.kind || (role === 'tool' ? 'tool' : 'message')),
    text: m.text === null || m.text === undefined ? '' : String(m.text),
    rpcId: String(m.rpcId || ''),
    pending: Boolean(m.pending),
    failed: Boolean(m.failed),
    local: Boolean(m.local),
    mode: m.mode === 'steer' ? 'steer' : 'queue',
  };
}

/**
 * 合并一条正式消息：rpcId 命中本地回声 → **替换**（否则自己发的会出现两条）；
 * 没有 rpcId 就按 seq 去重（同一个事件被重推两次）；都没有才追加。
 */
function mergeMessage(incoming) {
  const msg = normalizeMessage(incoming);
  const list = state.messages;
  let index = msg.rpcId ? list.findIndex((m) => m.rpcId && m.rpcId === msg.rpcId) : -1;
  if (index < 0 && msg.seq) index = list.findIndex((m) => m.seq && m.seq === msg.seq);
  if (index >= 0) list[index] = msg;
  else list.push(msg);
  return msg;
}

function applyReset(data) {
  if (!data || typeof data !== 'object') return;
  const id = String(data.sessionId || '');
  if (!id || id !== state.sessionId) return;
  const next = Array.isArray(data.messages) ? data.messages.map(normalizeMessage) : [];
  // 快照里还没有的那几条「本地回声」留着，否则发出去的字会被一次刷新吞掉
  for (const local of state.messages) {
    if (!local.local || (!local.pending && !local.failed)) continue;
    if (local.rpcId && next.some((m) => m.rpcId === local.rpcId)) continue;
    next.push(local);
  }
  state.msgSession = id;
  state.messages = next;
  state.msgCursor = Number(data.cursor) || 0;
  state.msgState = 'ready';
  state.msgFromCache = false;
  renderTranscript();
  scheduleCacheSave();
}

function applyMessage(data) {
  if (!data || typeof data !== 'object') return;
  const id = String(data.sessionId || '');
  if (!id || id !== state.sessionId) return;
  if (state.msgSession !== id) { state.msgSession = id; state.messages = []; }
  mergeMessage(data.message);
  state.msgCursor = Math.max(state.msgCursor, Number(data.cursor) || 0);
  state.msgState = 'ready';
  state.msgFromCache = false;
  renderTranscript();
  scheduleCacheSave();
}

function applyDelta(data) {
  if (!data || typeof data !== 'object') return;
  const id = String(data.sessionId || '');
  if (!id || id !== state.sessionId) return;
  // text 是累计全文；'' = 这一轮结束，把临时气泡收掉（正式消息随后从 message 事件来）
  state.msgDraft = typeof data.text === 'string' ? data.text : '';
  paintDraft();
}

/** 详情页入口：先出缓存（离线也能读），再拉网覆盖。 */
async function loadTranscript(sessionId) {
  if (!sessionId) return;
  const switched = state.msgSession !== sessionId;
  if (switched) {
    state.messages = [];
    state.msgCursor = 0;
    state.msgDraft = '';
    state.msgSavedAt = 0;
    state.msgFromCache = false;
    state.msgState = 'idle';
  }
  state.msgSession = sessionId;

  if (switched) {
    const cached = await cacheRead(sessionId);
    if (state.msgSession !== sessionId) return;
    if (cached && Array.isArray(cached.messages) && cached.messages.length) {
      state.messages = cached.messages.map(normalizeMessage);
      state.msgCursor = Number(cached.cursor) || 0;
      state.msgSavedAt = Number(cached.savedAt) || 0;
      state.msgFromCache = true;
      state.msgState = 'offline';
      renderTranscript();
    }
  }

  if (!syncEnabled()) { state.msgState = 'unsupported'; state.msgFromCache = false; renderTranscript(); return; }
  if (!state.token) return;
  if (!state.messages.length) { state.msgState = 'loading'; renderTranscript(); }

  const res = await rpc(messagesPath(sessionId));
  if (state.msgSession !== sessionId || state.sessionId !== sessionId) return;
  if (res.status === 200 && res.json && typeof res.json === 'object') {
    applyReset({ sessionId, cursor: res.json.cursor, messages: res.json.messages });
    if (typeof res.json.streaming === 'string' && res.json.streaming) {
      state.msgDraft = res.json.streaming;
      paintDraft();
    }
    state.msgState = 'ready';
    state.msgFromCache = false;
    renderTranscript();
    scheduleCacheSave();
    return;
  }
  if (res.status === 404) {
    // 老服务端没这个端点（或没启用同步层）：只给提示，别的功能照旧
    state.msgState = 'unsupported';
    state.msgFromCache = false;
    renderTranscript();
    return;
  }
  if (res.status === 401) { onUnauthorized(); return; }
  // 拉网失败：缓存还在就继续显示它，顶上一句「离线缓存」
  state.msgState = state.messages.length ? 'ready' : 'offline';
  renderTranscript();
}

/* markdown.js 提供 bubbleContent（富文本气泡）；万一没加载到（旧缓存、或插件进程还是旧的），
   退化成纯文本，绝不让整屏白掉。 */
function bubbleFor(message) {
  try {
    if (typeof bubbleContent === "function") return bubbleContent(message);
  } catch (err) {
    /* 渲染器抛错也要能显示原文 */
  }
  return el("div", { class: "bubble", text: message.text });
}
/* ── 转录渲染 ── */
function messageRow(message) {
  const time = el('span', { class: 'msg-time', text: relTime(message.at) });
  if (message.role === 'tool') {
    return el('li', { class: 'msg tool' },
      el('span', { class: 'msg-tool-label', text: '工具' }),
      el('span', { class: 'msg-tool-name mono', text: message.text || '' }),
      time);
  }
  const side = message.role === 'user' ? 'user' : 'assistant';
  const classes = ['msg', side];
  if (message.pending) classes.push('pending');
  if (message.failed) classes.push('failed');
  const meta = el('div', { class: 'msg-meta' }, time);
  if (message.pending) meta.append(el('span', { class: 'msg-state', text: '发送中…' }));
  if (message.failed) {
    meta.append(el('span', { class: 'msg-state bad', text: '发送失败' }));
    meta.append(el('button', { class: 'btn small', type: 'button', text: '重发', onclick: () => retryLocal(message) }));
  }
  return el('li', { class: classes.join(' ') },
    bubbleFor(message),
    meta);
}

function draftRow(text) {
  return el('li', { class: 'msg assistant draft' },
    bubbleFor({ role: 'assistant', text: text }),
    el('div', { class: 'msg-meta' }, el('span', { class: 'msg-state', text: '正在输出…' })));
}

function renderTranscript() {
  if (window.__dshRender) window.__dshRender();
  const list = $('detail-transcript');
  if (!list) return;
  clear(list);
  for (const message of visibleMessages()) list.append(messageRow(message));
  if (state.msgDraft) list.append(draftRow(state.msgDraft));
  syncEmptyState();
  updateTranscriptNotes();
  scrollTranscript();
}

function syncEmptyState() {
  const empty = $('detail-transcript-empty');
  if (!empty) return;
  const blank = visibleMessages().length === 0 && !state.msgDraft && state.msgState !== 'loading';
  empty.hidden = !blank;
}

/** 流式增量只动临时气泡那一个节点，不整表重绘（否则长会话每 100ms 重建一次 DOM）。 */
function paintDraft() {
  const list = $('detail-transcript');
  if (!list) return;
  const existing = list.querySelector('.msg.draft');
  if (!state.msgDraft) {
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
  } else if (existing) {
    const bubble = existing.querySelector('.bubble');
    if (bubble) bubble.textContent = state.msgDraft;
  } else {
    list.append(draftRow(state.msgDraft));
  }
  syncEmptyState();
  scrollTranscript();
}

function scrollTranscript() {
  const list = $('detail-transcript');
  if (!list) return;
  try {
    const gap = list.scrollHeight - list.scrollTop - list.clientHeight;
    if (gap < 120) list.scrollTop = list.scrollHeight;   // 用户往回翻的时候别抢滚动条
  } catch { /* 无布局（测试 stub / 隐藏视图） */ }
}

function updateTranscriptNotes() {
  const cache = $('detail-cache-note');
  if (cache) {
    const show = Boolean(state.msgFromCache && state.msgSavedAt);
    cache.hidden = !show;
    if (show) cache.textContent = '离线缓存 · ' + relTime(state.msgSavedAt);
  }
  const off = $('detail-sync-off');
  if (off) off.hidden = state.msgState !== 'unsupported';
}

/* ═════════ 离线缓存（IndexedDB；不可用就静默跳过） ═════════ */
let idbHandle = null;

function idbOpen() {
  if (idbHandle) return Promise.resolve(idbHandle);
  if (state.cacheFailed) return Promise.resolve(null);
  if (typeof indexedDB === 'undefined' || !indexedDB) return Promise.resolve(null);
  return new Promise((resolve) => {
    let request;
    try { request = indexedDB.open(IDB_NAME, 1); } catch { state.cacheFailed = true; resolve(null); return; }
    request.onupgradeneeded = () => {
      try {
        const db = request.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      } catch { /* 另一个标签页抢先建了表 */ }
    };
    request.onsuccess = () => { idbHandle = request.result; resolve(idbHandle); };
    request.onerror = () => { state.cacheFailed = true; resolve(null); };
    request.onblocked = () => resolve(null);
  });
}

async function cacheRead(sessionId) {
  const db = await idbOpen();
  if (!db || !sessionId) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(sessionId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function cacheWrite(sessionId, value) {
  const db = await idbOpen();
  if (!db || !sessionId || !value) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, sessionId);
      tx.oncomplete = () => { state.msgSavedAt = Number(value.savedAt) || Date.now(); resolve(true); };
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch { resolve(false); }
  });
}

/** 收到 reset / message 就回写，1 秒节流（流式期间别把磁盘写穿）。 */
function scheduleCacheSave() {
  if (state.cacheFailed) return;
  clearTimeout(state.cacheTimer);
  state.cacheTimer = setTimeout(() => {
    state.cacheTimer = 0;
    const sessionId = state.msgSession || state.sessionId;
    if (!sessionId) return;
    const payload = {
      cursor: state.msgCursor,
      messages: state.messages.filter((m) => !m.local || !m.pending).map((m) => ({
        seq: m.seq, at: m.at, role: m.role, kind: m.kind, text: m.text, rpcId: m.rpcId,
      })),
      savedAt: Date.now(),
    };
    void cacheWrite(sessionId, payload).then((ok) => { if (ok && state.msgFromCache) updateTranscriptNotes(); });
  }, CACHE_SAVE_MS);
}

/* ═════════ 本地回声 ═════════ */
function addLocalEcho(text, mode) {
  if (state.msgSession !== state.sessionId) { state.msgSession = state.sessionId; state.messages = []; }
  const local = {
    seq: 0, at: Date.now(), role: 'user', kind: 'message',
    text: String(text == null ? '' : text),
    rpcId: 'local-' + randKey(), pending: true, failed: false, local: true,
    mode: mode === 'steer' ? 'steer' : 'queue',
  };
  state.messages.push(local);
  if (state.msgState === 'unsupported') state.msgState = 'ready';
  renderTranscript();
  return local;
}

async function postPrompt(sessionId, text, mode, local) {
  const res = await write('api/prompt', { sessionId, text, mode: mode === 'steer' ? 'steer' : 'queue' }, {
    status: { 409: '会话正忙，插入被拒', 502: (r) => '上游出错：' + upstreamText(r) },
    offline: '连接断了，没发出去（点重发再试）',
    unknown: '发送失败',
  });
  if (res.status === 200) {
    const requestId = res.json && res.json.requestId ? String(res.json.requestId) : '';
    if (local) {
      // 换成服务端的 requestId：正式消息回吐时带着它，才能认出「是同一条」
      if (requestId) local.rpcId = requestId;
      local.pending = false;
      local.failed = false;
    }
    pollOnce();
  } else if (res.status !== 401 && local) {
    local.pending = false;
    local.failed = true;
  }
  renderTranscript();
  return res;
}

function retryLocal(local) {
  if (!local || local.pending) return Promise.resolve();
  const session = findSession(state.sessionId);
  if (!session) { toast('这个会话不在列表里了'); return Promise.resolve(); }
  local.pending = true;
  local.failed = false;
  local.at = Date.now();
  local.rpcId = 'local-' + randKey();
  renderTranscript();
  return postPrompt(session.id, local.text, local.mode || 'queue', local);
}

/* ═════════ 上传（断点续传 + 自适应块） ═════════ */
/* 服务端挂载点随版本不同（upload/ 或 api/upload/），404 时换一次再认。 */
function uploadPath(tail) { return state.uploadBase + tail; }

/** 原始 body 的 PUT：不能走 rpc（它会 JSON.stringify）。 */
async function rawPut(path, blob, onProgress) {
  let url;
  try { url = new URL(path, state.base); } catch { return { status: 0, json: null }; }
  const headers = { 'content-type': 'application/octet-stream' };
  if (state.token) headers.authorization = 'Bearer ' + state.token;
  try {
    const res = await fetch(url.href, {
      method: 'PUT', headers, body: blob, cache: 'no-store', credentials: 'same-origin',
    });
    let json = null;
    try { const text = await res.text(); if (text) { try { json = JSON.parse(text); } catch { json = null; } } } catch { json = null; }
    if (typeof onProgress === 'function') onProgress(res);
    return { status: res.status, json };
  } catch (err) {
    return { status: 0, json: null, error: String((err && err.message) || err) };
  }
}

async function uploadInit(file, requestId) {
  const body = { name: file.name, size: file.size, requestId };
  const original = state.uploadBase;
  let res = await rpc(uploadPath('init'), { method: 'POST', body });
  if (res.status === 404 && !state.uploadSlashed) {
    // 挂载点随版本不同：先试 upload/，404 再试 api/upload/，两次都不行就还原
    state.uploadSlashed = true;
    state.uploadBase = original === 'upload/' ? 'api/upload/' : 'upload/';
    res = await rpc(uploadPath('init'), { method: 'POST', body });
    if (res.status !== 200 || !res.json || !res.json.id) state.uploadBase = original;
  }
  if (res.status !== 200 || !res.json || !res.json.id) {
    const why = res.status === 0 ? '连不上' : 'HTTP ' + res.status;
    toast('上传没能开始（' + why + '）');
    return null;
  }
  return {
    id: String(res.json.id),
    offset: Number(res.json.offset) || 0,
    chunkSize: Math.max(UP_CHUNK_START, Number(res.json.chunkSize) || 1024 * 1024),
  };
}

async function uploadFile(file) {
  if (!file || state.uploadBusy) return;
  if (isRelay()) { toast('中继模式下不能上传，切回直连再试'); return; }
  const button = $('detail-upload');
  const label = button ? button.textContent : '';
  const paint = (text) => { if (button) button.textContent = text; };
  state.uploadBusy = true;
  if (button) button.disabled = true;
  try {
    paint('＋ 文件 0%');
    const ticket = await uploadInit(file, 'up-' + randKey());
    if (!ticket) return;
    const { id, chunkSize } = ticket;
    let offset = ticket.offset;
    let chunk = Math.min(UP_CHUNK_START, chunkSize);
    let guard = 0;
    while (offset < file.size && guard < 100000) {
      guard += 1;
      const slice = file.slice(offset, Math.min(offset + chunk, file.size));
      const started = Date.now();
      const res = await rawPut(uploadPath(id + '?offset=' + offset), slice);
      const spent = Date.now() - started;
      if (res.status === 200 && res.json && typeof res.json.offset === 'number') {
        offset = res.json.offset;
      } else if (res.status === 409 && res.json && res.json.error === 'offset') {
        // 断点续传：服务端说了算，按它给的 offset 接着传
        offset = Number(res.json.offset) || 0;
      } else if (res.status === 409 && res.json && res.json.error === 'already-done') {
        break;
      } else {
        toast('上传中断（' + (res.status === 0 ? '断线' : 'HTTP ' + res.status) + '）');
        return;
      }
      // 自适应块大小：快了翻倍，慢了减半，上下都有闸
      if (spent < UP_FAST_MS) chunk = Math.min(chunkSize, chunk * 2);
      else if (spent > UP_SLOW_MS) chunk = Math.max(UP_CHUNK_MIN, Math.floor(chunk / 2));
      paint('＋ 文件 ' + Math.round((offset / Math.max(1, file.size)) * 100) + '%');
    }
    const fin = await rpc(uploadPath(id + '/finish'), { method: 'POST' });
    if (fin.status === 200 && fin.json && fin.json.path) {
      const area = $('detail-text');
      if (area) {
        const current = String(area.value || '');
        area.value = (current ? current.replace(/\s+$/, '') + ' ' : '') + String(fin.json.path);
        try { area.focus(); } catch { /* ignore */ }
      }
      toast('已上传，路径已填入');
    } else {
      toast('收尾失败（' + (fin.status === 0 ? '断线' : 'HTTP ' + fin.status) + '）');
    }
  } finally {
    state.uploadBusy = false;
    paint(label || '＋ 文件');
    if (button) button.disabled = false;
  }
}

/* ═════════ 诊断 / 自动找电脑 / 配对码预填 ═════════ */
function openDiag() {
  if (!state.token) return toast('先配对');
  try {
    const url = new URL('api/diag', state.base);
    url.searchParams.set('download', '1');
    url.searchParams.set('pocket', state.token);
    window.open(url.toString(), '_blank', 'noopener');
  } catch { toast('地址不对，检查设置里的桌面地址'); }
}

function nowPort() {
  if (state.base && state.base.port) return state.base.port;
  return location.port || (location.protocol === 'https:' ? '443' : '80');
}

function hostFor(address) {
  const text = String(address || '').trim();
  if (!text) return '';
  if (text.charAt(0) === '[' || text.indexOf(':') < 0) return text;
  return '[' + text + ']';   // IPv6 要加方括号才能拼 URL
}

/** 地址赛跑：谁先回 {ok:true} 用谁；单地址 3 秒超时。 */
function raceHealth(addresses, port, proto) {
  return new Promise((resolve) => {
    const list = addresses.filter(Boolean);
    if (!list.length) { resolve(null); return; }
    let settled = false;
    let left = list.length;
    for (const addr of list) {
      const href = proto + '//' + hostFor(addr) + (port ? ':' + port : '') + '/__pocket__/health';
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = setTimeout(() => { try { if (controller) controller.abort(); } catch { /* ignore */ } }, PROBE_TIMEOUT_MS);
      fetch(href, { cache: 'no-store', signal: controller ? controller.signal : undefined })
        .then((res) => { clearTimeout(timer); if (!res.ok) throw new Error('status'); return res.json(); })
        .then((json) => {
          if (settled) return;
          if (json && json.ok) { settled = true; resolve(addr); return; }
          throw new Error('not-pocket');
        })
        .catch(() => { clearTimeout(timer); })
        .finally(() => { left -= 1; if (left <= 0 && !settled) resolve(null); });
    }
  });
}

async function autoDetect() {
  if (state.probeBusy) return;
  const button = $('set-probe');
  const label = button ? button.textContent : '';
  state.probeBusy = true;
  if (button) { button.disabled = true; button.textContent = '探测中…'; }
  try {
    const res = await rpc('health');
    const list = res.status === 200 && res.json && Array.isArray(res.json.addresses)
      ? res.json.addresses.filter((a) => typeof a === 'string' && a)
      : [];
    if (!list.length) { toast('读不到地址列表，先手动填一次地址'); return; }
    const proto = state.base && state.base.protocol === 'https:' ? 'https:' : 'http:';
    const hit = await raceHealth(list, nowPort(), proto);
    if (!hit) { toast('这些地址都没回话（同一局域网？）'); return; }
    const next = normalizeBase(proto + '//' + hostFor(hit) + (nowPort() ? ':' + nowPort() : ''));
    if (!next) { toast('探测到的地址不合法'); return; }
    state.base = next;
    saveConfig();
    const field = $('set-base');
    if (field) field.value = displayBase(next);
    restartTransport();
    toast('已切到 ' + next.host);
  } finally {
    state.probeBusy = false;
    if (button) { button.disabled = false; button.textContent = label || '自动探测'; }
  }
}

/** `#code=123456` / `?code=123456` → 预填并聚焦配对码。 */
function prefillPairCode() {
  const source = String(location.hash || '') + '&' + String(location.search || '');
  const match = /(?:^|[#?&])code=(\d{6})/.exec(source);
  if (!match) return false;
  const input = $('pair-code');
  if (input) {
    input.value = match[1];
    try { input.focus(); } catch { /* ignore */ }
  }
  return true;
}

/* ═════════ 动作 ═════════ */
async function doPair(event) {
  if (event) event.preventDefault();
  setPairError('');

  const base = normalizeBase(($('pair-base') && $('pair-base').value) || location.origin);
  if (!base) return setPairError('服务器地址格式不对：要带 http:// 和端口');
  const code = String(($('pair-code') && $('pair-code').value) || '').replace(/\D/g, '');
  if (code.length !== 6) return setPairError('配对码是 6 位数字');
  const name = String(($('pair-name') && $('pair-name').value) || '').trim() || guessDeviceName();

  state.base = base;
  state.deviceName = name;
  const button = $('pair-submit');
  if (button) { button.disabled = true; button.textContent = '配对中…'; }
  try {
    const res = await rpc('pair', { method: 'POST', body: { code, name } });
    if (res.status === 200 && res.json && res.json.token) {
      state.token = String(res.json.token);
      state.deviceId = String(res.json.deviceId || '');
      state.deviceName = String(res.json.deviceName || name);
      setAuthCookie(state.token);
      saveConfig();
      if ($('pair-code')) $('pair-code').value = '';
      state.seenApprovals = Object.create(null);
      state.primed = false;
      navigate('list', { replace: true });
      startStream();
      pollOnce();
      return;
    }
    if (res.status === 401) {
      const left = res.json && typeof res.json.attemptsLeft === 'number' ? res.json.attemptsLeft : null;
      setPairError(left === null ? '配对码不对' : '配对码不对，还剩 ' + left + ' 次机会');
    } else if (res.status === 429) setPairError(lockText(res.json && res.json.retryAt));
    else if (res.status === 400) setPairError('请求格式不对（插件版本对不上？）');
    else if (res.status === 0) setPairError(isRelay() ? '中继没连上，检查中继地址和房间号' : '连不上服务器，检查地址、同一局域网、桌面是否在运行');
    else setPairError('配对失败（HTTP ' + res.status + '）');
  } finally {
    if (button) { button.disabled = false; button.textContent = '配对'; }
  }
}

function lockText(retryAt) {
  const at = Number(retryAt);
  if (!at) return '尝试次数过多，稍后再试';
  const seconds = Math.round((at < 1e12 ? at * 1000 : at) / 1000 - Date.now() / 1000);
  if (seconds <= 0) return '可以再试一次了';
  return seconds < 60 ? '尝试次数过多，' + seconds + ' 秒后再试' : '尝试次数过多，' + Math.ceil(seconds / 60) + ' 分钟后再试';
}

/** 直连时 EventSource 带不了 Authorization 头，补一个同源 cookie。 */
function setAuthCookie(token) {
  try { document.cookie = 'pocket-auth=' + encodeURIComponent(token) + '; Path=/; SameSite=Lax'; } catch { /* ignore */ }
}

/**
 * 打开电脑端的完整 DSH 界面（同一个反代，`?pocket=` 换 cookie）。
 *
 * 为什么留这个入口：PWA 只做「看状态 + 发指令 + 停任务」，历史和逐字流式输出
 * 在官方界面上是现成的。自己重画一遍既慢又容易和上游打架 —— 需要看细节就交给上游。
 */
function openGui() {
  if (!state.token) return toast('先配对');
  try {
    const url = new URL('../', state.base);   // /__pocket__/ → 站点根
    url.searchParams.set('pocket', state.token);
    window.open(url.toString(), '_blank', 'noopener');
  } catch {
    toast('地址不对，检查设置里的桌面地址');
  }
}

async function sendPrompt(mode) {
  const textarea = $('detail-text');
  if (!textarea) return;
  const text = String(textarea.value || '').trim();
  if (!text) { toast('先输入指令'); textarea.focus(); return; }
  const session = findSession(state.sessionId);
  if (!session) return toast('这个会话不在列表里了');
  const button = mode === 'steer' ? $('detail-steer') : $('detail-queue');
  const label = button ? button.textContent : '';
  if (button) { button.disabled = true; button.textContent = '发送中…'; }
  // 本地回声：先渲染再发，等服务端回执把 rpcId 换成 requestId（去重的钩子就在这）
  const local = addLocalEcho(text, mode);
  textarea.value = '';
  try {
    const res = await postPrompt(session.id, text, mode, local);
    if (res && res.status === 200) toast(mode === 'steer' ? '已打断并插入' : '已排队发送');
  } finally {
    if (button) { button.disabled = false; button.textContent = label; }
  }
}

function armCancel() {
  const button = $('detail-cancel');
  if (!button) return;
  clearTimeout(state.cancelArmed);
  if (button.dataset.armed === '1') {
    button.dataset.armed = '0';
    button.textContent = '停止';
    doCancel();
    return;
  }
  button.dataset.armed = '1';
  button.textContent = '再点一次停止';
  state.cancelArmed = setTimeout(() => { button.dataset.armed = '0'; button.textContent = '停止'; }, 3000);
}

function doCancel() {
  const session = findSession(state.sessionId);
  if (!session) return Promise.resolve();
  return write('api/cancel', { sessionId: session.id }, {
    ok: () => { toast('已请求停止'); pollOnce(); },
    unknown: '停止失败',
  });
}

function answerApproval(approvalId, decision) {
  return write('api/approval', { approvalId, decision }, {
    ok: () => toast(decision === 'allow' ? '已允许' : '已拒绝'),
    status: { 404: '这条审批已经过期或被桌面答掉了', 403: '桌面没开「手机上批准」，只能在电脑上答' },
    unknown: '操作失败',
  }).then((res) => { pollOnce(); return res; });
}

function quickSend(event) {
  if (event) event.preventDefault();
  const input = $('quick-input');
  if (!input) return Promise.resolve();
  const text = String(input.value || '').trim();
  const session = latestSession();
  if (!session) return toast('还没有会话');
  if (!text) return toast('先输入指令');
  input.value = '';
  return write('api/prompt', { sessionId: session.id, text, mode: 'queue' }, {
    ok: () => { toast('已发给 ' + sessionLabel(session)); pollOnce(); },
    status: { 409: '会话正忙，稍后再发', 502: (res) => '上游出错：' + upstreamText(res) },
    offline: '连接断了，没发出去（内容已保留）',
    unknown: '发送失败',
  }).then((res) => {
    if (res.status === 0 && input.value === '') input.value = text;   // 断线时把内容还回去
    return res;
  });
}

function onUnauthorized() {
  if (!state.token && state.view === 'connect') return;
  stopStream();
  state.token = '';
  lsDel('token');
  state.snapshot = emptySnapshot();
  state.primed = false;
  state.seenApprovals = Object.create(null);
  setLink('down');
  navigate('connect');
  setPairError('配对已失效，请重新配对');
  toast('配对已失效，请重新配对');
}

function restartTransport() {
  stopStream();
  state.primed = false;
  if (!state.token) return;
  startStream();
  pollOnce();
}

function saveSettings() {
  const base = normalizeBase(($('set-base') && $('set-base').value) || location.origin);
  if (!base) return toast('桌面地址格式不对');
  const name = String(($('set-name') && $('set-name').value) || '').trim() || guessDeviceName();
  const changed = !state.base || base.href !== state.base.href;
  state.base = base;
  state.deviceName = name;
  saveConfig();
  toast('已保存');
  if (changed) restartTransport();
}

function saveRelay() {
  const url = String(($('set-relay') && $('set-relay').value) || '').trim();
  const room = String(($('set-room') && $('set-room').value) || '').trim();
  if (url && !/^wss?:\/\//i.test(url)) return toast('中继地址要以 ws:// 或 wss:// 开头');
  if (Boolean(url) !== Boolean(room)) return toast('中继地址和房间号要么都填，要么都空');
  state.relayUrl = url;
  state.room = room;
  lsSet('relayUrl', url);
  lsSet('room', room);
  restartTransport();
  toast(url ? '已切到中继' : '已切回直连');
}

async function onNotifyToggle(event) {
  const on = Boolean(event.target.checked);
  state.notify = on;
  lsSet('notify', on ? '1' : '0');
  if (!on) return;
  if (typeof Notification === 'undefined') return toast('这个浏览器不支持通知');
  if (Notification.permission === 'default') {
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') toast('通知权限没给，页内仍会显示审批');
    } catch { toast('通知权限申请失败'); }
  } else if (Notification.permission === 'denied') {
    toast('通知权限被拒绝，需要到浏览器设置里手动打开');
  }
}

function signOut() {
  stopStream();
  for (const key of LS_KEYS) lsDel(key);
  state.token = '';
  state.deviceId = '';
  state.deviceName = '';
  state.relayUrl = '';
  state.room = '';
  state.snapshot = emptySnapshot();
  state.events = [];
  state.seenApprovals = Object.create(null);
  state.primed = false;
  state.sessionId = null;
  state.base = normalizeBase(location.origin);
  try { document.cookie = 'pocket-auth=; Path=/; Max-Age=0'; } catch { /* ignore */ }
  navigate('connect', { replace: true });
  updateConnect();
  toast('已退出配对');
}

/* ═════════ 兜底 / SW ═════════ */
function installGlobalErrors() {
  window.addEventListener('error', (event) => {
    if (event && event.message) toast('页面出错：' + event.message, 4000);
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event && event.reason;
    toast('页面出错：' + String((reason && reason.message) || reason || '未知'), 4000);
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // http://（局域网 IP）下浏览器拒绝注册，静默忽略
  try { navigator.serviceWorker.register('./sw.js').catch(() => {}); } catch { /* ignore */ }
}

/* ═════════ 绑定 ═════════ */
function bindEvents() {
  const on = (id, type, fn) => { const node = $(id); if (node) node.addEventListener(type, fn); };

  on('pair-form', 'submit', doPair);
  on('pair-code', 'input', (event) => {
    const input = event.target;
    const digits = String(input.value || '').replace(/\D/g, '').slice(0, 6);
    if (input.value !== digits) input.value = digits;
  });
  on('list-refresh', 'click', () => {
    toast('刷新中…', 900);
    pollOnce();
    if (!isRelay() && !state.es) openSSE();
  });
  on('list-settings', 'click', () => navigate('settings'));
  on('quick-form', 'submit', quickSend);
  on('detail-back', 'click', () => navigate('list'));
  on('detail-queue', 'click', () => sendPrompt('queue'));
  on('detail-steer', 'click', () => sendPrompt('steer'));
  on('detail-cancel', 'click', armCancel);
  on('detail-log-toggle', 'click', toggleLog);
  on('detail-gui', 'click', openGui);
  on('set-gui', 'click', openGui);
  on('detail-text', 'keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); sendPrompt('queue'); }
  });
  on('set-save', 'click', saveSettings);
  on('set-relay-save', 'click', saveRelay);
  on('set-notify', 'change', onNotifyToggle);
  on('set-signout', 'click', signOut);
  on('set-probe', 'click', autoDetect);
  on('set-diag', 'click', openDiag);
  on('detail-upload', 'click', () => {
    const input = $('detail-file');
    if (!input) return;
    try { input.value = ''; } catch { /* ignore */ }
    input.click();
  });
  on('detail-file', 'change', (event) => {
    const files = event && event.target && event.target.files;
    const file = files && files[0];
    if (file) void uploadFile(file);
  });

  window.addEventListener('hashchange', syncFromHash);
  window.addEventListener('popstate', syncFromHash);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !state.token) return;
    pollOnce();
    // iOS 一切到后台就掐 SSE；回到前台时内容会停在断线那一刻，补一次全量（有缓存也不会白屏）
    if (state.view === 'detail' && state.sessionId && state.link !== 'live') void loadTranscript(state.sessionId);
  });
  // 直连时 SSE 退化到轮询后，每分钟试一次能不能回到 SSE
  setInterval(() => {
    if (state.token && !isRelay() && !state.es && state.link !== 'live') openSSE();
    if (state.token && state.view === 'detail' && state.sessionId && state.link !== 'live') void loadTranscript(state.sessionId);
  }, 60000);
}

/* ═════════ 启动 ═════════ */
function boot() {
  loadConfig();
  installGlobalErrors();
  bindEvents();
  // views.js 自己接管渲染与事件；这里不重复接线
  registerServiceWorker();
  // 扫来的配对码优先：`#code=123456` / `?code=123456` 直接进连接屏并聚焦
  const hasCode = prefillPairCode();
  if (hasCode) navigate('connect', { replace: true });
  else if (location.hash) syncFromHash();
  else navigate(state.token ? 'home' : 'connect', { replace: true });
  if (!state.token) { updateConnect(); return; }
  setAuthCookie(state.token);
  startStream();
  pollOnce();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();