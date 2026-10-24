/**
 * DeepSeek Search / Fetch API 客户端（零依赖，Node >= 20 原生 fetch）。
 * 文档：https://api-docs.deepseek.com/zh-cn/guides/search
 */

export const DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_TIMEOUT_SEARCH_MS = 15_000;
export const DEFAULT_TIMEOUT_FETCH_MS = 30_000;

export class ApiError extends Error {
  constructor(message, { status = 502, code = 'upstream_error', retryable = false, param = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.param = param;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      status: this.status,
      retryable: this.retryable,
    };
  }
}

const UPSTREAM_MESSAGES = {
  400: '请求不合法，请检查搜索词或参数。',
  401: 'DeepSeek API Key 无效或已失效，请在设置中检查密钥。',
  402: 'DeepSeek 账户余额不足，请先充值后重试。',
  403: '该请求被安全策略拒绝。',
  404: '未能获取可用的网页内容（目标站点不可用、被拦截或没有可提取的正文）。',
  408: '读取请求超时，请稍后重试。',
  413: '请求体超过大小限制。',
  429: '请求过于频繁（超过 QPS 限制），请稍候重试。',
  500: 'DeepSeek 服务端内部错误，请稍后重试。',
  502: '上游服务暂时不可用，请稍后重试。',
  503: 'DeepSeek 服务暂时不可用，请稍后重试。',
  504: '下游请求超时，请稍后重试。',
};

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeAbortError() {
  const error = new Error('请求已取消。');
  error.name = 'AbortError';
  error.code = 'aborted';
  return error;
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/** 统计 Unicode 字符数（与 API 的 1～128 个 Unicode 字符约束一致）。 */
function countUnicodeChars(str) {
  return typeof str === 'string' ? [...str].length : 0;
}

export function validateSearchInput({ query, count } = {}) {
  if (typeof query !== 'string') {
    throw new ApiError('搜索词不能为空。', { status: 400, code: 'invalid_query' });
  }
  const q = query.trim();
  if (!q) {
    throw new ApiError('搜索词不能为空。', { status: 400, code: 'invalid_query' });
  }
  if (countUnicodeChars(q) > 128) {
    throw new ApiError(
      `搜索词最多 128 个字符（当前 ${countUnicodeChars(q)} 个，包含 site: 等语法）。`,
      { status: 400, code: 'query_too_long' },
    );
  }
  let n = 10;
  if (count !== undefined && count !== null) {
    n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > 50) {
      throw new ApiError('count 必须是 1～50 之间的整数。', { status: 400, code: 'invalid_count' });
    }
  }
  return { query: q, count: n };
}

export function validateFetchInput({ url } = {}) {
  if (typeof url !== 'string' || !url.trim()) {
    throw new ApiError('缺少要抓取的网页地址。', { status: 400, code: 'invalid_url' });
  }
  const raw = url.trim();
  if (raw.length > 8192) {
    throw new ApiError('网页地址过长（上限 8192）。', { status: 400, code: 'invalid_url' });
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ApiError('网页地址格式不正确。', { status: 400, code: 'invalid_url' });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ApiError('只支持 http / https 网页地址。', { status: 400, code: 'invalid_url' });
  }
  if (!parsed.hostname) {
    throw new ApiError('网页地址缺少主机名。', { status: 400, code: 'invalid_url' });
  }
  if (parsed.username || parsed.password) {
    throw new ApiError('网页地址不能携带用户名或密码。', { status: 400, code: 'invalid_url' });
  }
  return { url: parsed.toString() };
}

function mapHttpError(status, payload) {
  const upstream = payload?.error || {};
  const message =
    UPSTREAM_MESSAGES[status] ||
    (typeof upstream.message === 'string' && upstream.message.trim()) ||
    `上游返回 HTTP ${status}。`;
  return new ApiError(message, {
    status,
    code: typeof upstream.code === 'string' && upstream.code ? upstream.code : `http_${status}`,
    retryable: RETRYABLE_STATUS.has(status),
    param: upstream.param ?? null,
  });
}

/**
 * 统一 POST JSON 请求，带超时、有限重试和错误归一化。
 * @returns {Promise<{ data: any, ms: number, status: number, attempts: number }>}
 */
