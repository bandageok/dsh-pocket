// 有界诊断环：只记「数字码 + 两个数」，不记聊天、文件名、IP、令牌。
//
// 为什么要有它：手机连不上时，用户在另一台设备上看不到任何信息，
// 只能凭「打不开」三个字描述问题。有了一串数字码，排障从「猜」变成「查表」。
//
// 为什么不上完整日志：这是本机工具，日志一旦带上路径/会话内容，
// 导出就等于把工作区交出去。所以这里刻意只留可枚举的事件码。
//
// 上限 512 条、环形覆盖 —— 内存占用恒定，长期挂着也不会涨。

/** 事件码表。改动要同步 docs/TROUBLESHOOTING.md 的表。 */
export const CODES = {
  1: 'pair ok',
  2: 'pair fail',
  3: 'gate reject',
  4: 'gate ok',
  5: 'upstream ok',
  6: 'upstream fail',
  7: 'prompt ok',
  8: 'prompt fail',
  9: 'cancel ok',
  10: 'cancel fail',
  11: 'approval seen',
  12: 'approval settled',
  13: 'upload init',
  14: 'upload chunk',
  15: 'upload done',
  16: 'upload reject',
  17: 'loop forward',
  18: 'loop reject',
  19: 'sse open',
  20: 'sse close',
  21: 'relay connect',
  22: 'relay drop',
  23: 'token remint',
  24: 'sync snapshot',
  25: 'sync message',
  26: 'sync error',
  27: 'sync ws open',
  28: 'sync ws drop',
  29: 'sync unsubscribe',
};

/**
 * @param {{size?: number}} [options]
 */
export function createDiag(options = {}) {
  const size = Number(options.size) > 0 ? Number(options.size) : 512;
  /** @type {Array<{t:number, c:number, a:number, b:number}>} */
  const ring = [];
  let dropped = 0;
  const startedAt = Date.now();

  return {
    /**
     * 记一条。`a`/`b` 只能放数字（状态码、字节数、端口、条数）——
     * 放字符串就等于把内容泄进诊断包里。
     */
    note(code, a = 0, b = 0) {
      const c = Number(code) || 0;
      ring.push({ t: Date.now(), c, a: Math.trunc(Number(a) || 0), b: Math.trunc(Number(b) || 0) });
      if (ring.length > size) {
        ring.shift();
        dropped += 1;
      }
    },
    /** 给 /api/diag 的 JSON。 */
    snapshot() {
      return {
        version: 1,
        startedAt,
        uptimeMs: Date.now() - startedAt,
        size,
        dropped,
        codes: CODES,
        entries: ring.slice(),
      };
    },
    /** 给人看的 JSONL（一行一条），下载用。 */
    text() {
      const head = `# dsh-pocket diagnostics v1 — 只含事件码与数字，不含聊天/路径/地址/令牌\n# codes: ${JSON.stringify(CODES)}\n`;
      return head + ring.map((it) => JSON.stringify(it)).join('\n') + '\n';
    },
    get count() {
      return ring.length;
    },
  };
}