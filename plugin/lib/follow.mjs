// 双端同步的桌面半边：把电脑上某个会话的**记录与内容**持续同步到手机上，
// 并把手机上的输入落回同一个会话。
//
// ## 同步模型（关键取舍）
//
// 「双端同步」在这里**不是**两份存储互相覆盖，而是：
//
//   电脑是唯一真相源（DSH 的会话日志在电脑上），手机是**镜像 + 输入口**。
//
// 理由：手机没有 dsh 引擎，也没有模型凭据；一旦允许两边各自追加，合并两份
// 时间线就成了不可判定问题（这正是 `TZYCeng/dsh-android-Conversation-sync`
// 那套「改 cwd / 搬目录 / 只增不减合并」要处理的一整类麻烦）。
// 所以：
//   · **下行**：插件订阅上游 `session/follow`，把快照 + 增量事件归一成消息，推给手机；
//     手机本地缓存一份，离线可读。
//   · **上行**：手机发 prompt 时带客户端生成的 `requestId`，上游把这条消息记进日志后
//     会带着同一个 `source.rpcId` 回吐；手机据此把「本地回声」替换成正式消息。
//     于是「自己发的」不会出现两条，另一台设备发的也会原样出现。
//
// ## 帧形状（实测 dsh 0.2.0-rc.2）
//
// 客户端 → `ws /api/remote.mux`（必须带 dsh 的会话 cookie）：
//   {"type":"open","streamId":"f1","endpoint":"session/follow",
//    "payload":{"args":{"request":{"address":{"kind":"session","sessionId":"…"},
//              "assistantStream":true,"maxMessages":30}}}}
// 服务端 → 客户端：
//   {"type":"item","streamId":"f1","value":{"type":"snapshot","header":{…},"cursor":5,
//      "records":[{"type":"event","event":{"type":"user/message","seq":8,"time":…,
//        "data":{"content":[{"type":"text","text":"…"}],"role":"user",
//                "source":{"kind":"user","rpcId":"…"},"id":"…"}}}]}}
//   {"type":"item","streamId":"f1","value":{"type":"event","event":{…}}}
//   {"type":"item","streamId":"f1","value":{"type":"assistant-stream","frame":{…}}}
import { wsConnect } from './ws-client.mjs';

const DEFAULT_MAX = 40;
const IDLE_MS = 5 * 60 * 1000;
const RECONNECT_MAX = 30000;

/** 从一段 content / message / text 里尽力取出可见文本。 */
export function extractText(value, depth = 0) {
  if (value == null || depth > 4) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((it) => extractText(it, depth + 1))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text;
  if (value.content !== undefined) return extractText(value.content, depth + 1);
  if (value.message !== undefined) {
    const inner = extractText(value.message, depth + 1);
    if (inner) return inner;
  }
  if (Array.isArray(value.parts)) return extractText(value.parts, depth + 1);
  return '';
}

/** 这些 source 是给模型看的上下文，不是人打的字 —— 手机上不展示。 */
const HIDDEN_SOURCES = new Set(['runtime-context', 'system', 'instruction', 'skill', 'system-reminder', 'reminder']);

/**
 * 以这些标签开头的「用户消息」是运行时注入的提醒（skill 清单、上下文快照……），
 * 在日志里角色是 user，但不是人打的字。手机上显示它们只会把真正的对话顶走。
 */
const INJECTED_PREFIXES = ['<system-reminder', '<skill', '<runtime-context', '<available-skills'];

/**
 * 把一条 DSH 事件归一成手机能显示的消息；不显示就返回 null。
 * 字段名跨版本可能变，所以这里全部走「有就用、没有就退」。
 */
