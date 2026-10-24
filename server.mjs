#!/usr/bin/env node
/**
 * DeepSeek 搜索 —— 本地 Web 服务（零依赖）。
 *
 *   node server.mjs [--open] [--port 8787]
 *
 * 仅监听 127.0.0.1；API Key 只在服务端使用。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  PROJECT_ROOT,
  SOURCE_LABELS,
  maskKey,
  readConfig,
  resolveApiKey,
  validateApiKey,
  writeConfig,
} from './src/config.mjs';
import { TTLCache } from './src/cache.mjs';
import { ApiError, DEFAULT_BASE_URL, fetchPage, search, validateFetchInput } from './src/deepseek.mjs';

export const VERSION = '1.0.0';
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const SEARCH_TTL_MS = 5 * 60_000;
const FETCH_TTL_MS = 30 * 60_000;
const MAX_BODY_BYTES = 64 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
};

const CSP = [
  "default-src 'self'",
  "img-src 'self' https: data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "font-src 'self' data:",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function log(...args) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}]`, ...args);
}

function json(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

function text(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const fail = (error) => {
      if (settled) return;
      settled = true;
      // 不 destroy 请求：让 413 响应能正常写回；继续消费剩余数据避免连接卡住。
      reject(error);
      req.resume();
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(new ApiError('请求体过大。', { status: 413, code: 'body_too_large' }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new ApiError('请求体必须是 JSON 对象。', { status: 400, code: 'invalid_json' }));
        }
        resolve(parsed);
      } catch {
        reject(new ApiError('请求体不是合法的 JSON。', { status: 400, code: 'invalid_json' }));
      }
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function isLocalHost(hostHeader) {
  // HTTP/1.1 必须带 Host；缺失时按不可信处理，避免校验被绕过。
  if (!hostHeader) return false;
  const host = String(hostHeader).toLowerCase().replace(/:\d+$/, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

/** 阻止其他网站的跨站请求偷偷花掉 API 额度（同源校验）。 */
function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new ApiError('请求来源不合法。', { status: 403, code: 'forbidden_origin' });
  }
  const host = String(req.headers.host || '').toLowerCase();
  if (parsed.host.toLowerCase() !== host.toLowerCase()) {
    throw new ApiError('拒绝跨站请求。', { status: 403, code: 'forbidden_origin' });
  }
}

