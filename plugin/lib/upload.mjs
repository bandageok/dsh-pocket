// 断点续传：手机往电脑传文件（截图、日志、一段素材），弱网断了能接着传。
//
// ## 从参考实现学到的四条，逐条落在这里
//
// DSHgo 的 `resumable-upload.cjs` 有几个值得抄的判断（代码没抄，判断是通用的）：
//
// 1. **offset 必须严格对齐**：请求带来的 offset 和服务端记录的不一致，就回 409 +
//    服务端的真实 offset，让客户端接着传，而不是静默拼接成坏文件。
// 2. **创建要幂等**：网络差时「创建成功但回执丢了」很常见，客户端会重发；同一个
//    `requestId` 必须复用同一条记录，否则磁盘上会堆一堆没人认领的半截文件。
// 3. **磁盘有上限**：单文件 ≤ 512 MiB、总量 ≤ 2 GiB、空闲 30 分钟回收。
//    没有上限的「续传」等于给自己留了一个填满硬盘的接口。
// 4. **重放边界**：只有「上传块」可以重试；`finish` 之后**绝不重放**，
//    否则一次不确定的失败会变成两次落盘。
//
// ## 与参考实现不同的地方
//
// 它把文件塞进 dsh 自己的上传收据通道（`target` 是 dsh 的附件路径），因此必须
// 复刻 dsh 的 upload receipt 语义。我们把文件落在 `$DSH_HOME/pocket-uploads/`，
// 只回一个绝对路径 —— 手机把这行路径塞进 prompt 就行，任何 dsh 版本都不会失效。
// 代价：图片不会变成 dsh 的内嵌图像（走的还是「文件 + 路径」这条路）。
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_FILE = 512 * 1024 * 1024; // 512 MiB
const MAX_TOTAL = 2 * 1024 ** 3;
const TTL_MS = 30 * 60 * 1000;
const SWEEP_MS = 60 * 1000;
const MAX_NAME = 120;

