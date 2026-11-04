// 手机的 API 面：会话快照、发指令、停任务、审批、SSE 推送、PWA 静态文件。
//
// 设计取舍：
//   · 手机只认**一个全量快照**（/api/state）+ 一条 SSE。不做增量协议 ——
//     增量协议一旦丢帧就要写补丁逻辑，而手机上行就是手机网络，丢帧是常态。
//   · 会话状态用轮询上游 `session/list`（3 秒）而不是订阅 `/api/remote.mux`：
//     多一条 WebSocket 就多一种断线重连要调，而这是本地回环的 3 KB 请求。
//     `approval/request` 是**进程内**事件，能直接挂，不需要那条 WS。
//   · 静态外壳（index.html/app.js/…）免鉴权 —— 不然后第一次打开就 401，
//     用户永远看不到配对界面。
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { createGate } from './gate.mjs';

const MOUNT = '/__pocket__';
const BODY_LIMIT = 64 * 1024;
const POLL_MS = 3000;
const HEARTBEAT_MS = 15000;
const RESOLVED_KEEP = 20;

const MIME = {
  'index.html': 'text/html; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'style.css': 'text/css; charset=utf-8',
  'sw.js': 'text/javascript; charset=utf-8',
  'manifest.webmanifest': 'application/manifest+json; charset=utf-8',
};

const SHELL = new Set(Object.keys(MIME));

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

/**
 * 读原始字节（上传块用）。超限返回 null —— 让调用方回 413，而不是把内存吃光。
 * @returns {Promise<Buffer|null>}
 */
function readRaw(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.alloc(0)));
  });
}

/**
 * @param {{
 *   store: ReturnType<import('./store.mjs').createStore>,
 *   upstream: ReturnType<import('./upstream.mjs').createUpstream>,
 *   pwaDir: string,
 *   config: {approvals?: string, approvalTimeoutMs?: number},
 *   log: (msg: string) => void,
 * }} options
 */