function serveStatic(req, res, pathname) {
  let rel = pathname;
  if (rel === '/' || rel === '/search' || rel === '/index.html') rel = '/index.html';
  let decoded;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return text(res, 400, 'Bad Request');
  }
  if (decoded.includes('\0')) return text(res, 400, 'Bad Request');
  const filePath = path.resolve(PUBLIC_DIR, `.${decoded}`);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return text(res, 403, 'Forbidden');
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      return text(res, 404, 'Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const headers = {
      'Content-Type': type,
      'Content-Length': stat.size,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    };
    if (ext === '.html') {
      headers['Cache-Control'] = 'no-cache';
      headers['Content-Security-Policy'] = CSP;
    } else {
      headers['Cache-Control'] = 'no-cache';
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(filePath);
    stream.on('error', (error) => {
      log('静态文件读取失败：', filePath, error?.message || error);
      if (!res.headersSent) {
        text(res, 500, 'Internal Server Error');
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
  });
}

function buildStatus({ caches, stats, baseUrl = DEFAULT_BASE_URL }) {
  const config = readConfig();
  const keyInfo = resolveApiKey(config);
  return {
    ok: true,
    app: 'DeepSeek 搜索',
    version: VERSION,
    mode: 'server',
    configured: Boolean(keyInfo.key),
    key: {
      source: keyInfo.source,
      label: SOURCE_LABELS[keyInfo.source],
      masked: keyInfo.key ? maskKey(keyInfo.key) : '',
    },
    baseUrl,
    defaults: { count: config.defaultCount },
    stats: {
      startedAt: stats.startedAt,
      uptimeSec: Math.round((Date.now() - stats.startedAt) / 1000),
      searches: stats.searches,
      fetches: stats.fetches,
      cachedSearches: stats.cachedSearches,
      cachedFetches: stats.cachedFetches,
      lastSearchAt: stats.lastSearchAt,
      lastQuery: stats.lastQuery,
      lastErrorAt: stats.lastErrorAt,
      lastErrorMessage: stats.lastErrorMessage,
    },
    cache: {
      search: { size: caches.search.size, ttlSec: SEARCH_TTL_MS / 1000, ...caches.search.stats },
      fetch: { size: caches.fetch.size, ttlSec: FETCH_TTL_MS / 1000, ...caches.fetch.stats },
    },
  };
}

/**
 * 创建应用（便于测试时注入假上游）。
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] 注入给 DeepSeek 客户端的 fetch
 * @param {string} [options.baseUrl] DeepSeek API base URL
 * @param {number} [options.searchTimeoutMs]
 * @param {number} [options.fetchTimeoutMs]
 */
export function createApp(options = {}) {
  const caches = { search: new TTLCache({ ttlMs: SEARCH_TTL_MS, max: 200 }), fetch: new TTLCache({ ttlMs: FETCH_TTL_MS, max: 100 }) };
  const stats = {
    startedAt: Date.now(),
    searches: 0,
    fetches: 0,
    cachedSearches: 0,
    cachedFetches: 0,
    lastSearchAt: null,
    lastQuery: null,
    lastErrorAt: null,
    lastErrorMessage: null,
  };
  const apiOptions = {
    fetchImpl: options.fetchImpl || globalThis.fetch,
    baseUrl: options.baseUrl || process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL,
    timeoutMs: options.searchTimeoutMs || 15_000,
    retries: options.retries ?? 1,
  };
  const fetchOptions = {
    fetchImpl: options.fetchImpl || globalThis.fetch,
    baseUrl: apiOptions.baseUrl,
    timeoutMs: options.fetchTimeoutMs || 30_000,
    retries: options.retries ?? 1,
  };

  function handleApiError(res, error) {
    const err =
      error instanceof ApiError
        ? error
        : new ApiError(error?.message || '服务器内部错误。', { status: 500, code: 'internal_error' });
    stats.lastErrorAt = new Date().toISOString();
    stats.lastErrorMessage = err.message;
    if (err.status >= 500) log('API ERROR', err.code, err.message);
    json(res, err.status, { error: err.toJSON() });
  }

  const handler = async (req, res) => {
    const startedAt = Date.now();
    const method = req.method || 'GET';
    let pathname = '/';

    try {
      let url;
      try {
        url = new URL(req.url || '/', 'http://127.0.0.1');
      } catch {
        return text(res, 400, 'Bad Request');
      }
      pathname = url.pathname;

      if (!isLocalHost(req.headers.host)) {
        return text(res, 403, 'Forbidden: only localhost access is allowed.');
      }

      // 所有 API 请求校验同源；带请求体的写操作必须是 JSON
      if (pathname.startsWith('/api/')) {
        assertSameOrigin(req);
        if (method === 'POST' || method === 'PUT') {
          const contentType = String(req.headers['content-type'] || '');
          if (!/^application\/json\b/i.test(contentType)) {
            throw new ApiError('请求必须使用 Content-Type: application/json。', {
              status: 415,
              code: 'unsupported_media_type',
            });
          }
        }
      }

      if (pathname === '/api/status' && method === 'GET') {
        return json(res, 200, buildStatus({ caches, stats, baseUrl: apiOptions.baseUrl }));
      }

      if (pathname === '/api/health' && method === 'GET') {
        return json(res, 200, { ok: true, uptimeSec: Math.round((Date.now() - stats.startedAt) / 1000) });
      }

      if (pathname === '/api/search' && method === 'POST') {
        const body = await readJsonBody(req);
        const query = typeof body.query === 'string' ? body.query.trim() : '';
        const count = body.count === undefined ? readConfig().defaultCount : Number(body.count);
        const oriQuestion = typeof body.oriQuestion === 'string' ? body.oriQuestion : undefined;
        const cacheKey = JSON.stringify([query, count, oriQuestion || '']);
        const cached = caches.search.get(cacheKey);
        if (cached) {
          stats.cachedSearches += 1;
          return json(res, 200, {
            ...cached.value,
            meta: {
              ...cached.value.meta,
              cached: true,
              cacheAgeMs: cached.ageMs,
              ms: Date.now() - startedAt,
            },
          });
        }
        const keyInfo = resolveApiKey();
        if (!keyInfo.key) {
          throw new ApiError('尚未配置 DeepSeek API Key，请先在设置中填写。', {
            status: 401,
            code: 'no_api_key',
          });
        }
        const result = await search(
          { query, count, oriQuestion },
          { ...apiOptions, apiKey: keyInfo.key },
        );
        caches.search.set(cacheKey, result);
        stats.searches += 1;
        stats.lastSearchAt = new Date().toISOString();
        stats.lastQuery = query;
        return json(res, 200, {
          ...result,
          meta: { ...result.meta, cached: false, cacheAgeMs: 0, ms: Date.now() - startedAt },
        });
      }

      if (pathname === '/api/fetch' && method === 'POST') {
        const body = await readJsonBody(req);
        const { url: fetchUrl } = validateFetchInput({
          url: typeof body.url === 'string' ? body.url : '',
        });
        const cached = caches.fetch.get(fetchUrl);
        if (cached) {
          stats.cachedFetches += 1;
          return json(res, 200, {
            ...cached.value,
            meta: { ...cached.value.meta, cached: true, cacheAgeMs: cached.ageMs, ms: Date.now() - startedAt },
          });
        }
        const keyInfo = resolveApiKey();
        if (!keyInfo.key) {
          throw new ApiError('尚未配置 DeepSeek API Key，请先在设置中填写。', {
            status: 401,
            code: 'no_api_key',
          });
        }
        const result = await fetchPage({ url: fetchUrl }, { ...fetchOptions, apiKey: keyInfo.key });
        caches.fetch.set(fetchUrl, result);
        stats.fetches += 1;
        return json(res, 200, {
          ...result,
          meta: { ...result.meta, cached: false, cacheAgeMs: 0, ms: Date.now() - startedAt },
        });
      }

      if (pathname === '/api/settings' && (method === 'POST' || method === 'PUT')) {
        const body = await readJsonBody(req);
        const patch = {};
        if (Object.prototype.hasOwnProperty.call(body, 'apiKey')) {
          const raw = body.apiKey;
          if (raw === null || raw === '') {
            patch.apiKey = '';
          } else {
            const check = validateApiKey(raw);
            if (!check.ok) {
              throw new ApiError(check.message, { status: 400, code: 'invalid_api_key' });
            }
            patch.apiKey = check.key;
          }
        }
        if (body.defaultCount !== undefined) {
          const n = Number(body.defaultCount);
          if (!Number.isInteger(n) || n < 10 || n > 50) {
            throw new ApiError('默认结果数必须是 10～50 之间的整数。', {
              status: 400,
              code: 'invalid_count',
            });
          }
          patch.defaultCount = n;
        }
        const next = writeConfig(patch);
        log('设置已更新：', Object.keys(patch).join(', ') || '(无变化)');
        return json(res, 200, {
          ok: true,
          status: buildStatus({ caches, stats, baseUrl: apiOptions.baseUrl }),
          defaults: { count: next.defaultCount },
        });
      }

      if (pathname === '/api/test' && method === 'POST') {
        const body = await readJsonBody(req);
        let apiKey;
        let source = 'settings';
        if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
          const check = validateApiKey(body.apiKey);
          if (!check.ok) return json(res, 200, { ok: false, error: { code: 'invalid_api_key', message: check.message } });
          apiKey = check.key;
          source = 'input';
        } else {
          const keyInfo = resolveApiKey();
          if (!keyInfo.key) {
            return json(res, 200, {
              ok: false,
              error: { code: 'no_api_key', message: '尚未配置 API Key。' },
            });
          }
          apiKey = keyInfo.key;
          source = keyInfo.source;
        }
        try {
          const result = await search(
            { query: 'DeepSeek', count: 1 },
            { ...apiOptions, apiKey, timeoutMs: Math.min(apiOptions.timeoutMs, 15_000) },
          );
          return json(res, 200, {
            ok: true,
            source,
            ms: result.meta.ms,
            sample: result.results[0] ? { title: result.results[0].title, url: result.results[0].url } : null,
            note: '本次测试会产生一次 Search API 调用（按成功请求计费）。',
          });
        } catch (error) {
          const err = error instanceof ApiError ? error : new ApiError(String(error?.message || error));
          return json(res, 200, { ok: false, source, error: err.toJSON() });
        }
      }

      if (pathname === '/api/cache' && method === 'DELETE') {
        caches.search.clear();
        caches.fetch.clear();
        return json(res, 200, { ok: true });
      }

      if (pathname.startsWith('/api/')) {
        return json(res, 404, { error: { code: 'not_found', message: '接口不存在。' } });
      }

      if (method === 'GET' || method === 'HEAD') {
        return serveStatic(req, res, pathname);
      }

      return text(res, 405, 'Method Not Allowed');
    } catch (error) {
      return handleApiError(res, error);
    } finally {
      const durationMs = Date.now() - startedAt;
      if (pathname.startsWith('/api/') && pathname !== '/api/status') {
        log(`${method} ${pathname} ${res.statusCode} ${durationMs}ms`);
      }
    }
  };

  return { handler, caches, stats, apiOptions };
}

