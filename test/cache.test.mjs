import test from 'node:test';
import assert from 'node:assert/strict';
import { TTLCache } from '../src/cache.mjs';

test('TTLCache 基本读写与过期', async () => {
  const cache = new TTLCache({ ttlMs: 40, max: 3 });
  cache.set('a', 1);
  assert.deepEqual(cache.get('a')?.value, 1);
  assert.equal(cache.stats.hits, 1);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(cache.get('a'), null);
  assert.equal(cache.stats.misses, 1);
});

test('TTLCache LRU 逐出最久未使用项', () => {
  const cache = new TTLCache({ ttlMs: 10_000, max: 2 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a'); // a 变为最近使用
  cache.set('c', 3); // 逐出 b
  assert.equal(cache.get('b'), null);
  assert.equal(cache.get('a')?.value, 1);
  assert.equal(cache.get('c')?.value, 3);
  assert.equal(cache.stats.evictions, 1);
});

test('TTLCache 支持自定义 ttl 与清理', () => {
  const cache = new TTLCache({ ttlMs: 10_000, max: 5 });
  cache.set('short', 'x', 1);
  cache.set('long', 'y', 10_000);
  assert.equal(cache.size, 2);
  cache.clear();
  assert.equal(cache.size, 0);
});

test('TTLCache 单条 TTL 覆盖默认值', async () => {
  const cache = new TTLCache({ ttlMs: 60_000, max: 5 });
  cache.set('custom', 'v', 20);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(cache.get('custom'), null);
});
