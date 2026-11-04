// PWA 的静态检查：不启浏览器，只钉住「一改就白屏」的那几类错误。
//
//   · app.js 里引用的 DOM id 必须真的在 index.html 里；
//   · 不许写死地址（写死 = 换个端口就废）；
//   · 调用的 API 路径必须在 docs/PROTOCOL.md 里有；
//   · service worker 不许缓存 api/ 与 stream（否则手机上永远看到旧状态）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(dirname(fileURLToPath(import.meta.url))));
const PWA = join(ROOT, 'lib', 'pwa');
const read = (name) => readFileSync(join(PWA, name), 'utf8');

const html = read('index.html');
const app = read('app.js');
const sw = read('sw.js');
const manifest = JSON.parse(read('manifest.webmanifest'));

/** index.html 里的所有 id。 */
function htmlIds() {
  return new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
}

test('index.html 引用的资源都存在且同名', () => {
  for (const name of ['app.js', 'style.css', 'manifest.webmanifest']) {
    assert.ok(html.includes(`./${name}`), `index.html 必须引用 ./${name}`);
  }
  assert.ok(html.includes('lang="zh-CN"'));
  assert.ok(html.includes('viewport-fit=cover'), 'iPhone 刘海屏需要 viewport-fit=cover');
  assert.equal(manifest.start_url, '.');
  assert.equal(manifest.display, 'standalone');
});

test("app.js 里 $('id') 与 on('id', …) 引用的 id 全部存在", () => {
  const ids = htmlIds();
  const refs = new Set([
    ...[...app.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map((m) => m[1]),
    ...[...app.matchAll(/\bon\('([a-z0-9-]+)'\s*,/g)].map((m) => m[1]),
  ]);
  const missing = [...refs].filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `index.html 缺这些 id：${missing.join(', ')}`);
});

test('没有写死的地址/端口', () => {
  for (const name of ['index.html', 'app.js', 'sw.js']) {
    const text = read(name);
    for (const bad of ['http://localhost', '127.0.0.1', ':3080', ':3081']) {
      assert.equal(text.includes(bad), false, `${name} 里不该出现 ${bad}`);
    }
  }
});

test('调用的 API 路径都在协议里', () => {
  const protocol = readFileSync(join(ROOT, '..', 'docs', 'PROTOCOL.md'), 'utf8');
  const paths = new Set([...app.matchAll(/'(api\/[a-z]+|pair)'/g)].map((m) => m[1]));
  assert.ok(paths.size >= 4, '至少要调用 state / prompt / cancel / approval');
  for (const path of paths) {
    const needle = path === 'pair' ? '/pair' : `/${path}`;
    assert.ok(protocol.includes(needle), `docs/PROTOCOL.md 里没有 ${needle}`);
  }
});

test('service worker 不缓存 api 与 stream，且装了 skipWaiting', () => {
  assert.match(sw, /skipWaiting/);
  assert.match(sw, /path\.includes\('\/api\/'\)/, 'sw.js 必须显式旁路 /api/');
  assert.match(sw, /\/api\/stream/, 'sw.js 必须显式旁路流');
});

test('app.js 与 sw.js 语法可解析', async () => {
  // 用动态 import 会真跑 boot()，所以只做语法检查：交给 node --check 的等价物。
  const { execFileSync } = await import('node:child_process');
  for (const name of ['app.js', 'sw.js']) {
    execFileSync(process.execPath, ['--check', join(PWA, name)]);
  }
});