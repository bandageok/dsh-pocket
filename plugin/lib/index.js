// dsh-pocket —— 插件入口（cordis 形态）。
//
// 设计规则（和 dsh-phone-remote 同一条）：**不 import 任何 dsh 包**。
// 只用 apply(ctx, config) + node 内置模块 + 两条宿主服务：
//   · ctx.webServer.port                  —— 上游 `dsh web` 的端口
//   · ctx.connection.authenticatedUrl(…)  —— 现取 launch token
// dsh 内部怎么改都打不挂本插件；只有这两个服务消失时才需要跟着动。
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isCgnatAddress, lanAddresses } from './proxy.mjs';
import { createStack, listenWithRetry } from './stack.mjs';
import { createStore } from './store.mjs';

export const name = 'dsh-pocket';

/** 宿主服务：连接层（取 launch token）+ web server（取端口）。 */
export const inject = ['connection', 'webServer'];

const DEFAULTS = {
  port: 3081,
  bind: '0.0.0.0',
  approvals: 'observe',
  approvalTimeoutMs: 45000,
  relayUrl: '',
  relayRoom: '',
  loopPorts: [],
  loopAny: false,
};

const PORT_ATTEMPTS = 10;

/**
 * 现取 launch token。
 *
 * 不能缓存：token 每次 `dsh web` 启动都变，缓存了重启后就是 401。
 * 老版本没有 `authenticatedUrl` 就返回空串 —— 反代退化为纯转发。
 */
function makeTokenReader(ctx, dshPort, warn) {
  return () => {
    try {
      const fn = ctx.connection?.authenticatedUrl;
      if (typeof fn !== 'function') return '';
      const url = new URL(fn.call(ctx.connection, `http://127.0.0.1:${dshPort}`));
      return url.searchParams.get('token') ?? '';
    } catch (err) {
      warn(`dsh-pocket: 取 launch token 失败 —— ${err?.message ?? err}`);
      return '';
    }
  };
}