export async function postJson(
  path,
  body,
  {
    apiKey,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_SEARCH_MS,
    retries = 1,
    signal,
  } = {},
) {
  if (!apiKey) {
    throw new ApiError('尚未配置 DeepSeek API Key。', { status: 401, code: 'no_api_key' });
  }
  const endpoint = `${normalizeBaseUrl(baseUrl)}${path}`;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    // 调用方已经取消：立即结束，绝不能进入重试（否则会重复发起计费请求）。
    if (signal?.aborted) throw makeAbortError();
    const startedAt = Date.now();
    let timedOut = false;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          throw new ApiError('上游返回了无法解析的响应。', {
            status: 502,
            code: 'invalid_response',
            retryable: true,
          });
        }
      }
      if (!response.ok) {
        lastError = mapHttpError(response.status, data);
        if (lastError.retryable && attempt < retries) {
          await sleep(400 * (attempt + 1));
          continue;
        }
        throw lastError;
      }
      return { data: data ?? {}, ms: Date.now() - startedAt, status: response.status, attempts: attempt + 1 };
    } catch (error) {
      // 区分「调用方主动取消」与「请求超时」：取消不重试，也不计费重发。
      if (!timedOut && signal?.aborted) {
        throw makeAbortError();
      }
      if (error instanceof ApiError) {
        if (error.retryable && attempt < retries && error === lastError) {
          await sleep(400 * (attempt + 1));
          continue;
        }
        throw error;
      }
      const causeCode = error?.cause?.code || error?.code;
      if (timedOut || error?.name === 'AbortError') {
        lastError = new ApiError('请求 DeepSeek API 超时，请稍后重试。', {
          status: 504,
          code: 'timeout',
          retryable: true,
        });
      } else if (NETWORK_CODES.has(causeCode) || error?.name === 'TypeError') {
        lastError = new ApiError('无法连接 DeepSeek API，请检查网络后重试。', {
          status: 502,
          code: 'network_error',
          retryable: true,
        });
      } else {
        lastError = new ApiError(`请求失败：${error?.message || '未知错误'}`, {
          status: 502,
          code: 'request_failed',
          retryable: true,
        });
      }
      if (attempt < retries) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
  throw lastError || new ApiError('请求失败。', { status: 502, code: 'request_failed' });
}

function sanitizeResult(item, index) {
  const url = typeof item?.url === 'string' ? item.url : '';
  let safeUrl = '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') safeUrl = parsed.toString();
  } catch {
    /* 丢弃非法 URL */
  }
  const date = typeof item?.date === 'string' && !Number.isNaN(Date.parse(item.date)) ? item.date : null;
  const authorityNum = Number(item?.authority);
  return {
    id: index,
    rerankScore: Number.isFinite(Number(item?.rerank_score)) ? Number(item.rerank_score) : 0,
    title: typeof item?.title === 'string' && item.title.trim() ? item.title.trim() : safeUrl || '(无标题)',
    url: safeUrl,
    snippet: typeof item?.snippet === 'string' ? item.snippet : '',
    summary: typeof item?.summary === 'string' ? item.summary : '',
    content: typeof item?.content === 'string' ? item.content : '',
    siteName: typeof item?.site_name === 'string' && item.site_name.trim() ? item.site_name.trim() : null,
    siteIcon:
      typeof item?.site_icon === 'string' && /^https?:\/\//i.test(item.site_icon) ? item.site_icon : null,
    date,
    authority: Number.isInteger(authorityNum) && authorityNum >= -1 && authorityNum <= 4 ? authorityNum : -1,
  };
}

/** 调用 Search 接口。 */
export async function search(
  { query, count = 10, oriQuestion, localization, needContent = false },
  { apiKey, baseUrl, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_SEARCH_MS, retries = 1, signal } = {},
) {
  const input = validateSearchInput({ query, count });
  const body = {
    query: input.query,
    count: input.count,
    need_content: Boolean(needContent),
  };
  if (oriQuestion) body.ori_question = String(oriQuestion).slice(0, 128);
  if (localization) body.localization = String(localization);

  const { data, ms, status, attempts } = await postJson('/v1/tools/search', body, {
    apiKey,
    baseUrl,
    fetchImpl,
    timeoutMs,
    retries,
    signal,
  });
  if (!Array.isArray(data.results)) {
    throw new ApiError('上游响应缺少 results 字段。', {
      status: 502,
      code: 'invalid_response',
      retryable: false,
    });
  }
  const results = data.results.map(sanitizeResult);
  return {
    results,
    meta: {
      ms,
      upstreamMs: ms,
      status,
      attempts,
      count: results.length,
      query: input.query,
      needContent: Boolean(needContent),
    },
  };
}

/** 调用 Fetch 接口，返回网页 Markdown 正文。 */
export async function fetchPage(
  { url },
  { apiKey, baseUrl, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_FETCH_MS, retries = 1, signal } = {},
) {
  const input = validateFetchInput({ url });
  const { data, ms, status } = await postJson('/v1/tools/fetch', { url: input.url }, {
    apiKey,
    baseUrl,
    fetchImpl,
    timeoutMs,
    retries,
    signal,
  });
  if (typeof data.content !== 'string') {
    throw new ApiError('下游页面没有可提取的正文。', {
      status: 404,
      code: 'no_content',
      retryable: false,
    });
  }
  return {
    title: typeof data.title === 'string' ? data.title : '',
    content: data.content,
    meta: { ms, status, url: input.url, contentLength: data.content.length },
  };
}