/** 只留安全字符：不允许路径分隔、不允许以点开头（避免写出隐藏/父目录）。 */
function safeName(raw) {
  const base = String(raw ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .trim();
  const cleaned = base.replace(/[^\w.\-\u4e00-\u9fa5 ()（）]/g, '_').replace(/^\.+/, '').slice(0, MAX_NAME);
  return cleaned || `upload-${randomBytes(4).toString('hex')}`;
}

/**
 * @param {{dir: string, maxFile?: number, maxTotal?: number, ttlMs?: number, diag?: ReturnType<import('./diag.mjs').createDiag>, log?: (msg: string) => void}} options
 */
export function createUploads(options) {
  const dir = options.dir;
  const maxFile = options.maxFile ?? MAX_FILE;
  const maxTotal = options.maxTotal ?? MAX_TOTAL;
  const ttl = options.ttlMs ?? TTL_MS;
  const diag = options.diag;
  const log = options.log ?? (() => {});

  mkdirSync(dir, { recursive: true });

  /**
   * @type {Map<string, {id: string, name: string, size: number, offset: number, file: string, requestId: string, device: string, touched: number, state: 'open'|'done', sha256?: string, busy: boolean}>}
   */
  const records = new Map();
  /** requestId → id，做创建幂等。 */
  const byRequest = new Map();

  function totalBytes() {
    let sum = 0;
    for (const it of records.values()) if (it.state === 'open') sum += it.offset;
    return sum;
  }

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, record] of records) {
      if (record.busy || record.state === 'done') continue;
      if (now - record.touched < ttl) continue;
      records.delete(id);
      byRequest.delete(record.requestId);
      unlink(record.file).catch(() => {});
      log(`upload: expired ${id}`);
    }
  }, SWEEP_MS);
  sweep.unref?.();

  function statusOf(record) {
    return { id: record.id, name: record.name, size: record.size, offset: record.offset, state: record.state, sha256: record.sha256 ?? null };
  }

  /** 创建（幂等）。 */
  function init({ name, size, requestId }, device) {
    const wanted = Number(size);
    if (!Number.isFinite(wanted) || wanted <= 0) return { status: 400, body: { error: 'bad-size' } };
    if (wanted > maxFile) return { status: 413, body: { error: 'too-large', maxFile } };
    if (totalBytes() + wanted > maxTotal) return { status: 507, body: { error: 'disk-full', maxTotal } };

    const key = String(requestId ?? '') || `auto-${randomBytes(6).toString('hex')}`;
    const existing = byRequest.get(key);
    if (existing && records.has(existing)) {
      const record = records.get(existing);
      return { status: 200, body: { ...statusOf(record), resumed: true } };
    }

    const id = randomBytes(9).toString('base64url');
    const fileName = safeName(name);
    const file = join(dir, `${id}-${fileName}`);
    const record = { id, name: fileName, size: wanted, offset: 0, file, requestId: key, device: device ?? '', touched: Date.now(), state: 'open', busy: false };
    records.set(id, record);
    byRequest.set(key, id);
    diag?.note(13, wanted, 1);
    return { status: 200, body: { ...statusOf(record), chunkSize: 1024 * 1024, resumed: false } };
  }

  function get(id) {
    const record = records.get(id);
    return record ? { status: 200, body: statusOf(record) } : { status: 404, body: { error: 'gone' } };
  }

  /**
   * 写一块。offset 必须等于服务端当前 offset。
   * @param {Buffer} chunk
   */
  async function writeChunk(id, offset, chunk) {
    const record = records.get(id);
    if (!record) return { status: 404, body: { error: 'gone' } };
    if (record.state === 'done') return { status: 409, body: { error: 'already-done' } };
    if (record.busy) return { status: 409, body: { error: 'busy', offset: record.offset } };
    const at = Number(offset);
    if (at !== record.offset) {
      // 回真实 offset 让客户端接着传 —— 这是「断点续传」的全部意义。
      return { status: 409, body: { error: 'offset', offset: record.offset } };
    }
    if (record.offset + chunk.length > record.size) {
      return { status: 400, body: { error: 'overflow', size: record.size, offset: record.offset } };
    }

    record.busy = true;
    try {
      const handle = await open(record.file, 'a');
      try {
        await handle.write(chunk, 0, chunk.length, record.offset);
      } finally {
        await handle.close();
      }
      record.offset += chunk.length;
      record.touched = Date.now();
      diag?.note(14, chunk.length, record.offset);
      return { status: 200, body: { offset: record.offset, size: record.size } };
    } catch (err) {
      log(`upload: write failed — ${err?.message ?? err}`);
      return { status: 500, body: { error: 'write-failed' } };
    } finally {
      record.busy = false;
    }
  }

  /** 收尾：校验长度 + 算 sha256 + 固定文件名。**不重放**：已完成就直接回同一结果。 */
  async function finish(id) {
    const record = records.get(id);
    if (!record) return { status: 404, body: { error: 'gone' } };
    if (record.state === 'done') return { status: 200, body: { ok: true, path: record.file, size: record.size, sha256: record.sha256 } };
    if (record.offset !== record.size) return { status: 409, body: { error: 'incomplete', offset: record.offset, size: record.size } };

    try {
      const bytes = await readFile(record.file);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const finalPath = join(dir, record.name);
      await rename(record.file, finalPath);
      record.file = finalPath;
      record.sha256 = sha256;
      record.state = 'done';
      record.touched = Date.now();
      diag?.note(15, record.size, 1);
      return { status: 200, body: { ok: true, path: finalPath, size: record.size, sha256 } };
    } catch (err) {
      log(`upload: finish failed — ${err?.message ?? err}`);
      return { status: 500, body: { error: 'finish-failed' } };
    }
  }

  return {
    dir,
    init,
    get,
    writeChunk,
    finish,
    status: () => ({ files: records.size, bytes: totalBytes(), maxFile, maxTotal }),
    stop() {
      clearInterval(sweep);
    },
  };
}

export const UPLOAD_LIMITS = { maxFile: MAX_FILE, maxTotal: MAX_TOTAL, ttlMs: TTL_MS };