export function normalizeEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const type = String(event.type ?? '');
  const data = event.data ?? {};
  const sourceKind = String(data.source?.kind ?? data.sourceKind ?? '');

  // 明确的非对话事件：跳过。`system/message` 是系统提示词整段（几 KB），
  // 推给手机既没用又费流量。
  if (type === 'system/message' || type === 'step/start' || type === 'step/end') return null;
  if (HIDDEN_SOURCES.has(sourceKind)) return null;

  const role = String(data.role ?? (type.includes('assistant') ? 'assistant' : type.includes('user') ? 'user' : ''));
  const text = extractText(data.content ?? data.message ?? data.text).trim();
  const lowered = text.slice(0, 40).toLowerCase();
  if (INJECTED_PREFIXES.some((prefix) => lowered.startsWith(prefix))) return null;
  const tool = String(data.toolName ?? data.name ?? data.tool ?? '');
  const isTool = /tool/i.test(type) && tool;

  if (!text && !isTool) return null;

  return {
    seq: Number(event.seq ?? 0),
    at: Number(event.time ?? Date.now()),
    role: role === 'assistant' ? 'assistant' : role === 'user' ? 'user' : isTool ? 'tool' : 'other',
    kind: isTool ? 'tool' : 'message',
    text: isTool ? `[${tool}]` : text,
    rpcId: String(data.source?.rpcId ?? ''),
    eventType: type,
  };
}

/**
 * @param {{
 *   upstream: ReturnType<import('./upstream.mjs').createUpstream>,
 *   diag?: ReturnType<import('./diag.mjs').createDiag>,
 *   log?: (msg: string) => void,
 *   maxMessages?: number,
 * }} options
 */
