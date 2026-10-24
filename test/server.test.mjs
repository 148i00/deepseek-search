import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 必须在导入 config / server 之前设置：使用临时数据目录 + 测试密钥
const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-search-test-'));
process.env.DSH_SEARCH_DATA = tempDataDir;
process.env.DEEPSEEK_API_KEY = 'sk-test-1234567890';

const { createApp } = await import('../server.mjs');

const SEARCH_PAYLOAD = {
  results: [
    {
      rerank_score: 2.5,
      title: 'Example 结果',
      url: 'https://example.com/page',
      snippet: '示例摘要',
      summary: '更长的示例摘要',
      content: '',
      site_name: 'Example',
      site_icon: 'https://example.com/favicon.ico',
      date: '2026-01-01T00:00:00+00:00',
      authority: 4,
    },
    {
      rerank_score: 1.2,
      title: '危险链接',
      url: 'javascript:alert(1)',
      snippet: 'x',
      summary: '',
      content: '',
      site_name: null,
      site_icon: 'javascript:alert(2)',
      date: null,
      authority: -1,
    },
  ],
};

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeUpstream(calls) {
  return async (url, options) => {
    const parsed = new URL(url);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path: parsed.pathname, body, auth: options.headers.Authorization });
    if (parsed.pathname === '/v1/tools/search') {
      if (body.query === 'trigger-401') {
        return jsonResponse(
          { error: { message: 'Authentication Fails', type: 'authentication_error', param: null, code: 'invalid_request_error' } },
          401,
        );
      }
      if (body.query === 'trigger-empty') {
        return jsonResponse({ results: [] });
      }
      return jsonResponse(SEARCH_PAYLOAD);
    }
    if (parsed.pathname === '/v1/tools/fetch') {
      return jsonResponse({ title: '页面标题', content: '# 页面标题\n\n正文内容' });
    }
    return jsonResponse({ error: { message: 'not found' } }, 404);
  };
}

