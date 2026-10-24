import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirectBackend } from '../public/js/backend-direct.js';

const SEARCH_PAYLOAD = {
  results: [
    {
      rerank_score: 2.5,
      title: '示例结果',
      url: 'https://example.com/page',
      snippet: '摘要',
      summary: '更长的摘要',
      content: '',
      site_name: 'Example',
      site_icon: 'https://example.com/favicon.ico',
      date: '2026-01-01T00:00:00+00:00',
      authority: 4,
    },
  ],
};

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    _map: map,
  };
}

function makeFetch(state) {
  return async (url, options = {}) => {
    const parsed = new URL(url);
    const body = options.body ? JSON.parse(options.body) : null;
    state.calls.push({ path: parsed.pathname, body, headers: options.headers || {} });
    if (state.failStatus) {
      return new Response(
        JSON.stringify({ error: { message: 'Authentication Fails', type: 'authentication_error', code: 'invalid_request_error' } }),
        { status: state.failStatus, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (parsed.pathname === '/v1/tools/search') {
      return new Response(JSON.stringify(SEARCH_PAYLOAD), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (parsed.pathname === '/v1/tools/fetch') {
      return new Response(JSON.stringify({ title: '页面标题', content: '# 页面标题\n\n正文' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: { message: 'not found' } }), { status: 404 });
  };
}

function makeBackend(overrides = {}) {
  const state = { calls: [], failStatus: 0 };
  const storage = overrides.storage ?? memoryStorage();
  const backend = createDirectBackend({
    fetchImpl: makeFetch(state),
    storage,
    embeddedKey: '',
    baseUrl: 'http://fake.deepseek.local',
    version: '9.9.9',
    ...overrides.options,
  });
  return { backend, state, storage };
}

test('直连状态：未配置、模式与版本', async () => {
  const { backend } = makeBackend();
  const status = await backend.request('/api/status');
  assert.equal(status.ok, true);
  assert.equal(status.mode, 'direct');
  assert.equal(status.version, '9.9.9');
  assert.equal(status.configured, false);
  assert.equal(status.key.source, 'none');
  assert.equal(status.baseUrl, 'http://fake.deepseek.local');
  assert.equal(status.storageAvailable, true);
});

test('未配置 Key 时搜索报 no_api_key', async () => {
  const { backend } = makeBackend();
  await assert.rejects(
    () => backend.request('/api/search', { query: 'DeepSeek', count: 5 }),
    (error) => error.code === 'no_api_key' && error.status === 401,
  );
});

test('保存 / 清除 Key，状态只返回掩码', async () => {
  const { backend, storage } = makeBackend();
  const invalid = await backend.request('/api/settings', { apiKey: 'not-a-key' }).catch((error) => error);
  assert.equal(invalid.code, 'invalid_api_key');

  const saved = await backend.request('/api/settings', { apiKey: 'sk-savedkey-1234567890' });
  assert.equal(saved.ok, true);
  assert.equal(saved.status.configured, true);
  assert.equal(saved.status.key.source, 'settings');
  assert.ok(saved.status.key.masked.includes('sk-'));
  assert.ok(!JSON.stringify(saved.status).includes('sk-savedkey-1234567890'));
  assert.equal(storage.getItem('dss.standalone.apiKey.v1'), 'sk-savedkey-1234567890');

  const cleared = await backend.request('/api/settings', { apiKey: '' });
  assert.equal(cleared.status.configured, false);
  assert.equal(storage.getItem('dss.standalone.apiKey.v1'), null);
});

test('搜索与缓存命中：相同查询只调用一次 API', async () => {
  const { backend, state } = makeBackend();
  await backend.request('/api/settings', { apiKey: 'sk-test-1234567890' });
  const first = await backend.request('/api/search', { query: 'DeepSeek', count: 5 });
  assert.equal(first.results.length, 1);
  assert.equal(first.results[0].title, '示例结果');
  assert.equal(first.meta.cached, false);
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].headers.Authorization, 'Bearer sk-test-1234567890');

  const second = await backend.request('/api/search', { query: 'DeepSeek', count: 5 });
  assert.equal(second.meta.cached, true);
  assert.equal(state.calls.length, 1);
  assert.equal(backend._internals.stats.searches, 1);
  assert.equal(backend._internals.stats.cachedSearches, 1);
});

test('未指定 count 时使用默认 30 条，且缓存键与请求一致', async () => {
  const { backend, state } = makeBackend();
  await backend.request('/api/settings', { apiKey: 'sk-test-1234567890' });
  await backend.request('/api/search', { query: 'DeepSeek' });
  assert.equal(state.calls[0].body.count, 30);
  await backend.request('/api/search', { query: 'DeepSeek', count: 30 });
  assert.equal(state.calls.length, 1, '默认 30 与显式 30 应共享缓存');
});

test('Fetch 归一化 URL 缓存（域名 + 末尾斜杠不重复抓取）', async () => {
  const { backend, state } = makeBackend();
  await backend.request('/api/settings', { apiKey: 'sk-test-1234567890' });
  const first = await backend.request('/api/fetch', { url: 'https://normalize.example' });
  assert.equal(first.title, '页面标题');
  assert.equal(first.meta.cached, false);
  const second = await backend.request('/api/fetch', { url: 'https://normalize.example/' });
  assert.equal(second.meta.cached, true);
  assert.equal(state.calls.length, 1);
});

test('非法 Fetch URL 被拒绝', async () => {
  const { backend } = makeBackend();
  await backend.request('/api/settings', { apiKey: 'sk-test-1234567890' });
  await assert.rejects(
    () => backend.request('/api/fetch', { url: 'javascript:alert(1)' }),
    (error) => error.code === 'invalid_url' && error.status === 400,
  );
});

test('测试连接与上游错误映射', async () => {
  const { backend, state } = makeBackend();
  const noKey = await backend.request('/api/test', {});
  assert.equal(noKey.ok, false);
  assert.equal(noKey.error.code, 'no_api_key');

  await backend.request('/api/settings', { apiKey: 'sk-test-1234567890' });
  const ok = await backend.request('/api/test', {});
  assert.equal(ok.ok, true);
  assert.equal(ok.sample.title, '示例结果');
  assert.equal(ok.source, 'settings');

  state.failStatus = 401;
  await assert.rejects(
    () => backend.request('/api/search', { query: 'x', count: 1 }),
    (error) => error.status === 401 && /API Key/.test(error.message),
  );
});

test('嵌入 Key：没有本地保存时自动使用，清除保存后仍可用', async () => {
  const storage = memoryStorage();
  const state = { calls: [], failStatus: 0 };
  const backend = createDirectBackend({
    fetchImpl: makeFetch(state),
    storage,
    embeddedKey: 'sk-embedded-1234567890',
    baseUrl: 'http://fake.deepseek.local',
  });
  const status = await backend.request('/api/status');
  assert.equal(status.configured, true);
  assert.equal(status.key.source, 'embedded');

  await backend.request('/api/search', { query: 'DeepSeek', count: 1 });
  assert.equal(state.calls[0].headers.Authorization, 'Bearer sk-embedded-1234567890');

  const cleared = await backend.request('/api/settings', { apiKey: '' });
  assert.equal(cleared.status.configured, true);
  assert.equal(cleared.status.key.source, 'embedded');
});

test('本地存储不可用：仍可在本次会话使用 Key，并标记 storageAvailable=false', async () => {
  const state = { calls: [], failStatus: 0 };
  const backend = createDirectBackend({
    fetchImpl: makeFetch(state),
    storage: null,
    embeddedKey: '',
    baseUrl: 'http://fake.deepseek.local',
  });
  const initial = await backend.request('/api/status');
  assert.equal(initial.storageAvailable, false);
  await backend.request('/api/settings', { apiKey: 'sk-memory-1234567890' });
  const status = await backend.request('/api/status');
  assert.equal(status.configured, true);
  await backend.request('/api/search', { query: 'DeepSeek', count: 1 });
  assert.equal(state.calls.length, 1);
});

test('清空缓存后再次搜索会重新调用 API', async () => {
  const { backend, state } = makeBackend();
  await backend.request('/api/settings', { apiKey: 'sk-test-1234567890' });
  await backend.request('/api/search', { query: 'DeepSeek', count: 1 });
  await backend.request('/api/cache', undefined, { method: 'DELETE' });
  await backend.request('/api/search', { query: 'DeepSeek', count: 1 });
  assert.equal(state.calls.length, 2);
  const status = await backend.request('/api/status');
  assert.equal(status.cache.search.size, 1);
});
