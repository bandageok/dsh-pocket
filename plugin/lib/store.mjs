// 插件自己的持久状态：密钥、配对码、已配对设备、中继配置。
//
// 为什么单独一个文件（~/.dsh/pocket.json）而不是塞进 DSH 的 storages：
//   · 这是**本插件**的凭据，不该混进 dsh 的会话/设置里被别的插件读到；
//   · 用户想重置只需删一个文件，不用懂 dsh 的内部目录。
//
// 权限 0600：里面是配对密钥，等同「谁能连上这台电脑的 dsh」。
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const CODE_LENGTH = 6;
const MAX_FAILURES = 5;
const LOCK_MS = 5 * 60 * 1000;

/** 32 字节 base64url 明文密钥。 */
function newSecret() {
  return randomBytes(32).toString('base64url');
}

/** 6 位数字配对码。用 randomInt（密码学随机），不用 Math.random。 */
function newCode() {
  return String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
}

/**
 * @param {{home?: string, file?: string}} [options] `home` 是 DSH_HOME，缺省 `~/.dsh`。
 */
export function createStore(options = {}) {
  const home = options.home ?? process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh');
  const file = options.file ?? join(home, 'pocket.json');

  /** @type {{version:number, secret:string, code:string, codeIssuedAt:number, devices:Array<{id:string,name:string,createdAt:number,lastSeenAt:number}>, relay:{url:string|null, room:string|null}, failures:{count:number, lockedUntil:number}}} */
  let data;

  function fresh() {
    return {
      version: 1,
      secret: newSecret(),
      code: newCode(),
      codeIssuedAt: Date.now(),
      devices: [],
      relay: { url: null, room: null },
      failures: { count: 0, lockedUntil: 0 },
    };
  }

  function load() {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      // 老文件缺字段就补齐，而不是整份丢弃 —— 丢了等于所有手机都要重配。
      data = { ...fresh(), ...parsed, relay: { ...fresh().relay, ...(parsed.relay ?? {}) }, failures: { ...fresh().failures, ...(parsed.failures ?? {}) } };
      if (typeof data.secret !== 'string' || data.secret.length < 16) data.secret = newSecret();
      if (!Array.isArray(data.devices)) data.devices = [];
      if (!new RegExp(`^\\d{${CODE_LENGTH}}$`).test(String(data.code))) data.code = newCode();
      return data;
    } catch {
      data = fresh();
      save();
      return data;
    }
  }

  function save() {
    const text = JSON.stringify(data, null, 2);
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, text, { mode: 0o600 });
      renameSync(tmp, file);
    } catch {
      /* 写不进去不能让插件挂掉：本轮内存里仍然可用 */
    }
  }

  /** 设备令牌 = HMAC(secret, "device:" + id)。改 secret 等于一次全端踢下线。 */
  function tokenFor(deviceId) {
    return createHmac('sha256', data.secret).update(`device:${deviceId}`).digest('base64url');
  }

  function safeEqual(a, b) {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && timingSafeEqual(x, y);
  }

  /**
   * 用配对码换设备令牌。
   * @returns {{ok:true, token:string, deviceId:string, deviceName:string} | {ok:false, error:'bad-code'|'locked'|'bad-request', attemptsLeft?:number, retryAt?:number}}
   */
  function pair(code, name) {
    const now = Date.now();
    if (data.failures.lockedUntil > now) {
      return { ok: false, error: 'locked', retryAt: Math.ceil(data.failures.lockedUntil / 1000) };
    }
    if (typeof code !== 'string' || !new RegExp(`^\\d{${CODE_LENGTH}}$`).test(code)) {
      return { ok: false, error: 'bad-request' };
    }
    if (!safeEqual(code, data.code)) {
      data.failures.count += 1;
      if (data.failures.count >= MAX_FAILURES) {
        data.failures.lockedUntil = now + LOCK_MS;
        data.failures.count = 0;
      }
      save();
      return { ok: false, error: 'bad-code', attemptsLeft: Math.max(0, MAX_FAILURES - data.failures.count) };
    }

    const deviceId = randomBytes(9).toString('base64url');
    const deviceName = String(name ?? '').trim().slice(0, 40) || '手机';
    data.devices.push({ id: deviceId, name: deviceName, createdAt: now, lastSeenAt: now });
    data.failures.count = 0;
    data.failures.lockedUntil = 0;
    // 配对成功即换码：同一个码不能被第二台设备复用。
    data.code = newCode();
    data.codeIssuedAt = now;
    save();
    return { ok: true, token: tokenFor(deviceId), deviceId, deviceName };
  }

  /** 校验 Bearer / cookie 里的令牌。命中就顺手更新 lastSeenAt（不落盘，避免每请求写文件）。 */
  function verify(token) {
    if (typeof token !== 'string' || token.length < 16) return null;
    for (const device of data.devices) {
      if (safeEqual(token, tokenFor(device.id))) {
        device.lastSeenAt = Date.now();
        return device;
      }
    }
    return null;
  }

  function rotateCode() {
    data.code = newCode();
    data.codeIssuedAt = Date.now();
    save();
    return data.code;
  }

  function forget(deviceId) {
    data.devices = data.devices.filter((it) => it.id !== deviceId);
    save();
  }

  function setRelay(url, room) {
    data.relay = { url: url ? String(url) : null, room: room ? String(room) : null };
    save();
  }

  load();

  return {
    file,
    get code() {
      return data.code;
    },
    get codeIssuedAt() {
      return data.codeIssuedAt;
    },
    get devices() {
      return data.devices.map((it) => ({ id: it.id, name: it.name, createdAt: it.createdAt, lastSeenAt: it.lastSeenAt }));
    },
    get relay() {
      return { ...data.relay };
    },
    get paired() {
      return data.devices.length > 0;
    },
    get secret() {
      return data.secret;
    },
    pair,
    verify,
    rotateCode,
    forget,
    setRelay,
    tokenFor,
    reload: load,
  };
}