function requestRaw(port, { method = 'GET', path = '/', headers = {}, body = null, setHost = true } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, setHost }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('服务端集成测试', async (t) => {
  const upstreamCalls = [];
  const app = createApp({
    fetchImpl: makeUpstream(upstreamCalls),
    baseUrl: 'http://fake.deepseek.local',
    retries: 0,
  });
  const server = http.createServer(app.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDataDir, { recursive: true, force: true });
  });

  const api = async (pathname, { method = 'GET', body } = {}) => {
    const response = await fetch(`${base}${pathname}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON */
    }
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), json, text };
  };

  await t.test('GET /api/status 返回已配置状态且不泄露密钥', async () => {
    const { status, json } = await api('/api/status');
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.configured, true);
    assert.equal(json.key.source, 'env');
    assert.ok(!JSON.stringify(json).includes('sk-test-1234567890'));
    assert.ok(json.key.masked.includes('sk-'));
    assert.equal(json.baseUrl, 'http://fake.deepseek.local');
  });

  await t.test('POST /api/search 返回归一化结果并过滤危险 URL', async () => {
    const { status, json } = await api('/api/search', { method: 'POST', body: { query: 'DeepSeek', count: 5 } });
    assert.equal(status, 200);
    assert.equal(json.results.length, 2);
    assert.equal(json.results[0].title, 'Example 结果');
    assert.equal(json.results[0].authority, 4);
    assert.equal(json.results[1].url, '', 'javascript: URL 应被丢弃');
    assert.equal(json.results[1].siteIcon, null);
    assert.equal(json.meta.cached, false);
    assert.equal(upstreamCalls.length, 1);
    assert.equal(upstreamCalls[0].auth, 'Bearer sk-test-1234567890');
    assert.deepEqual(upstreamCalls[0].body, { query: 'DeepSeek', count: 5, need_content: false });
  });

  await t.test('相同查询命中本地缓存，不重复调用上游', async () => {
    const { json } = await api('/api/search', { method: 'POST', body: { query: 'DeepSeek', count: 5 } });
    assert.equal(json.meta.cached, true);
    assert.equal(upstreamCalls.length, 1);
    assert.equal(app.stats.cachedSearches, 1);
  });

  await t.test('参数校验：空查询与非法 count', async () => {
    const empty = await api('/api/search', { method: 'POST', body: { query: '   ' } });
    assert.equal(empty.status, 400);
    assert.equal(empty.json.error.code, 'invalid_query');

    const badCount = await api('/api/search', { method: 'POST', body: { query: 'x', count: 0 } });
    assert.equal(badCount.status, 400);
    assert.equal(badCount.json.error.code, 'invalid_count');

    const tooLong = await api('/api/search', { method: 'POST', body: { query: 'x'.repeat(129) } });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.json.error.code, 'query_too_long');
  });

  await t.test('超大请求体返回 413（而不是直接断开连接）', async () => {
    const body = JSON.stringify({ query: 'x'.repeat(70 * 1024) });
    const response = await requestRaw(port, {
      method: 'POST',
      path: '/api/search',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
      },
      body,
    });
    assert.equal(response.status, 413);
    assert.ok(response.text.includes('body_too_large'), response.text);
  });

  await t.test('上游 401 被映射为友好的错误信息', async () => {
    const { status, json } = await api('/api/search', { method: 'POST', body: { query: 'trigger-401' } });
    assert.equal(status, 401);
    assert.ok(json.error.message.includes('API Key'));
  });

  await t.test('搜索无结果时返回空数组', async () => {
    const { status, json } = await api('/api/search', { method: 'POST', body: { query: 'trigger-empty' } });
    assert.equal(status, 200);
    assert.deepEqual(json.results, []);
  });

  await t.test('POST /api/fetch 抓取并缓存正文', async () => {
    const first = await api('/api/fetch', { method: 'POST', body: { url: 'https://example.com/page' } });
    assert.equal(first.status, 200);
    assert.equal(first.json.title, '页面标题');
    assert.ok(first.json.content.includes('# 页面标题'));
    assert.equal(first.json.meta.cached, false);

    const second = await api('/api/fetch', { method: 'POST', body: { url: 'https://example.com/page' } });
    assert.equal(second.json.meta.cached, true);
    assert.equal(app.stats.cachedFetches, 1);
  });

  await t.test('Fetch 缓存使用归一化 URL（域名 + 末尾斜杠不重复计费）', async () => {
    const before = upstreamCalls.filter((call) => call.path === '/v1/tools/fetch').length;
    const first = await api('/api/fetch', { method: 'POST', body: { url: 'https://normalize.example' } });
    assert.equal(first.status, 200);
    assert.equal(first.json.meta.cached, false);
    const second = await api('/api/fetch', { method: 'POST', body: { url: 'https://normalize.example/' } });
    assert.equal(second.json.meta.cached, true);
    const after = upstreamCalls.filter((call) => call.path === '/v1/tools/fetch').length;
    assert.equal(after - before, 1);
  });

  await t.test('POST /api/fetch 拒绝非法 URL', async () => {
    const bad = await api('/api/fetch', { method: 'POST', body: { url: 'javascript:alert(1)' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'invalid_url');

    const file = await api('/api/fetch', { method: 'POST', body: { url: 'file:///etc/passwd' } });
    assert.equal(file.status, 400);
  });

  await t.test('POST /api/settings 校验并保存密钥', async () => {
    const invalid = await api('/api/settings', { method: 'POST', body: { apiKey: 'not-a-key' } });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.error.code, 'invalid_api_key');

    const saved = await api('/api/settings', { method: 'POST', body: { apiKey: 'sk-savedkey-9876543210', defaultCount: 20 } });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.status.configured, true);
    assert.equal(saved.json.status.key.source, 'settings');
    assert.equal(saved.json.status.defaults.count, 20);

    const config = JSON.parse(fs.readFileSync(path.join(tempDataDir, 'config.json'), 'utf8'));
    assert.equal(config.apiKey, 'sk-savedkey-9876543210');

    // 新搜索应使用保存的密钥，并默认使用新的 count
    const search = await api('/api/search', { method: 'POST', body: { query: 'after-save' } });
    assert.equal(search.status, 200);
    assert.equal(upstreamCalls.at(-1).auth, 'Bearer sk-savedkey-9876543210');
    assert.equal(upstreamCalls.at(-1).body.count, 20);
  });

  await t.test('POST /api/test 用保存的密钥做一次真实探测', async () => {
    const { status, json } = await api('/api/test', { method: 'POST', body: {} });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.ok(json.sample.title);
  });

  await t.test('静态页面与 SPA 路由', async () => {
    const home = await api('/');
    assert.equal(home.status, 200);
    assert.ok(home.text.includes('DeepSeek 搜索'));
    assert.ok(home.headers['content-security-policy'].includes("default-src 'self'"));
    assert.ok(home.headers['content-security-policy'].includes("script-src 'self'"));

    const searchRoute = await api('/search?q=DeepSeek');
    assert.equal(searchRoute.status, 200);
    assert.ok(searchRoute.text.includes('id="results-view"'));

    const css = await api('/styles.css');
    assert.equal(css.status, 200);
    assert.equal(css.headers['content-type'], 'text/css; charset=utf-8');

    const missing = await api('/nope.js');
    assert.equal(missing.status, 404);
  });

  await t.test('拒绝非本机 Host（防 DNS rebinding）', async () => {
    const response = await requestRaw(port, { path: '/api/status', headers: { Host: 'evil.example.com' } });
    assert.equal(response.status, 403);
  });

  await t.test('畸形 Host 不会导致进程崩溃', async () => {
    const bad = await requestRaw(port, { path: '/api/status', headers: { Host: '[' } });
    assert.equal(bad.status, 403);
    // 服务必须仍然存活
    const health = await requestRaw(port, { path: '/api/health' });
    assert.equal(health.status, 200);
  });

  await t.test('缺失 Host 时按不可信处理（HTTP/1.0 不放行）', async () => {
    const response = await requestRaw(port, { path: '/api/status', setHost: false });
    // Node 的 HTTP 解析器会直接以 400 拒绝缺少 Host 的 HTTP/1.1 请求；
    // 若请求到达应用层，则应由 Host 校验返回 403。
    assert.ok([400, 403].includes(response.status), `unexpected status ${response.status}`);
  });

  await t.test('拒绝跨站 Origin 与非 JSON 写请求（防跨站消耗额度）', async () => {
    const crossOrigin = await requestRaw(port, {
      method: 'POST',
      path: '/api/search',
      headers: {
        Origin: 'https://evil.example.com',
        'Content-Type': 'application/json',
        'Content-Length': '13',
      },
      body: '{"query":"x"}',
    });
    assert.equal(crossOrigin.status, 403);
    assert.ok(crossOrigin.text.includes('forbidden_origin'));

    const plainText = await requestRaw(port, {
      method: 'POST',
      path: '/api/search',
      headers: { 'Content-Type': 'text/plain', 'Content-Length': '13' },
      body: '{"query":"x"}',
    });
    assert.equal(plainText.status, 415);
    assert.ok(plainText.text.includes('unsupported_media_type'));
  });

  await t.test('同源 JSON 请求正常放行', async () => {
    const response = await requestRaw(port, {
      method: 'POST',
      path: '/api/search',
      headers: {
        Origin: `http://127.0.0.1:${port}`,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': '13',
      },
      body: '{"query":"x"}',
    });
    assert.equal(response.status, 200);
  });

  await t.test('阻止静态目录穿越', async () => {
    const response = await requestRaw(port, { path: '/..%2fserver.mjs' });
    assert.equal(response.status, 403);
  });

  await t.test('未知 API 返回 JSON 404', async () => {
    const { status, json } = await api('/api/unknown');
    assert.equal(status, 404);
    assert.equal(json.error.code, 'not_found');
  });

  await t.test('DELETE /api/cache 清空缓存', async () => {
    const { status, json } = await api('/api/cache', { method: 'DELETE' });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(app.caches.search.size, 0);
    assert.equal(app.caches.fetch.size, 0);
  });

  await t.test('GET /api/health', async () => {
    const { status, json } = await api('/api/health');
    assert.equal(status, 200);
    assert.equal(json.ok, true);
  });
});
