/**
 * DeepSeek 搜索语法解析与构造。
 * 语法参考：https://api-docs.deepseek.com/zh-cn/guides/search
 *
 * 支持：site: / -site: / -词 / "短语" / -"短语" / lang: / after: / before:
 */

const TOKEN_RE = /(-"([^"]*)")|("([^"]*)")|(\S+)/g;

function classifyWord(word) {
  const lower = word.toLowerCase();
  if (lower.startsWith('-site:') && word.length > 6) {
    return { type: 'excludeSite', value: word.slice(6), text: word };
  }
  if (lower.startsWith('site:') && word.length > 5) {
    return { type: 'site', value: word.slice(5), text: word };
  }
  if (lower.startsWith('lang:') && word.length > 5) {
    const values = word
      .slice(5)
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    return { type: 'lang', value: values.join(','), values, text: word };
  }
  if (lower.startsWith('after:') && word.length > 6) {
    return { type: 'after', value: word.slice(6), text: word };
  }
  if (lower.startsWith('before:') && word.length > 7) {
    return { type: 'before', value: word.slice(7), text: word };
  }
  if (word.startsWith('-') && word.length > 1) {
    return { type: 'excludeTerm', value: word.slice(1), text: word };
  }
  return { type: 'term', value: word, text: word };
}

/**
 * 解析搜索词，返回带位置信息的 token 以及按类别聚合的结果。
 * @param {string} raw
 */
export function parseQuery(raw) {
  const query = typeof raw === 'string' ? raw : '';
  const tokens = [];
  let match;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(query)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    let token;
    if (match[1] !== undefined) {
      token = { type: 'excludePhrase', value: match[2], text: match[0], start, end };
    } else if (match[3] !== undefined) {
      token = { type: 'phrase', value: match[4], text: match[0], start, end };
    } else {
      token = classifyWord(match[5]);
      token.start = start;
      token.end = end;
    }
    tokens.push(token);
  }

  const pick = (type) => tokens.filter((t) => t.type === type);
  const langs = [];
  for (const token of pick('lang')) {
    for (const lang of token.values) if (!langs.includes(lang)) langs.push(lang);
  }
  return {
    raw: query,
    tokens,
    terms: pick('term').map((t) => t.value),
    phrases: pick('phrase').map((t) => t.value),
    excludeTerms: pick('excludeTerm').map((t) => t.value),
    excludePhrases: pick('excludePhrase').map((t) => t.value),
    sites: pick('site').map((t) => t.value),
    excludeSites: pick('excludeSite').map((t) => t.value),
    langs,
    after: pick('after').map((t) => t.value),
    before: pick('before').map((t) => t.value),
  };
}

/** 高亮用的字面词（普通词 + 精确短语，可含中文）。 */
export function highlightTerms(rawOrParsed) {
  const parsed = typeof rawOrParsed === 'string' ? parseQuery(rawOrParsed) : rawOrParsed;
  const seen = new Set();
  const out = [];
  const push = (value) => {
    const v = String(value || '').trim();
    if (!v) return;
    const key = v.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(v);
  };
  for (const term of parsed.terms) push(term);
  for (const phrase of parsed.phrases) push(phrase);
  return out.slice(0, 24);
}

/** 非空搜索词数量（用于判断用户是否输入了有效内容）。 */
export function hasSearchContent(raw) {
  const parsed = parseQuery(raw);
  return (
    parsed.terms.length > 0 ||
    parsed.phrases.length > 0 ||
    parsed.sites.length > 0 ||
    parsed.excludeSites.length > 0 ||
    parsed.after.length > 0 ||
    parsed.before.length > 0
  );
}

function normalizeSite(value) {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
}

/**
 * 用结构化字段拼出 DeepSeek 搜索语法。
 * @param {{all?:string, phrase?:string, exclude?:string, site?:string, excludeSite?:string, lang?:string, after?:string, before?:string}} fields
 */
export function buildQuery(fields = {}) {
  const parts = [];
  const all = String(fields.all || '').trim();
  if (all) parts.push(all);
  const phrase = String(fields.phrase || '').trim();
  if (phrase) parts.push(`"${phrase.replace(/"/g, '')}"`);
  const exclude = String(fields.exclude || '').trim();
  if (exclude) {
    for (const word of exclude.split(/\s+/).filter(Boolean)) {
      parts.push(word.startsWith('-') ? word : `-${word}`);
    }
  }
  const site = normalizeSite(fields.site);
  if (site) parts.push(`site:${site}`);
  const excludeSite = normalizeSite(fields.excludeSite);
  if (excludeSite) parts.push(`-site:${excludeSite}`);
  if (fields.lang) parts.push(`lang:${fields.lang}`);
  if (fields.after) parts.push(`after:${fields.after}`);
  if (fields.before) parts.push(`before:${fields.before}`);
  return parts.join(' ').trim();
}

/** 删除某个 token（按位置），并清理多余空白。 */
export function removeToken(raw, token) {
  if (!token) return raw;
  const query = String(raw || '');
  const next = query.slice(0, token.start) + ' ' + query.slice(token.end);
  return next.replace(/\s+/g, ' ').trim();
}

export const TIME_RANGES = Object.freeze({
  any: { label: '时间不限', days: 0 },
  day: { label: '近一天', days: 1 },
  week: { label: '近一周', days: 7 },
  month: { label: '近一月', days: 30 },
  year: { label: '近一年', days: 365 },
});

function dateOffset(days, now) {
  const date = new Date(now.getTime() - days * 86_400_000);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 把 UI 上的筛选条件合并进查询词（避免重复添加已有语法）。
 * @param {string} raw 用户输入的查询
 * @param {{time?:string, lang?:string}} filters
 * @param {Date} [now]
 */
export function effectiveQuery(raw, filters = {}, now = new Date()) {
  const parsed = parseQuery(raw);
  const parts = [String(raw || '').trim()];
  const time = filters.time && filters.time !== 'any' ? TIME_RANGES[filters.time] : null;
  if (time && time.days > 0 && parsed.after.length === 0) {
    parts.push(`after:${dateOffset(time.days, now)}`);
  }
  if (filters.lang && filters.lang !== 'all' && parsed.langs.length === 0) {
    parts.push(`lang:${filters.lang}`);
  }
  return parts.filter(Boolean).join(' ').trim();
}
