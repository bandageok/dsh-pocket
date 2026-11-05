#!/usr/bin/env node
// 不装进 dsh 也能跑：给调试、给 CI、给「我就想先看看手机界面长什么样」。
//
//   node tools/standalone.mjs --dsh-port 3080 --token <launch token>
//
// 和插件用同一条装配路径（lib/stack.mjs），所以这里跑通的东西，装进 dsh 里就是同一个东西。
// 唯一的差别：launch token 由你给（插件里是 ctx.connection.authenticatedUrl 现取的）。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readConfig } from '../lib/index.js';
import { isCgnatAddress, lanAddresses } from '../lib/proxy.mjs';
import { createStack, listenWithRetry } from '../lib/stack.mjs';
import { createStore } from '../lib/store.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

/** 从 `dsh web` 的启动日志里捞 launch token（调试用，插件里不需要）。 */
function tokenFromLog(file) {
  try {
    const text = readFileSync(file, 'utf8');
    const matches = [...text.matchAll(/token=([A-Za-z0-9_-]{20,})/g)];
    return matches.length > 0 ? matches[matches.length - 1][1] : '';
  } catch {
    return '';
  }
}

const args = parseArgs(process.argv.slice(2));
const dshPort = Number(args['dsh-port'] ?? 3080);
const logFile = args['token-from'] ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'web-3080.out.log');
const token = String(args.token ?? '') || tokenFromLog(logFile);
const home = String(args.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'));
const config = readConfig({
  port: Number(args.port ?? 3081),
  bind: String(args.bind ?? '0.0.0.0'),
  approvals: args.approvals,
  relayUrl: args['relay-url'],
  relayRoom: args['relay-room'],
});

if (!token) {
  console.error('dsh-pocket: 缺 launch token。加 --token <t>，或用 --token-from <日志文件>。');
  console.error('  dsh web 启动时会打印：http://127.0.0.1:<port>/?token=<t>');
  process.exit(2);
}

mkdirSync(home, { recursive: true });
const store = createStore({ home });
const stack = createStack({ dshPort, getToken: () => token, store, config, pwaDir: join(ROOT, 'lib', 'pwa'), log: (m) => console.log(m) });

const port = await listenWithRetry(stack.server, config.port, config.bind, 10, (m) => console.log(m));
stack.setPort(port);
stack.startRelay(port); // 与插件里同一条拨号路径
const urls = lanAddresses().map((it) => `http://${it.address}:${port}/__pocket__/`);
const cgnat = lanAddresses().filter((it) => isCgnatAddress(it.address)).map((it) => `http://${it.address}:${port}/__pocket__/`);

console.log('');
console.log('dsh-pocket (standalone)');
console.log(`  上游      : 127.0.0.1:${dshPort}  (token ${token.slice(0, 8)}…)`);
console.log(`  手机端    : ${urls[0] ?? `http://127.0.0.1:${port}/__pocket__/`}`);
for (const url of urls.slice(1)) console.log(`              ${url}`);
if (cgnat.length > 0) console.log(`  备用地址  : ${cgnat[0]}`);
console.log(`  配对码    : ${store.code}`);
console.log(`  状态文件  : ${store.file}`);
console.log('');

// 方便自动化：把配对码写一份到文件（0600），测试脚本读它。
const codeFile = join(home, 'pocket-code.txt');
try {
  writeFileSync(codeFile, `${store.code}\n`, { mode: 0o600 });
} catch {
  /* 无所谓 */
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    try {
      stack.stopRelay();
    } catch {
      /* ignore */
    }
    await stack.pocket.shutdown();
    stack.server.close();
    process.exit(0);
  });
}