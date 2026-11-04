// 测试共用装配：假 dsh + 真 store + 真 stack，监听随机端口。
// 与插件入口走同一条 createStack 路径，避免「测试里好的、装进 dsh 里坏的」。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStack } from '../../lib/stack.mjs';
import { createStore } from '../../lib/store.mjs';
import { LAUNCH_TOKEN, startFakeDsh } from './fake-dsh.mjs';

export const PWA_DIR = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'lib', 'pwa');

/**
 * @param {{fake?: object, approvals?: string, config?: object}} [options]
 */
export async function boot(options = {}) {
  const fake = await startFakeDsh(options.fake);
  const home = mkdtempSync(join(tmpdir(), 'pocket-home-'));
  const store = createStore({ file: join(home, 'pocket.json') });
  const stack = createStack({
    dshPort: fake.port,
    getToken: () => LAUNCH_TOKEN,
    store,
    home,
    config: { approvals: options.approvals ?? 'observe', approvalTimeoutMs: 2000, ...(options.config ?? {}) },
    pwaDir: PWA_DIR,
  });
  await new Promise((resolve) => stack.server.listen(0, '127.0.0.1', resolve));
  const port = stack.server.address().port;
  stack.setPort(port);
  const base = `http://127.0.0.1:${port}`;
  const token = () => store.pair(store.code, 'test-phone').token;
  return {
    fake,
    home,
    store,
    stack,
    port,
    base,
    token,
    async close() {
      await stack.pocket.shutdown();
      stack.uploads?.stop();
      await new Promise((resolve) => stack.server.close(resolve));
      await fake.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

export const json = async (res) => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { __raw: text };
  }
};