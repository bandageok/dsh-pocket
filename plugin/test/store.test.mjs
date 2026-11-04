import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createStore } from '../lib/store.mjs';

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-store-'));
  const store = createStore({ file: join(dir, 'pocket.json') });
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('首次启动生成密钥与 6 位配对码', () => {
  const { store, cleanup } = freshStore();
  try {
    assert.match(store.code, /^\d{6}$/);
    assert.ok(store.secret.length >= 32);
    assert.equal(store.paired, false);
  } finally {
    cleanup();
  }
});

test('配对成功发出令牌，并轮换配对码', () => {
  const { store, cleanup } = freshStore();
  try {
    const code = store.code;
    const result = store.pair(code, 'iPhone');
    assert.equal(result.ok, true);
    assert.ok(result.token.length >= 20);
    assert.notEqual(store.code, code, '配对码必须换掉，不能被第二台设备复用');
    assert.equal(store.paired, true);

    const device = store.verify(result.token);
    assert.ok(device, '刚发的令牌必须能验收');
    assert.equal(device.name, 'iPhone');
  } finally {
    cleanup();
  }
});

test('错码 5 次锁 5 分钟，锁定期内连对码也不放行', () => {
  const { store, cleanup } = freshStore();
  try {
    for (let i = 0; i < 4; i += 1) {
      const res = store.pair('000000', 'x');
      assert.equal(res.error, 'bad-code');
      assert.equal(res.attemptsLeft, 4 - i);
    }
    const fifth = store.pair('000000', 'x');
    assert.equal(fifth.error, 'bad-code');
    const locked = store.pair(store.code, 'x');
    assert.equal(locked.error, 'locked');
    assert.ok(locked.retryAt > Date.now() / 1000);
  } finally {
    cleanup();
  }
});

test('格式不对的码直接被拒，且不计入失败次数', () => {
  const { store, cleanup } = freshStore();
  try {
    assert.equal(store.pair('abcd', 'x').error, 'bad-request');
    const ok = store.pair(store.code, 'x');
    assert.equal(ok.ok, true);
  } finally {
    cleanup();
  }
});

test('伪造令牌验收失败；忘记设备后原令牌立刻失效', () => {
  const { store, cleanup } = freshStore();
  try {
    assert.equal(store.verify('a'.repeat(43)), null);
    const result = store.pair(store.code, 'iPad');
    assert.ok(store.verify(result.token));
    store.forget(result.deviceId);
    assert.equal(store.verify(result.token), null, '踢下线必须真的踢掉');
  } finally {
    cleanup();
  }
});

test('状态文件落盘后能重新读出来（手机不用重配）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-store-'));
  const file = join(dir, 'pocket.json');
  try {
    const first = createStore({ file });
    const token = first.pair(first.code, 'Pixel').token;
    const second = createStore({ file });
    assert.ok(second.verify(token), '重启后同一令牌仍然有效');
    assert.equal(second.devices.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});