export function createPocket(options) {
  const { store, upstream, pwaDir, config } = options;
  const log = options.log ?? (() => {});
  const diag = options.diag ?? null;
  const loop = options.loop ?? null;
  const uploads = options.uploads ?? null;
  const follow = options.follow ?? null;
  const addresses = typeof options.addresses === 'function' ? options.addresses : () => [];
  const relayStatus = typeof options.relayStatus === 'function' ? options.relayStatus : () => null;
  const gate = createGate({ store, log });
  const approvalAnswer = config.approvals === 'answer';
  const approvalTimeoutMs = Number(config.approvalTimeoutMs) > 0 ? Number(config.approvalTimeoutMs) : 45000;
  const startedAt = Date.now();

  /** @type {Set<import('node:http').ServerResponse>} SSE 客户端 */
  const clients = new Set();
  /** @type {Map<import('node:http').ServerResponse, Set<string>>} 每个 SSE 客户端正在看的会话 */
  const watching = new Map();
  /** @type {Map<string, number>} 会话 → 最近活动时间戳 */
  const activity = new Map();
  /** @type {Map<string, {id: string, sessionId: string|null, tool: string, reason: string, createdAt: number, resolve: (decision: string|null) => void}>} */
  const approvals = new Map();
  /** @type {Array<{id: string, outcome: string, at: number}>} */
  const resolved = [];

  let snapshot = {
    now: Date.now(),
    sessions: [],
    approvals: [],
    devices: [],
    capabilities: { approvalAnswer, sync: Boolean(follow) },
    upstreamError: null,
  };
  let lastFetchAt = 0;
  let inFlight = null;
  let poller = null;
  let heartbeat = null;

  // ── 快照 ──────────────────────────────────────────────────────────────

  function pendingOf(sessionId) {
    return [...approvals.values()]
      .filter((it) => it.sessionId === sessionId)
      .map((it) => ({ id: it.id, tool: it.tool, reason: it.reason, createdAt: it.createdAt }));
  }

  function normalize(item) {
    const id = String(item?.sessionId ?? '');
    const updatedAt = Number(item?.updatedAt ?? 0) || null;
    return {
      id,
      short: id.replace(/^session-/, '').slice(0, 8),
      running: Boolean(item?.running),
      agentAvailable: Boolean(item?.agentAvailable),
      updatedAt,
      lastActivityAt: activity.get(id) ?? updatedAt,
      cwd: item?.cwd ?? null,
      title: null, // dsh 的 session/list 不带标题；不为一个标题去激活会话
      parent: item?.parentSessionId ?? null,
      origin: item?.origin ?? null,
      approvals: pendingOf(id),
    };
  }

  function rebuild(items) {
    const sessions = (items ?? []).map(normalize);
    snapshot = {
      now: Date.now(),
      sessions,
      approvals: [...approvals.values()].map((it) => ({ id: it.id, sessionId: it.sessionId, tool: it.tool, reason: it.reason, createdAt: it.createdAt })),
      devices: store.devices,
      capabilities: { approvalAnswer, sync: Boolean(follow) },
      upstreamError: snapshot.upstreamError,
    };
    return snapshot;
  }

  /** 拉一次上游状态；同一时刻只发一个请求（手机反复刷新不会把上游打爆）。 */
  function refresh(force = false) {
    if (inFlight) return inFlight;
    if (!force && Date.now() - lastFetchAt < 900) return Promise.resolve(snapshot);
    inFlight = (async () => {
      const res = await upstream.rpc('session/list', { _request: {} });
      if (res.ok) {
        snapshot.upstreamError = null;
        rebuild(res.value?.items ?? []);
      } else {
        snapshot.upstreamError = { code: res.error?.code ?? 'error', message: res.error?.message ?? '' };
        snapshot = { ...snapshot, now: Date.now(), devices: store.devices, upstreamError: snapshot.upstreamError };
        log(`pocket: session/list failed — ${snapshot.upstreamError.code}`);
      }
      lastFetchAt = Date.now();
      return snapshot;
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  // ── 推送 ──────────────────────────────────────────────────────────────

  function writeEvent(res, name, data) {
    try {
      res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      clients.delete(res);
    }
  }

  function pushState() {
    for (const res of clients) writeEvent(res, 'state', snapshot);
  }

  function pushEvent(name, data) {
    for (const res of clients) writeEvent(res, name, data);
  }

  function ensurePoller() {
    if (poller) return;
    poller = setInterval(() => {
      if (clients.size > 0) void refresh(true).then(pushState);
    }, POLL_MS);
    poller.unref?.();
    heartbeat = setInterval(() => {
      for (const res of clients) {
        try {
          res.write(': ping\n\n');
        } catch {
          clients.delete(res);
        }
      }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
  }

  // ── 审批 ──────────────────────────────────────────────────────────────

  /**
   * 登记一条待审批请求（由 index.js 的进程内钩子调用）。
   * 返回的 `resolve` 由三处之一调用：手机、超时、会话中止。
   */
  function noteApproval(info) {
    const id = randomUUID().slice(0, 8);
    const ttl = Number(info.ttl) > 0 ? Number(info.ttl) : approvalTimeoutMs;
    const entry = {
      id,
      sessionId: info.sessionId ?? null,
      tool: String(info.tool ?? 'ai').slice(0, 40),
      reason: String(info.reason ?? '').slice(0, 300),
      createdAt: Date.now(),
      resolve: info.resolve,
      timer: null,
    };
    // 展示窗：桌面端答完之后插件并不知道（那是另一条 waterfall 分支），
    // 所以这里给一个上限，避免手机永远挂着一条已经结束的审批。
    entry.timer = setTimeout(() => settle(id, 'unavailable'), ttl);
    entry.timer.unref?.();
    approvals.set(id, entry);
    snapshot = { ...snapshot, now: Date.now(), approvals: [...approvals.values()].map((it) => ({ id: it.id, sessionId: it.sessionId, tool: it.tool, reason: it.reason, createdAt: it.createdAt })) };
    pushEvent('approval', { id, sessionId: entry.sessionId, tool: entry.tool, reason: entry.reason, createdAt: entry.createdAt, state: 'pending' });
    if (clients.size > 0) void refresh(true).then(pushState);
    return entry;
  }

  function settle(id, outcome) {
    const entry = approvals.get(id);
    if (!entry) return false;
    approvals.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    resolved.unshift({ id, outcome, at: Date.now() });
    if (resolved.length > RESOLVED_KEEP) resolved.pop();
    try {
      entry.resolve?.(outcome);
    } catch {
      /* 上游已经不等了 */
    }
    pushEvent('approval-resolved', { id, outcome });
    snapshot = { ...snapshot, now: Date.now(), approvals: [...approvals.values()].map((it) => ({ id: it.id, sessionId: it.sessionId, tool: it.tool, reason: it.reason, createdAt: it.createdAt })) };
    if (clients.size > 0) void refresh(true).then(pushState);
    return true;
  }

  // ── 静态外壳 ──────────────────────────────────────────────────────────

  function serveShell(req, res, name) {
    const file = join(pwaDir, name);
    let fd = -1;
    try {
      const stat = statSync(file);
      fd = openSync(file, 'r');
      const buf = Buffer.alloc(stat.size);
      readSync(fd, buf, 0, stat.size, 0);
      res.writeHead(200, {
        'content-type': MIME[name],
        'content-length': buf.length,
        'cache-control': name === 'sw.js' ? 'no-cache' : 'no-store',
      });
      res.end(buf);
      return true;
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`dsh-pocket: missing ${name} (PWA 未随包安装？)`);
      return false;
    } finally {
      if (fd >= 0) closeSync(fd);
    }
  }

  // ── 路由 ──────────────────────────────────────────────────────────────

  async function route(req, res, url) {
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (path === MOUNT) {
      res.writeHead(308, { location: `${MOUNT}/` });
      res.end();
      return true;
    }

    if (path === `${MOUNT}/health`) {
      const ready = await upstream.ready();
      json(res, 200, {
        ok: true,
        name: 'dsh-pocket',
        version: '0.2.0',
        uptimeMs: Date.now() - startedAt,
        paired: store.paired,
        upstream: { port: upstream.port, ready, failures: upstream.failures ?? 0 },
        transport: { lan: true, relay: relayStatus() },
        // 手机连不上时用来「自动找电脑」：把本机所有可达地址全给它，让手机自己赛跑
        addresses: addresses(),
        loop: loop ? loop.status() : { enabled: false, any: false, ports: [] },
        sync: follow ? follow.status() : null,
        upload: uploads ? uploads.status() : null,
        diag: diag ? diag.count : 0,
      });
      return true;
    }

    if (path === `${MOUNT}/pair` && method === 'POST') {
      const body = await readBody(req);
      if (!body) return json(res, 400, { error: 'bad-request' }), true;
      const result = store.pair(body.code, body.name);
      if (result.ok) {
        diag?.note(1, store.devices.length, 0);
        log(`pocket: device paired — ${result.deviceName}`);
        json(res, 200, { token: result.token, deviceId: result.deviceId, deviceName: result.deviceName });
      } else if (result.error === 'bad-code') {
        diag?.note(2, 401, result.attemptsLeft ?? 0);
        json(res, 401, { error: 'bad-code', attemptsLeft: result.attemptsLeft });
      } else if (result.error === 'locked') {
        json(res, 429, { error: 'locked', retryAt: result.retryAt });
      } else {
        json(res, 400, { error: 'bad-request' });
      }
      return true;
    }

    // 静态外壳（免鉴权，理由见文件头）
    if (method === 'GET') {
      if (path === `${MOUNT}/` || path === `${MOUNT}/index.html`) return serveShell(req, res, 'index.html') || true;
      const name = path.slice(`${MOUNT}/`.length);
      if (SHELL.has(name)) return serveShell(req, res, name) || true;
    }

    // 以下全部需要令牌
    const auth = gate.authorize(req, url);
    if (!auth.ok || !auth.device) {
      diag?.note(3, 401, 1);
      json(res, 401, { error: 'unauthorized' });
      return true;
    }

    if (path === `${MOUNT}/api/state` && method === 'GET') {
      const snap = await refresh(url.searchParams.get('force') === '1');
      json(res, 200, snap);
      return true;
    }

    if (path === `${MOUNT}/api/stream` && method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(': hello\n\n');
      clients.add(res);
      watching.set(res, new Set());
      diag?.note(19, clients.size, 0);
      ensurePoller();
      void refresh(true).then(() => writeEvent(res, 'state', snapshot));

      // `?session=<id>`：手机进会话时订阅内容同步，并立刻回一份快照（reset）
      const wantSession = url.searchParams.get('session');
      if (wantSession && follow) {
        watching.get(res).add(wantSession);
        void follow
          .read(wantSession, { waitMs: 800 })
          .then((body) => writeEvent(res, 'reset', body))
          .catch((err) => diag?.note(26, 3, 0) && log(`pocket: session sync failed — ${err?.message ?? err}`));
      }

      req.on('close', () => {
        clients.delete(res);
        watching.delete(res);
        diag?.note(20, clients.size, 0);
      });
      return true;
    }

    if (path === `${MOUNT}/api/prompt` && method === 'POST') {
      const body = await readBody(req);
      if (!body || typeof body.sessionId !== 'string' || typeof body.text !== 'string' || !body.text.trim()) {
        json(res, 400, { error: 'bad-request' });
        return true;
      }
      const requestId = randomUUID();
      const res2 = await upstream.rpc('session/prompt', {
        request: {
          requestId,
          sessionId: body.sessionId,
          mode: body.mode === 'steer' ? 'steer' : 'queue',
          content: [{ type: 'text', text: body.text }],
        },
      });
      if (res2.ok) {
        diag?.note(7, String(body.mode ?? 'queue') === 'steer' ? 2 : 1, body.text.length);
        log(`pocket: prompt accepted for ${body.sessionId}`);
        json(res, 200, { accepted: true, requestId });
      } else if (String(res2.error?.code ?? '').includes('agent-busy')) {
        diag?.note(8, 409, 0);
        json(res, 409, { error: 'agent-busy' });
      } else {
        json(res, 502, { error: 'upstream', detail: res2.error?.code ?? 'error', message: String(res2.error?.message ?? '').slice(0, 200) });
      }
      return true;
    }

    if (path === `${MOUNT}/api/cancel` && method === 'POST') {
      const body = await readBody(req);
      if (!body || typeof body.sessionId !== 'string') {
        json(res, 400, { error: 'bad-request' });
        return true;
      }
      const res2 = await upstream.rpc('session/cancel', { request: { sessionId: body.sessionId } });
      if (res2.ok) {
        diag?.note(9, 1, 0);
        log(`pocket: cancel accepted for ${body.sessionId}`);
        json(res, 200, { ok: true });
      } else {
        json(res, 502, { error: 'upstream', detail: res2.error?.code ?? 'error' });
      }
      return true;
    }

    if (path === `${MOUNT}/api/approval` && method === 'POST') {
      const body = await readBody(req);
      if (!body || typeof body.approvalId !== 'string') {
        json(res, 400, { error: 'bad-request' });
        return true;
      }
      if (!approvalAnswer) {
        json(res, 403, { error: 'approval-answer-disabled' });
        return true;
      }
      const ok = settle(body.approvalId, body.decision === 'deny' ? 'rejected' : 'allowed-once');
      json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'gone' });
      return true;
    }

    // ── 会话内容同步 ────────────────────────────────────────────────
    // GET /__pocket__/api/session/<id>/messages —— 手机拉一次全量（首次会等快照）
    // 用前缀/后缀切，不用正则：路径里有斜杠，正则转义写错一次就会炸在启动时。
    const SESSION_PREFIX = `${MOUNT}/api/session/`;
    const SUFFIX = '/messages';
    const messageMatch =
      path.startsWith(SESSION_PREFIX) && path.endsWith(SUFFIX) && path.length > SESSION_PREFIX.length + SUFFIX.length
        ? decodeURIComponent(path.slice(SESSION_PREFIX.length, -SUFFIX.length))
        : null;
    if (messageMatch && method === 'GET') {
      if (!follow) {
        json(res, 404, { error: 'not-found' });
        return true;
      }
      const body = await follow.read(messageMatch, { waitMs: Number(url.searchParams.get('wait')) || 1500 });
      json(res, 200, body);
      return true;
    }

    // ── 诊断（只有数字码，可以整包导出） ──────────────────────────────
    if (path === `${MOUNT}/api/diag` && method === 'GET') {
      if (!diag) {
        json(res, 404, { error: 'not-found' });
        return true;
      }
      if (url.searchParams.get('download') === '1') {
        const text = diag.text();
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': `attachment; filename="dsh-pocket-diag-${Date.now()}.jsonl"`,
          'content-length': Buffer.byteLength(text),
          'cache-control': 'no-store',
        });
        res.end(text);
        return true;
      }
      json(res, 200, diag.snapshot());
      return true;
    }

    // ── 回环穿透（页面里的 127.0.0.1:<port> 请求） ────────────────────
    if (loop && path.startsWith(`${MOUNT}/loop/`)) {
      return loop.handle(req, res, url);
    }

    // ── 断点续传 ─────────────────────────────────────────────────────
    if (uploads && path.startsWith(`${MOUNT}/upload`)) {
      const rest = path.slice(`${MOUNT}/upload`.length);

      if ((rest === '/init' || rest === '/init/') && method === 'POST') {
        const body = await readBody(req);
        if (!body) {
          json(res, 400, { error: 'bad-request' });
          return true;
        }
        const result = uploads.init(body, auth.device.id);
        json(res, result.status, result.body);
        return true;
      }

      const match = /^\/([A-Za-z0-9_-]{6,32})(\/finish)?$/.exec(rest);
      if (!match) {
        json(res, 404, { error: 'not-found' });
        return true;
      }
      const id = match[1];

      if (method === 'GET' && !match[2]) {
        const result = uploads.get(id);
        json(res, result.status, result.body);
        return true;
      }

      if (method === 'PUT' && !match[2]) {
        const chunk = await readRaw(req, 8 * 1024 * 1024);
        if (!chunk) {
          json(res, 413, { error: 'chunk-too-large' });
          return true;
        }
        const result = await uploads.writeChunk(id, url.searchParams.get('offset'), chunk);
        json(res, result.status, result.body);
        return true;
      }

      if (method === 'POST' && match[2]) {
        const result = await uploads.finish(id);
        json(res, result.status, result.body);
        return true;
      }

      json(res, 405, { error: 'method' });
      return true;
    }

    json(res, 404, { error: 'not-found' });
    return true;
  }

  // 把同步事件扇给「正在看这个会话」的 SSE 客户端
  let offFollow = null;
  if (follow) {
    offFollow = follow.on((kind, payload) => {
      for (const [res, set] of watching) {
        if (!set.has(payload.sessionId)) continue;
        if (kind === 'message') writeEvent(res, 'message', payload);
        else if (kind === 'delta') writeEvent(res, 'delta', payload);
        else if (kind === 'reset') writeEvent(res, 'reset', payload);
        else if (kind === 'error') writeEvent(res, 'sync-error', payload);
      }
    });
  }

  return {
    /** @returns {boolean} 是否已由本模块处理（false = 交给反代） */
    handle(req, res) {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (!url.pathname.startsWith(MOUNT)) return false;
      route(req, res, url).catch((err) => {
        log(`pocket: route failed — ${err?.message ?? err}`);
        try {
          json(res, 500, { error: 'internal', message: String(err?.message ?? err) });
        } catch {
          /* 连接已断 */
        }
      });
      return true;
    },
    authorize: gate.authorize,
    noteApproval,
    settle,
    noteActivity(sessionId, at) {
      activity.set(String(sessionId), Number(at) || Date.now());
      if (clients.size > 0) void refresh(true).then(pushState);
    },
    invalidate() {
      lastFetchAt = 0;
      if (clients.size > 0) void refresh(true).then(pushState);
    },
    state: () => snapshot,
    async shutdown() {
      try {
        offFollow?.();
      } catch {
        /* ignore */
      }
      if (poller) clearInterval(poller);
      if (heartbeat) clearInterval(heartbeat);
      poller = null;
      heartbeat = null;
      for (const res of clients) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
      clients.clear();
      for (const entry of approvals.values()) {
        try {
          entry.resolve?.(null);
        } catch {
          /* ignore */
        }
      }
      approvals.clear();
    },
    get pendingCount() {
      return approvals.size;
    },
    approvalAnswer,
    approvalTimeoutMs,
  };
}