function listenOnce(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

export async function startServer({ port = Number(process.env.PORT) || 8787, open = false, ...options } = {}) {
  const app = createApp(options);
  const server = http.createServer((req, res) => {
    // 兜底：任何未预料的异常都不允许把进程带走
    Promise.resolve(app.handler(req, res)).catch((error) => {
      log('请求处理异常：', error?.stack || error);
      try {
        if (!res.headersSent) {
          json(res, 500, { error: { code: 'internal_error', message: '服务器内部错误。' } });
        } else {
          res.destroy();
        }
      } catch {
        /* 连接已断开 */
      }
    });
  });
  server.headersTimeout = 20_000;
  server.requestTimeout = 120_000;
  server.keepAliveTimeout = 5_000;

  let boundPort = null;
  for (let attempt = 0; attempt < 20 && boundPort === null; attempt += 1) {
    try {
      boundPort = await listenOnce(server, port + attempt);
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') throw error;
      log(`端口 ${port + attempt} 已被占用，尝试下一个…`);
    }
  }
  if (boundPort === null) {
    throw new Error(`找不到可用端口（${port}–${port + 19}）。`);
  }

  const url = `http://127.0.0.1:${boundPort}/`;
  const keyInfo = resolveApiKey();
  console.log('');
  console.log('  🔎  DeepSeek 搜索已启动');
  console.log(`      地址   ${url}`);
  console.log(`       密钥   ${keyInfo.key ? `${SOURCE_LABELS[keyInfo.source]}（${maskKey(keyInfo.key)}）` : '未配置 —— 打开页面后在「设置」中填写'}`);
  console.log(`       计费   Search / Fetch 每 1,000 次成功请求 5 元，本地缓存可减少重复调用`);
  console.log('');
  console.log('  按 Ctrl+C 停止服务。');
  console.log('');

  if (open) openBrowser(url);

  const close = () =>
    new Promise((resolve) => {
      server.close(() => resolve());
      setTimeout(resolve, 1500).unref?.();
    });

  return { server, app, url, port: boundPort, close };
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* 打开失败不影响服务 */
  }
}

const isMain = (() => {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  const args = process.argv.slice(2);
  const portArgIdx = args.indexOf('--port');
  const port = portArgIdx >= 0 ? Number(args[portArgIdx + 1]) : Number(process.env.PORT) || 8787;
  const open = args.includes('--open') || process.env.SEARCH_OPEN === '1';

  let handle = null;
  startServer({ port, open })
    .then((instance) => {
      handle = instance;
    })
    .catch((error) => {
      console.error('启动失败：', error);
      process.exitCode = 1;
    });

  process.on('unhandledRejection', (reason) => {
    console.error('未处理的 Promise 异常：', reason);
  });

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n收到 ${signal}，正在停止…`);
    try {
      if (handle) await handle.close();
    } catch {
      /* 忽略关闭错误 */
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