/** 手工校验配置：不引 schemastery，保持零依赖（代价是错误信息要自己写清楚）。 */
export function readConfig(raw) {
  const config = { ...DEFAULTS, ...(raw ?? {}) };
  const port = Number(config.port);
  config.port = Number.isFinite(port) && port > 0 && port < 65536 ? port : DEFAULTS.port;
  config.bind = String(config.bind || DEFAULTS.bind);
  config.approvals = config.approvals === 'answer' ? 'answer' : 'observe';
  const timeout = Number(config.approvalTimeoutMs);
  config.approvalTimeoutMs = Number.isFinite(timeout) && timeout >= 5000 ? timeout : DEFAULTS.approvalTimeoutMs;
  config.relayUrl = String(config.relayUrl ?? '').trim();
  config.relayRoom = String(config.relayRoom ?? '').trim();
  if (config.relayUrl && !/^wss?:\/\//.test(config.relayUrl)) config.relayUrl = '';
  if (!config.relayUrl) config.relayRoom = '';

  // 回环穿透白名单：接受数组，也接受 "9230,5173" 这种写法（YAML 里少一层缩进）
  const rawPorts = Array.isArray(config.loopPorts) ? config.loopPorts : String(config.loopPorts ?? '').split(/[,\s]+/);
  config.loopPorts = [...new Set(rawPorts.map((it) => Number(it)).filter((it) => Number.isInteger(it) && it > 0 && it < 65536))];
  config.loopAny = config.loopAny === true || config.loopAny === 'true';

  return config;
}

/** 从进程内审批请求里尽力取字段：字段名跨版本可能不同，取不到就降级，不能因此丢掉审批。 */
export function describeApproval(request) {
  const read = (...paths) => {
    for (const path of paths) {
      let cursor = request;
      for (const key of path.split('.')) {
        if (cursor == null) break;
        cursor = cursor[key];
      }
      if (cursor !== undefined && cursor !== null) return cursor;
    }
    return undefined;
  };
  const sessionId = read('sessionId', 'session.id', 'agent.sessionId', 'agent.session.id', 'request.sessionId');
  const tool = read('toolName', 'tool.name', 'tool', 'request.toolName', 'name');
  const reason = read('reason', 'displayReason', 'message', 'request.reason', 'summary');
  const agent = request?.agent;
  return {
    sessionId: sessionId ? String(sessionId) : agent?.session?.id ? String(agent.session.id) : null,
    tool: tool ? String(tool) : 'ai',
    reason: reason ? String(reason).slice(0, 300) : '',
  };
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Partial<typeof DEFAULTS>} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  if (process.env.DSH_POCKET_DISABLE === '1') return;

  const config = readConfig(rawConfig);
  // 日志走 stderr：stdout 留给调用方（`node --test` 会把 stdout 当 TAP 流解析，
  // 混进普通日志会让 runner 报 "Unable to deserialize cloned data"）。
  const info = (msg) => {
    try {
      console.error(msg);
    } catch {
      /* 日志失败不影响服务 */
    }
  };
  const warn = (msg) => {
    try {
      console.warn(msg);
    } catch {
      /* ignore */
    }
  };

  const dshPort = ctx?.webServer?.port;
  if (!dshPort) {
    warn('dsh-pocket: 拿不到 dsh web 端口，未启动（headless 场景没有 web server，属预期）');
    return;
  }

  const pwaDir = join(dirname(dirname(fileURLToPath(import.meta.url))), 'lib', 'pwa');
  const store = createStore();
  let stack;
  try {
    stack = createStack({
      dshPort,
      getToken: makeTokenReader(ctx, dshPort, warn),
      store,
      config,
      pwaDir,
      home: dirname(store.file),
      log: warn,
    });
  } catch (err) {
    warn(`dsh-pocket: 装配失败 —— ${err?.message ?? err}`);
    return;
  }
  const { server, pocket, loop, uploads, upstream } = stack;

  listenWithRetry(server, config.port, config.bind, PORT_ATTEMPTS, () => {})
    .then((port) => {
      stack.setPort(port); // 回环白名单要挡住「转发给自己」
      stack.startRelay(port); // 中继拨号（配了 relayUrl/relayRoom 才发生）
      announce(port);
    })
    .catch((err) => warn(`dsh-pocket: 监听失败 —— ${err?.message ?? err}`));

  function announce(port) {
    const addresses = lanAddresses();
    const urls = addresses.map((it) => `http://${it.address}:${port}/__pocket__/`);
    const cgnat = addresses.filter((it) => isCgnatAddress(it.address)).map((it) => `http://${it.address}:${port}/__pocket__/`);
    const line = (text) => info(`│ ${text}`);
    info('');
    info('┌─ dsh-pocket ────────────────────────────────────────────────');
    line(`手机端：${urls[0] ?? `http://<本机IP>:${port}/__pocket__/`}`);
    for (const url of urls.slice(1)) line(`        ${url}`);
    if (cgnat.length > 0) line(`备用地址：${cgnat[0]}（100.64/10 网段，通常来自组网工具）`);
    if (config.relayUrl) line(`中继：${config.relayUrl}  房间 ${config.relayRoom || '(未设置)'}`);
    line(`配对码：${store.code}   ·  ${pocket.approvalAnswer ? '手机可批准审批' : '审批仅展示'}`);
    if (loop.status().enabled) {
      line(`回环穿透：${loop.status().any ? '任意端口（loopAny）' : `端口 ${loop.status().ports.join(', ')}`}`);
    }
    line(`收文件：${dirname(store.file)}/pocket-uploads`);
    line(`完整界面：${urls[0] ?? `http://127.0.0.1:${port}/`}?pocket=<配对后的令牌>`);
    const rootUrl = urls[0] ? urls[0].replace('/__pocket__/', '/') : `http://127.0.0.1:${port}/`;
    line(`排障：${rootUrl}__pocket__/api/diag?download=1（仅数字码）`);
    info('└─────────────────────────────────────────────────────────────');
    info('');
  }

  // ── 进程内事件：活动时间与审批 ────────────────────────────────────────
  try {
    ctx.on?.('api-session/activity', (sessionId, at) => pocket.noteActivity(sessionId, at));
    for (const event of ['api-session/added', 'api-session/removed', 'api-session/status']) {
      ctx.on?.(event, () => pocket.invalidate());
    }
  } catch (err) {
    warn(`dsh-pocket: 会话事件订阅失败（不影响基本功能）—— ${err?.message ?? err}`);
  }

  if (typeof ctx.on === 'function') {
    try {
      ctx.on('approval/request', async (request) => {
        const pending = pocket.noteApproval({
          ...describeApproval(request),
          ttl: config.approvals === 'answer' ? config.approvalTimeoutMs : 45000,
        });
        // observe：只让手机看得见，把决定留给桌面端（立即返回 undefined = 不接管 waterfall）
        if (config.approvals !== 'answer') return undefined;
        const decision = await new Promise((resolve) => {
          pending.resolve = resolve;
          const signal = request?.signal;
          if (signal?.aborted) resolve(null);
          else signal?.addEventListener?.('abort', () => resolve(null), { once: true });
        });
        if (decision === 'allowed-once' || decision === 'rejected') {
          info(`dsh-pocket: 审批 ${decision}（来自手机）`);
          return decision;
        }
        return undefined; // 超时/中止 → 交回下一个应答者（桌面端界面）
      });
    } catch (err) {
      warn(`dsh-pocket: 审批钩子注册失败 —— ${err?.message ?? err}`);
    }
  }

  // 自愈：连续失败说明缓存的 cookie 已经不可用（上游重启过），
  // 丢掉它让下一次调用重新铸造 —— 比等用户重启插件靠谱。
  const heal = setInterval(() => {
    if (upstream.failures >= 3) {
      warn(`dsh-pocket: 上游连续失败 ${upstream.failures} 次，重置会话 cookie`);
      upstream.reset();
      stack.diag?.note(6, 0, upstream.failures);
    }
  }, 60000);
  heal.unref?.();

  const dispose = () => {
    try {
      clearInterval(heal);
    } catch {
      /* ignore */
    }
    try {
      uploads?.stop();
    } catch {
      /* ignore */
    }
    try {
      stack.stopRelay();
    } catch {
      /* ignore */
    }
    try {
      void pocket.shutdown();
    } catch {
      /* ignore */
    }
    try {
      server.close();
    } catch {
      /* ignore */
    }
  };
  try {
    if (typeof ctx.effect === 'function') ctx.effect(() => dispose);
    else ctx.on?.('dispose', dispose);
  } catch {
    /* 没有 dispose 机制也不影响运行 */
  }
}