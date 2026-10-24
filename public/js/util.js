/* DOM 无关的小工具，浏览器与 Node 测试共用。 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 只允许 http/https（可选 mailto）链接，防止 javascript: 等注入。 */
export function safeHttpUrl(raw, { allowMailto = false } = {}) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().replace(/^<|>$/g, '');
  if (!value) return null;
  if (allowMailto && /^mailto:[^\s]+$/i.test(value)) return value;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
  } catch {
    return null;
  }
  return null;
}

export function unicodeLength(value) {
  return typeof value === 'string' ? [...value].length : 0;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function formatNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString('zh-CN') : '0';
}

export function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/** 把 URL 变成 Google 风格的面包屑：example.com › path › page */
export function prettyUrlParts(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.host.replace(/^www\./i, '');
    let path = parsed.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      /* 保留原样 */
    }
    const segments = path
      .split('/')
      .filter(Boolean)
      .map((seg) => (seg.length > 34 ? `${seg.slice(0, 31)}…` : seg));
    return { host, path: segments.slice(0, 3).join(' › '), full: parsed.toString() };
  } catch {
    return { host: '', path: '', full: '' };
  }
}

const CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/** 中文之间不加空格，西文之间加空格。 */
export function smartJoin(left, right) {
  if (!left) return right;
  if (!right) return left;
  const a = left[left.length - 1];
  const b = right[0];
  if (CJK_RE.test(a) || CJK_RE.test(b)) return left + right;
  return `${left} ${right}`;
}

export function formatDateShort(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function relativeTime(iso, now = new Date()) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const diffMs = now.getTime() - date.getTime();
  const future = diffMs < 0;
  const abs = Math.abs(diffMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  let text;
  if (abs < minute) text = '刚刚';
  else if (abs < hour) text = `${Math.round(abs / minute)} 分钟`;
  else if (abs < day) text = `${Math.round(abs / hour)} 小时`;
  else if (abs < 30 * day) text = `${Math.round(abs / day)} 天`;
  else if (abs < 365 * day) text = `${Math.round(abs / (30 * day))} 个月`;
  else text = `${Math.round(abs / (365 * day))} 年`;
  if (text === '刚刚') return text;
  return future ? `${text}后` : `${text}前`;
}

/** 把文本中命中的词包成 <mark>（先切分再转义，保证安全）。 */
export function highlightText(raw, terms) {
  const text = String(raw ?? '');
  const list = (terms || []).filter((t) => typeof t === 'string' && t.trim()).sort((a, b) => b.length - a.length);
  if (!list.length) return escapeHtml(text);
  let pattern;
  try {
    pattern = new RegExp(`(${list.map(escapeRegExp).join('|')})`, 'gi');
  } catch {
    return escapeHtml(text);
  }
  const parts = text.split(pattern);
  return parts
    .map((part, index) => (index % 2 === 1 ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part)))
    .join('');
}

export function debounce(fn, wait = 120) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
}

export function truncateText(text, max) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * 清理搜索结果里的 Markdown 痕迹（如摘要开头的 "# "、列表符号），
 * 让 snippet / summary 适合直接展示。
 */
export function cleanDisplayText(text) {
  return String(text ?? '')
    .replace(/\r/g, '')
    .replace(/^\s*(#{1,6}|[-*+]|\d{1,3}[.)])\s+/gm, '')
    .replace(/\\([#*_\-[\]()|:.!>~])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 去掉搜索结果标题里常见的「标题 - 标题」重复后缀。 */
export function cleanTitle(title) {
  const value = String(title ?? '').replace(/\s+/g, ' ').trim();
  const separator = value.lastIndexOf(' - ');
  if (separator > 0) {
    const left = value.slice(0, separator).trim();
    const right = value.slice(separator + 3).trim();
    const normalize = (part) => part.replace(/[|｜—–]/g, '').replace(/\s+/g, ' ').trim();
    const leftNorm = normalize(left);
    const rightNorm = normalize(right);
    if (
      rightNorm &&
      leftNorm &&
      (rightNorm === leftNorm || rightNorm.startsWith(leftNorm) || leftNorm.startsWith(rightNorm))
    ) {
      return left;
    }
  }
  return value;
}

export function todayISO(offsetDays = 0, now = new Date()) {
  const date = new Date(now.getTime() + offsetDays * 86_400_000);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function domainInitial(url) {
  const host = hostOf(url);
  if (!host) return '?';
  return host.replace(/^[^a-z0-9\u4e00-\u9fff]+/i, '').slice(0, 1).toUpperCase() || '?';
}

/** 根据域名挑一个稳定的浅色，用于站点图标兜底。 */
export function domainHue(url) {
  const host = hostOf(url);
  let hash = 0;
  for (let i = 0; i < host.length; i += 1) hash = (hash * 31 + host.charCodeAt(i)) % 360;
  return hash;
}