export function createFollow(options) {
  const { upstream } = options;
  const diag = options.diag ?? null;
  const log = options.log ?? (() => {});
  const maxMessages = Number(options.maxMessages) > 0 ? Number(options.maxMessages) : DEFAULT_MAX;
  // 传输可注入：单测用假 socket 打状态机，生产走真 WS（上游要 cookie，标准 API 传不了头）
  const connect = typeof options.connect === 'function' ? options.connect : wsConnect;

  /** @type {Map<string, {id:string, messages:any[], cursor:number, streaming:string, streamId:string|null, touched:number, timer:any}>} */
  const sessions = new Map();
  /** @type {Set<(kind: string, payload: any) => void>} */
  const listeners = new Set();

  let socket = null;
  let connecting = null;
  let tries = 0;
  let seq = 0;
  let stopped = false;
  let retryTimer = null;

  function emit(kind, payload) {
    for (const fn of listeners) {
      try {
        fn(kind, payload);
      } catch (err) {
        log(`follow: listener failed — ${err?.message ?? err}`);
      }
    }
  }

  function trim(state) {
    if (state.messages.length > maxMessages * 2) state.messages.splice(0, state.messages.length - maxMessages * 2);
  }

  function stateOf(sessionId) {
    let state = sessions.get(sessionId);
    if (!state) {
      state = { id: sessionId, messages: [], cursor: 0, streaming: '', streamId: null, touched: Date.now(), timer: null };
      sessions.set(sessionId, state);
    }
    state.touched = Date.now();
    return state;
  }

  function byStream(streamId) {
    for (const state of sessions.values()) if (state.streamId === streamId) return state;
    return null;
  }

  function openStream(state) {
    if (!socket || socket.readyState !== 1) return;
    seq += 1;
    state.streamId = `f${seq}`;
    socket.send(
      JSON.stringify({
        type: 'open',
        streamId: state.streamId,
        endpoint: 'session/follow',
        payload: {
          args: {
            request: {
              address: { kind: 'session', sessionId: state.id },
              assistantStream: true,
              maxMessages,
            },
          },
        },
      }),
    );
  }

  function handleFrame(raw) {
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (frame?.type === 'error') {
      log(`follow: upstream error — ${frame.error?.code ?? 'unknown'}`);
      diag?.note(26, 1, 0);
      emit('error', { code: String(frame.error?.code ?? ''), message: String(frame.error?.message ?? '').slice(0, 200) });
      return;
    }
    if (frame?.type !== 'item') return;
    const state = byStream(String(frame.streamId ?? ''));
    if (!state) return;
    const value = frame.value ?? {};

    if (value.type === 'snapshot') {
      state.messages = [];
      for (const record of value.records ?? []) {
        const message = normalizeEvent(record?.event ?? record);
        if (message) state.messages.push(message);
      }
      trim(state);
      state.cursor = Number(value.cursor ?? 0);
      state.streaming = '';
      diag?.note(24, state.messages.length, state.cursor);
      emit('reset', { sessionId: state.id, cursor: state.cursor, messages: state.messages });
      return;
    }

    if (value.type === 'event') {
      const message = normalizeEvent(value.event);
      state.cursor = Math.max(state.cursor, Number(value.event?.seq ?? 0));
      if (!message) return;
      state.messages.push(message);
      trim(state);
      diag?.note(25, message.role === 'assistant' ? 2 : message.role === 'user' ? 1 : 0, message.text.length);
      emit('message', { sessionId: state.id, cursor: state.cursor, message });
      return;
    }

    if (value.type === 'assistant-stream') {
      const frameValue = value.frame ?? {};
      if (frameValue.type === 'chunk') {
        const chunk = frameValue.chunk ?? {};
        const piece = typeof chunk === 'string' ? chunk : chunk.text ?? chunk.delta ?? '';
        if (typeof piece === 'string' && piece) {
          state.streaming += piece;
          if (state.streaming.length > 40000) state.streaming = state.streaming.slice(-40000);
          emit('delta', { sessionId: state.id, text: state.streaming });
        }
      } else if (frameValue.type === 'end' || frameValue.type === 'finish' || frameValue.type === 'error') {
        state.streaming = '';
        emit('delta', { sessionId: state.id, text: '' });
      }
    }
  }

  function scheduleReconnect() {
    if (stopped) return;
    tries += 1;
    const delay = Math.min(RECONNECT_MAX, 1000 * 2 ** Math.min(tries, 5));
    log(`follow: reconnect in ${delay}ms`);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      void ensureSocket().catch(() => {});
    }, delay);
    retryTimer.unref?.();
  }

  function ensureSocket() {
    if (stopped) return Promise.resolve(null);
    if (socket && socket.readyState === 1) return Promise.resolve(socket);
    if (connecting) return connecting;
    connecting = (async () => {
      const cookie = await upstream.ensureCookie();
      const next = await connect({
        port: upstream.port,
        host: upstream.host,
        path: '/api/remote.mux',
        headers: { cookie, origin: `http://${upstream.authority}` },
      });
      next.on('message', handleFrame);
      next.on('close', () => {
        if (socket === next) socket = null;
        diag?.note(28, 0, sessions.size);
        scheduleReconnect();
      });
      socket = next;
      tries = 0;
      diag?.note(27, sessions.size, 0);
      // 重连后把所有还在关注的会话重新挂上
      for (const state of sessions.values()) openStream(state);
      return next;
    })().finally(() => {
      connecting = null;
    });
    return connecting;
  }

  /** 开始关注一个会话；已在关注就只续命。 */
  function subscribe(sessionId) {
    const state = stateOf(sessionId);
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      unsubscribe(sessionId, 'idle');
    }, IDLE_MS);
    state.timer.unref?.();
    void ensureSocket()
      .then(() => {
        if (state.streamId === null) openStream(state);
      })
      .catch((err) => {
        log(`follow: subscribe failed — ${err?.message ?? err}`);
        diag?.note(26, 2, 0);
      });
    return state;
  }

  function unsubscribe(sessionId, reason = 'manual') {
    const state = sessions.get(sessionId);
    if (!state) return;
    clearTimeout(state.timer);
    if (state.streamId && socket && socket.readyState === 1) {
      try {
        socket.send(JSON.stringify({ type: 'cancel', streamId: state.streamId }));
      } catch {
        /* ignore */
      }
    }
    sessions.delete(sessionId);
    diag?.note(29, reason === 'idle' ? 1 : 0, 0);
  }

  return {
    subscribe,
    unsubscribe,
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** 手机拉历史：没有就先去订阅（首次会有快照）。 */
    async read(sessionId, { waitMs = 1500 } = {}) {
      const state = subscribe(sessionId);
      if (state.messages.length === 0 && state.cursor === 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      return { sessionId, cursor: state.cursor, streaming: state.streaming, messages: state.messages.slice() };
    },
    status() {
      return { sessions: [...sessions.keys()], connected: Boolean(socket && socket.readyState === 1), tries };
    },
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      for (const state of sessions.values()) clearTimeout(state.timer);
      sessions.clear();
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
      socket = null;
    },
  };
}