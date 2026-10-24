/**
 * 单文件版后端：浏览器直接调用 DeepSeek Search / Fetch API。
 *
 * 与 backend-server.js 共享同一个 request(path, body, {method, signal}) 契约，
 * 上层 app.js 不需要感知两种模式。API Key 只保存在浏览器本地存储
 * （或构建时嵌入 window.__DSS_EMBEDDED_KEY__），不会上传给除 DeepSeek 之外的服务器。
 */
import { ApiError, DEFAULT_BASE_URL, fetchPage, search, validateFetchInput } from './deepseek-client.js';
import { TTLCache } from './cache.js';
import { isValidApiKey, maskKey, validateApiKey } from './key-utils.js';

const KEY_STORAGE = 'dss.standalone.apiKey.v1';
const SEARCH_TTL_MS = 5 * 60_000;
const FETCH_TTL_MS = 30 * 60_000;
const DEFAULT_COUNT = 30;

const KEY_LABELS = Object.freeze({
  settings: '浏览器本地保存的密钥',
  embedded: '构建时嵌入的密钥',
  none: '未配置',
});

function probeStorage() {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;
    const probeKey = '__dss_storage_probe__';
    storage.setItem(probeKey, '1');
    storage.removeItem(probeKey);
    return storage;
  } catch {
    return null;
  }
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

/**
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] 便于测试注入
 * @param {{getItem:Function,setItem:Function,removeItem:Function}} [options.storage]
 * @param {string} [options.embeddedKey] 构建时嵌入的 Key
 * @param {string} [options.baseUrl]
 * @param {string} [options.version]
 */
export function createDirectBackend(options = {}) {
  const now = options.now || (() => Date.now());
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const baseUrl = options.baseUrl || globalThis.__DSS_BASE_URL__ || DEFAULT_BASE_URL;
  const version = options.version || globalThis.__DSS_VERSION__ || '1.0.0';
  const embeddedKey = String(
    options.embeddedKey !== undefined ? options.embeddedKey : globalThis.__DSS_EMBEDDED_KEY__ || '',
  ).trim();
  const storage = options.storage !== undefined ? options.storage : probeStorage();
  const keyStore = storage || memoryStorage();
  const persistentStorage = Boolean(storage);

  const searchCache = new TTLCache({ ttlMs: options.searchTtlMs || SEARCH_TTL_MS, max: 100 });
  const fetchCache = new TTLCache({ ttlMs: options.fetchTtlMs || FETCH_TTL_MS, max: 60 });
  const stats = {
    startedAt: now(),
    searches: 0,
    fetches: 0,
    cachedSearches: 0,
    cachedFetches: 0,
    lastSearchAt: null,
    lastQuery: null,
    lastErrorAt: null,
    lastErrorMessage: null,
  };

  function readSavedKey() {
    try {
      return String(keyStore.getItem(KEY_STORAGE) || '').trim();
    } catch {
      return '';
    }
  }

  function writeSavedKey(value) {
    try {
      if (value) keyStore.setItem(KEY_STORAGE, value);
      else keyStore.removeItem(KEY_STORAGE);
    } catch {
      /* 存储失败时仍然让本次会话可用 */
    }
  }

  function resolveKey() {
    const saved = readSavedKey();
    if (saved && isValidApiKey(saved)) return { key: saved, source: 'settings' };
    if (embeddedKey && isValidApiKey(embeddedKey)) return { key: embeddedKey, source: 'embedded' };
    return { key: null, source: 'none' };
  }

  function requireKey() {
    const info = resolveKey();
    if (!info.key) {
      throw new ApiError('尚未配置 DeepSeek API Key，请先在设置中填写。', {
        status: 401,
        code: 'no_api_key',
      });
    }
    return info;
  }

  function status() {
    const keyInfo = resolveKey();
    return {
      ok: true,
      app: 'DeepSeek 搜索',
      version,
      mode: 'direct',
      configured: Boolean(keyInfo.key),
      key: {
        source: keyInfo.source,
        label: KEY_LABELS[keyInfo.source],
        masked: keyInfo.key ? maskKey(keyInfo.key) : '',
      },
      baseUrl,
      defaults: { count: DEFAULT_COUNT },
      storageAvailable: persistentStorage,
      stats: {
        startedAt: stats.startedAt,
        uptimeSec: Math.round((now() - stats.startedAt) / 1000),
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
        search: {
          size: searchCache.size,
          ttlSec: SEARCH_TTL_MS / 1000,
          hits: searchCache.stats.hits,
          misses: searchCache.stats.misses,
          evictions: searchCache.stats.evictions,
        },
        fetch: {
          size: fetchCache.size,
          ttlSec: FETCH_TTL_MS / 1000,
          hits: fetchCache.stats.hits,
          misses: fetchCache.stats.misses,
          evictions: fetchCache.stats.evictions,
        },
      },
    };
  }

  async function handleSearch(body, { signal } = {}) {
    const { key, source } = requireKey();
    const query = typeof body?.query === 'string' ? body.query.trim() : '';
    const count = body?.count === undefined ? DEFAULT_COUNT : Number(body.count);
    const oriQuestion = typeof body?.oriQuestion === 'string' ? body.oriQuestion : undefined;
    const start = now();
    const cacheKey = JSON.stringify([query, count, oriQuestion || '']);

    const cached = searchCache.get(cacheKey);
    if (cached) {
      stats.cachedSearches += 1;
      return {
        ...cached.value,
        meta: { ...cached.value.meta, cached: true, cacheAgeMs: cached.ageMs, ms: now() - start },
      };
    }

    const result = await search(
      { query, count, oriQuestion },
      { apiKey: key, baseUrl, fetchImpl, retries: 1, signal },
    );
    searchCache.set(cacheKey, result);
    stats.searches += 1;
    stats.lastSearchAt = new Date().toISOString();
    stats.lastQuery = query;
    return {
      ...result,
      meta: { ...result.meta, cached: false, cacheAgeMs: 0, ms: now() - start, keySource: source },
    };
  }

  async function handleFetch(body, { signal } = {}) {
    const { key } = requireKey();
    const start = now();
    const { url } = validateFetchInput({ url: body?.url });

    const cached = fetchCache.get(url);
    if (cached) {
      stats.cachedFetches += 1;
      return {
        ...cached.value,
        meta: { ...cached.value.meta, cached: true, cacheAgeMs: cached.ageMs, ms: now() - start },
      };
    }

    const result = await fetchPage({ url }, { apiKey: key, baseUrl, fetchImpl, retries: 1, signal });
    fetchCache.set(url, result);
    stats.fetches += 1;
    return {
      ...result,
      meta: { ...result.meta, cached: false, cacheAgeMs: 0, ms: now() - start },
    };
  }

  function handleSettings(body) {
    if (Object.prototype.hasOwnProperty.call(body || {}, 'apiKey')) {
      const raw = body.apiKey;
      if (raw === null || raw === '') {
        writeSavedKey('');
      } else {
        const check = validateApiKey(raw);
        if (!check.ok) {
          throw new ApiError(check.message, { status: 400, code: 'invalid_api_key' });
        }
        writeSavedKey(check.key);
      }
    }
    return { ok: true, status: status(), defaults: { count: DEFAULT_COUNT } };
  }

  async function handleTest(body, { signal } = {}) {
    let apiKey;
    let source;
    if (typeof body?.apiKey === 'string' && body.apiKey.trim()) {
      const check = validateApiKey(body.apiKey);
      if (!check.ok) {
        return { ok: false, error: { code: 'invalid_api_key', message: check.message } };
      }
      apiKey = check.key;
      source = 'input';
    } else {
      const keyInfo = resolveKey();
      if (!keyInfo.key) {
        return { ok: false, error: { code: 'no_api_key', message: '尚未配置 API Key。' } };
      }
      apiKey = keyInfo.key;
      source = keyInfo.source;
    }

    try {
      const result = await search(
        { query: 'DeepSeek', count: 1 },
        { apiKey, baseUrl, fetchImpl, timeoutMs: 15_000, retries: 0, signal },
      );
      return {
        ok: true,
        source,
        ms: result.meta.ms,
        sample: result.results[0] ? { title: result.results[0].title, url: result.results[0].url } : null,
        note: '本次测试会产生一次 Search API 调用（按成功请求计费）。',
      };
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError(String(error?.message || error));
      return { ok: false, source, error: apiError.toJSON() };
    }
  }

  async function request(path, body, { method, signal } = {}) {
    const verb = method || (body === undefined ? 'GET' : 'POST');
    try {
      if (path === '/api/status' && verb === 'GET') return status();
      if (path === '/api/search' && verb === 'POST') return await handleSearch(body, { signal });
      if (path === '/api/fetch' && verb === 'POST') return await handleFetch(body, { signal });
      if (path === '/api/settings' && (verb === 'POST' || verb === 'PUT')) return handleSettings(body);
      if (path === '/api/test' && verb === 'POST') return await handleTest(body, { signal });
      if (path === '/api/cache' && verb === 'DELETE') {
        searchCache.clear();
        fetchCache.clear();
        return { ok: true };
      }
      throw new ApiError('接口不存在。', { status: 404, code: 'not_found' });
    } catch (error) {
      stats.lastErrorAt = new Date().toISOString();
      stats.lastErrorMessage = error?.message || String(error);
      throw error;
    }
  }

  return {
    mode: 'direct',
    request,
    status,
    // 便于单测/调试
    _internals: { searchCache, fetchCache, stats, resolveKey },
  };
}
