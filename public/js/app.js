/**
 * DeepSeek 搜索 — 前端应用
 * 零依赖 ES Module。负责路由、搜索、结果渲染、阅读器、设置与快捷键。
 */
import {
  clamp,
  cleanDisplayText,
  cleanTitle,
  domainHue,
  domainInitial,
  escapeHtml,
  formatDateShort,
  formatNumber,
  highlightText,
  prettyUrlParts,
  relativeTime,
  truncateText,
  unicodeLength,
} from './util.js';
import {
  buildQuery,
  effectiveQuery,
  highlightTerms,
  parseQuery,
} from './query.js';
import { renderMarkdown, stripDuplicateTitle } from './markdown.js';
import { createBackend } from './backend.js';
import { buildRouteHref, currentHref, readRouteFrom } from './routing.js';

const PER_PAGE = 10;
const SEARCH_MAX_CHARS = 128;
const ROUTE_MODE =
  typeof window !== 'undefined' && window.__DSS_STANDALONE__ ? 'hash' : 'path';
const backend = createBackend();
const LS = {
  settings: 'dss.settings.v1',
  history: 'dss.history.v1',
  theme: 'dss.theme',
};
const DEFAULT_SETTINGS = Object.freeze({
  count: 30,
  theme: 'auto',
  overview: true,
  newTab: true,
});
const MAX_HISTORY = 20;

const state = {
  status: null,
  settings: loadSettings(),
  history: [],
  q: '',
  tab: 'all',
  page: 1,
  time: 'any',
  lang: 'all',
  results: [],
  sorted: [],
  meta: null,
  loading: false,
  error: null,
  loadedKey: null,
  requestSeq: 0,
  searchController: null,
  selectedIndex: -1,
  reader: null,
  readerSeq: 0,
  overviewCollapsed: false,
  route: 'home',
};

const dom = {};
let toastTimer = null;
let activeSuggestion = -1;
let currentSuggestions = [];
let mediaThemeQuery = null;

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function on(element, type, handler, options) {
  if (element) element.addEventListener(type, handler, options);
}

function icon(name, className = '') {
  return `<svg class="${className}" aria-hidden="true"><use href="#i-${name}" /></svg>`;
}

/** 安全读取 localStorage：隐私模式/被禁时访问本身就可能抛异常。 */
function readLocalStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function loadSettings() {
  const settings = { ...DEFAULT_SETTINGS };
  try {
    const raw = JSON.parse(readLocalStorage(LS.settings) || '{}');
    if (raw && typeof raw === 'object') {
      if (Number.isFinite(Number(raw.count))) settings.count = clamp(Math.round(Number(raw.count)), 10, 50);
      if (['auto', 'light', 'dark'].includes(raw.theme)) settings.theme = raw.theme;
      if (typeof raw.overview === 'boolean') settings.overview = raw.overview;
      if (typeof raw.newTab === 'boolean') settings.newTab = raw.newTab;
    }
  } catch {
    /* 忽略损坏的本地设置 */
  }
  return settings;
}

function saveSettings() {
  try {
    localStorage.setItem(LS.settings, JSON.stringify(state.settings));
  } catch {
    /* 隐私模式下可能不可写 */
  }
}

function loadHistory() {
  try {
    const raw = JSON.parse(readLocalStorage(LS.history) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((entry) => entry && typeof entry.q === 'string' && entry.q.trim())
      .slice(0, MAX_HISTORY);
  } catch {
    return [];
  }
}

function persistHistory() {
  try {
    localStorage.setItem(LS.history, JSON.stringify(state.history.slice(0, MAX_HISTORY)));
  } catch {
    /* 忽略 */
  }
}

function addHistory(query) {
  const q = String(query || '').trim();
  if (!q) return;
  state.history = [{ q, ts: Date.now() }, ...state.history.filter((entry) => entry.q !== q)].slice(0, MAX_HISTORY);
  persistHistory();
  renderRecent();
}

async function copyText(text) {
  const value = String(text || '');
  if (!value) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* 继续走兜底方案 */
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}

function showToast(message, variant = '') {
  if (!dom.toast) return;
  dom.toast.textContent = message;
  dom.toast.hidden = false;
  dom.toast.className = `toast${variant ? ` toast--${variant}` : ''}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    dom.toast.hidden = true;
    toastTimer = null;
  }, 2600);
}

function setProgress(visible) {
  if (dom.progress) dom.progress.hidden = !visible;
}

function isDialogOpen() {
  return $$('dialog[open]').length > 0;
}

function friendlyError(error) {
  const message = error?.message || '请求失败，请稍后重试。';
  if (error?.code === 'no_api_key') {
    return { title: '还没有配置 API Key', message, code: error.code };
  }
  if (error?.code === 'network_error' || error?.name === 'TypeError') {
    if (backend.mode === 'direct') {
      return {
        title: '无法连接 DeepSeek API',
        message:
          '请检查网络；如果网络正常，可能是浏览器阻止了本页直连 api.deepseek.com（CORS）。可以改用本地服务版，或换一个浏览器重试。',
        code: 'network_error',
      };
    }
    return { title: '无法连接到本地服务', message: '请确认 DeepSeek 搜索服务仍在运行，然后重试。', code: 'network_error' };
  }
  if (error?.code === 'timeout') {
    return { title: '搜索超时', message, code: error.code };
  }
  if (error?.status === 401 || error?.status === 402) {
    return { title: '账户或密钥需要处理', message, code: error.code };
  }
  return { title: '搜索失败', message, code: error?.code || 'error' };
}

async function api(path, body, { method, signal } = {}) {
  return backend.request(path, body, { method, signal });
}

/* ------------------------------------------------------------------ */
/* 主题                                                                */
/* ------------------------------------------------------------------ */

function resolvedTheme(theme) {
  if (theme === 'light' || theme === 'dark') return theme;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme, { persist = true } = {}) {
  const resolved = resolvedTheme(theme);
  document.documentElement.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#16171b' : '#ffffff');
  if (persist) {
    state.settings.theme = theme;
    saveSettings();
    try {
      localStorage.setItem(LS.theme, theme);
    } catch {
      /* 忽略 */
    }
  }
  if (dom.themeToggle) {
    dom.themeToggle.setAttribute(
      'aria-label',
      resolved === 'dark' ? '切换到浅色主题' : '切换到深色主题',
    );
    dom.themeToggle.title = resolved === 'dark' ? '切换到浅色主题' : '切换到深色主题';
  }
}

function toggleTheme() {
  const current = resolvedTheme(state.settings.theme);
  applyTheme(current === 'dark' ? 'light' : 'dark');
  syncSettingsForm();
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

function readRoute() {
  return readRouteFrom(window.location, ROUTE_MODE);
}

function routeHref(params) {
  return buildRouteHref(params, ROUTE_MODE);
}

/** 替换当前历史记录；file:// 下个别浏览器可能限制，静默降级。 */
function replaceUrl(href) {
  try {
    window.history.replaceState({}, '', href);
  } catch {
    /* 地址栏保留旧值不影响功能 */
  }
}

function navigate(params, { replace = false } = {}) {
  const href = routeHref(params);
  const current = currentHref(window.location, ROUTE_MODE);
  if (href === current) {
    applyRoute();
    return;
  }
  try {
    if (replace) window.history.replaceState({}, '', href);
    else window.history.pushState({}, '', href);
  } catch {
    // file:// 下极少数浏览器不允许操作 History：退化为 hash 写入。
    if (replace) window.location.replace(href);
    else window.location.hash = String(href).replace(/^#/, '');
  }
  applyRoute();
}

function currentRouteParams(overrides = {}) {
  return {
    q: state.q,
    tab: state.tab,
    page: state.page,
    time: state.time,
    lang: state.lang,
    ...overrides,
  };
}

function applyRoute() {
  const route = readRoute();
  const previousPage = state.page;
  const previousView = state.route;

  state.route = route.view;
  state.q = route.q;
  state.tab = route.tab;
  state.page = route.page;
  state.time = route.time;
  state.lang = route.lang;

  closeReader({ restoreFocus: false });

  if (route.view === 'home') {
    showHome();
    if (previousView !== 'home') window.scrollTo({ top: 0 });
    return;
  }

  if (!route.q.trim()) {
    if (ROUTE_MODE === 'hash') {
      if (window.location.hash && window.location.hash !== '#/') replaceUrl('#/');
    } else if (window.location.pathname !== '/') {
      replaceUrl('/');
    }
    showHome();
    return;
  }

  showResults();
  syncSearchInputs();
  syncTabs();
  syncFilters();
  ensureResults({ resetPageIfNeeded: true });
  if (previousPage !== state.page) window.scrollTo({ top: 0, behavior: 'auto' });
}

function showHome() {
  dom.homeView.hidden = false;
  dom.resultsView.hidden = true;
  dom.errorView.hidden = true;
  dom.topbar.hidden = true;
  document.title = 'DeepSeek 搜索';
  syncSearchInputs();
  renderRecent();
  renderHomeStatus();
  if (dom.homeInput && !dom.homeInput.value) {
    dom.homeInput.focus({ preventScroll: true });
  }
}

function showResults() {
  dom.homeView.hidden = true;
  dom.resultsView.hidden = false;
  dom.errorView.hidden = true;
  dom.topbar.hidden = false;
  syncSearchInputs();
  syncTabs();
  syncFilters();
  renderMeta();
}

/* ------------------------------------------------------------------ */
/* 首页：最近搜索 / 建议                                               */
/* ------------------------------------------------------------------ */

function renderRecent() {
  if (!dom.recentBox) return;
  if (!state.history.length) {
    dom.recentBox.hidden = true;
    return;
  }
  dom.recentBox.hidden = false;
  dom.recentList.innerHTML = state.history
    .slice(0, 10)
    .map(
      (entry) =>
        `<button class="recent-chip" type="button" data-history="${escapeHtml(entry.q)}">${icon(
          'history',
          'tiny-icon',
        )}<span>${escapeHtml(entry.q)}</span></button>`,
    )
    .join('');
}

function hideSuggestions() {
  if (!dom.suggestList) return;
  dom.suggestList.hidden = true;
  currentSuggestions = [];
  activeSuggestion = -1;
  if (dom.homeInput) dom.homeInput.setAttribute('aria-expanded', 'false');
}

function renderSuggestions() {
  if (!dom.homeInput || dom.homeView.hidden) return;
  const value = dom.homeInput.value.trim();
  const matches = state.history
    .filter((entry) => (value ? entry.q.toLowerCase().includes(value.toLowerCase()) && entry.q !== value : true))
    .slice(0, 6);

  const items = [];
  if (value) {
    items.push({ kind: 'search', text: value, label: '搜索', iconName: 'search' });
  }
  for (const match of matches) {
    items.push({ kind: 'history', text: match.q, label: '最近搜索', iconName: 'history' });
  }

  if (!items.length) {
    hideSuggestions();
    return;
  }
  currentSuggestions = items;
  dom.suggestList.innerHTML = items
    .map(
      (item, index) =>
        `<button class="suggest-item${index === activeSuggestion ? ' is-active' : ''}" type="button" role="option" data-suggest="${index}" aria-selected="${
          index === activeSuggestion ? 'true' : 'false'
        }">${icon(item.iconName, 'tiny-icon')}<span class="suggest-text">${escapeHtml(
          item.text,
        )}</span><span class="suggest-kind">${item.label}</span></button>`,
    )
    .join('');
  dom.suggestList.hidden = false;
  dom.homeInput.setAttribute('aria-expanded', 'true');
}

function selectSuggestion(index) {
  const item = currentSuggestions[index];
  if (!item) return;
  dom.homeInput.value = item.text;
  hideSuggestions();
  startSearch(item.text);
}

/* ------------------------------------------------------------------ */
/* 搜索                                                                */
/* ------------------------------------------------------------------ */

function searchLoadedKey() {
  return JSON.stringify([state.q, state.time, state.lang, state.settings.count]);
}

function ensureResults({ resetPageIfNeeded = false } = {}) {
  const key = searchLoadedKey();
  if (key !== state.loadedKey) {
    state.loadedKey = key;
    runSearch({ resetPageIfNeeded });
    return;
  }
  if (!state.loading) {
    renderResults();
  }
}

async function runSearch({ resetPageIfNeeded = false } = {}) {
  const seq = ++state.requestSeq;
  if (state.searchController) state.searchController.abort();
  state.searchController = new AbortController();
  state.loading = true;
  state.error = null;
  state.selectedIndex = -1;
  state.overviewCollapsed =
    typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 640px)').matches;
  setProgress(true);
  renderLoading();

  try {
    const query = effectiveQuery(state.q, { time: state.time, lang: state.lang });
    if (unicodeLength(query) > SEARCH_MAX_CHARS) {
      throw Object.assign(new Error(`搜索词最多 ${SEARCH_MAX_CHARS} 个字符（含 site: 等语法）。`), {
        code: 'query_too_long',
        status: 400,
      });
    }
    const payload = await api('/api/search', { query, count: state.settings.count }, {
      signal: state.searchController.signal,
    });
    if (seq !== state.requestSeq) return;
    state.results = Array.isArray(payload.results) ? payload.results : [];
    state.meta = payload.meta || null;
    const totalPagesCount = Math.max(1, Math.ceil(state.results.length / PER_PAGE));
    if (resetPageIfNeeded && state.page > totalPagesCount) {
      state.page = totalPagesCount;
      replaceUrl(routeHref(currentRouteParams({ page: totalPagesCount })));
    }
    state.loading = false;
    if (state.route === 'results') {
      renderResults();
      document.title = `${state.q} - DeepSeek 搜索`;
    }
  } catch (error) {
    if (seq !== state.requestSeq) return;
    state.loading = false;
    state.error = error;
    // 失败时清掉上一次查询的残留结果，避免键盘导航/阅读器打开过期条目
    state.results = [];
    state.sorted = [];
    state.meta = null;
    state.selectedIndex = -1;
    if (state.route === 'results') {
      renderError(error);
      document.title = `${state.q} - DeepSeek 搜索`;
    }
  } finally {
    if (seq === state.requestSeq) {
      state.loading = false;
      setProgress(false);
    }
  }
}

function startSearch(rawQuery) {
  const query = String(rawQuery || '').trim();
  if (!query) {
    focusSearch();
    return;
  }
  const effective = effectiveQuery(query, { time: 'any', lang: 'all' });
  if (unicodeLength(effective) > SEARCH_MAX_CHARS) {
    showToast(`搜索词最多 ${SEARCH_MAX_CHARS} 个字符（含语法），请精简后重试。`, 'error');
    return;
  }
  addHistory(query);
  hideSuggestions();
  if (dom.homeInput) dom.homeInput.blur();
  if (dom.resultsInput) dom.resultsInput.blur();
  window.scrollTo({ top: 0, behavior: 'auto' });
  navigate({ q: query, tab: 'all', page: 1, time: 'any', lang: 'all' });
}

async function tryLucky() {
  const query = dom.homeInput.value.trim();
  if (!query) {
    focusSearch();
    return;
  }
  const effective = effectiveQuery(query, { time: 'any', lang: 'all' });
  if (unicodeLength(effective) > SEARCH_MAX_CHARS) {
    showToast(`搜索词最多 ${SEARCH_MAX_CHARS} 个字符。`, 'error');
    return;
  }
  dom.luckyBtn.disabled = true;
  setProgress(true);
  try {
    const payload = await api('/api/search', { query: effective, count: 1 });
    const top = payload?.results?.[0];
    if (top && top.url) {
      addHistory(query);
      window.location.href = top.url;
      return;
    }
    showToast('没有找到结果，换个关键词试试。', 'error');
  } catch (error) {
    showToast(friendlyError(error).message, 'error');
  } finally {
    dom.luckyBtn.disabled = false;
    setProgress(false);
  }
}

/* ------------------------------------------------------------------ */
/* 结果渲染                                                            */
/* ------------------------------------------------------------------ */

function sortedResults() {
  const list = Array.isArray(state.results) ? [...state.results] : [];
  if (state.tab === 'newest') {
    list.sort((a, b) => {
      const da = a.date ? Date.parse(a.date) : Number.NEGATIVE_INFINITY;
      const db = b.date ? Date.parse(b.date) : Number.NEGATIVE_INFINITY;
      return db - da || b.rerankScore - a.rerankScore;
    });
  } else if (state.tab === 'authority') {
    list.sort((a, b) => b.authority - a.authority || b.rerankScore - a.rerankScore);
  } else {
    list.sort((a, b) => b.rerankScore - a.rerankScore);
  }
  return list;
}

function totalPages() {
  return Math.max(1, Math.ceil(state.sorted.length / PER_PAGE));
}

function currentPageItems() {
  const start = (state.page - 1) * PER_PAGE;
  return state.sorted.slice(start, start + PER_PAGE);
}

function siteIconHtml(item) {
  if (item.siteIcon) {
    return `<span class="site-icon"><img src="${escapeHtml(
      item.siteIcon,
    )}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" /></span>`;
  }
  const hue = domainHue(item.url);
  return `<span class="site-icon site-icon--fallback" style="--hue:${hue}">${escapeHtml(
    domainInitial(item.url),
  )}</span>`;
}

function resultItemHtml(item, index) {
  const terms = highlightTerms(state.q);
  const parts = prettyUrlParts(item.url);
  const relative = item.date ? relativeTime(item.date) : '';
  const absolute = item.date ? new Date(item.date).toLocaleString('zh-CN') : '';
  const dateBadge = relative
    ? `<span class="badge" title="${escapeHtml(absolute)}">${icon('clock', 'tiny-icon')}${escapeHtml(relative)}</span>`
    : '';
  const authorityBadge =
    item.authority >= 3
      ? `<span class="badge badge--authority" title="权威性评分 ${item.authority}/4">${icon(
          'shield',
          'tiny-icon',
        )}极权威</span>`
      : '';
  const titleHtml = highlightText(cleanTitle(item.title), terms);
  const snippetRaw = cleanDisplayText(item.snippet || item.summary || '');
  const snippetHtml = snippetRaw
    ? highlightText(truncateText(snippetRaw, 320), terms)
    : '（暂无摘要，可打开全文阅读）';
  const summaryClean = cleanDisplayText(item.summary || '');
  const hasLongSummary = Boolean(summaryClean && summaryClean.length > snippetRaw.length + 60);
  const summaryHtml = hasLongSummary
    ? `<div class="result-summary" hidden><span class="result-summary-label">摘要</span>${highlightText(
        truncateText(summaryClean, 900),
        terms,
      )}</div>`
    : '';
  const target = state.settings.newTab ? ' target="_blank" rel="noopener noreferrer"' : '';
  const breadcrumb = `${escapeHtml(parts.host)}${
    parts.path ? `<span class="meta-sep"> › </span>${escapeHtml(parts.path)}` : ''
  }`;

  return `<article class="result" data-index="${index}" tabindex="-1">
    <div class="result-head">
      ${siteIconHtml(item)}
      <span class="site-name" title="${escapeHtml(item.siteName || parts.host)}">${escapeHtml(
        item.siteName || parts.host || '未知站点',
      )}</span>
      <span class="result-url" title="${escapeHtml(item.url)}">${breadcrumb}</span>
      <span class="result-badges">${dateBadge}${authorityBadge}</span>
    </div>
    <a class="result-title" href="${escapeHtml(item.url)}"${target} data-result-link>${titleHtml}</a>
    <p class="result-snippet">${snippetHtml}</p>
    ${summaryHtml}
    <div class="result-foot">
      <button class="mini-btn" type="button" data-action="read" ${item.url ? '' : 'disabled'}>${icon(
        'book',
        'tiny-icon',
      )}全文阅读</button>
      <button class="mini-btn" type="button" data-action="copy">${icon('link', 'tiny-icon')}复制链接</button>
      ${
        hasLongSummary
          ? `<button class="mini-btn" type="button" data-action="summary">${icon(
              'chevron-down',
              'tiny-icon',
            )}查看摘要</button>`
          : ''
      }
      <span class="result-score" title="DeepSeek 排序分数（≥1.5 为优质结果）">相关度 ${item.rerankScore.toFixed(
        2,
      )}</span>
    </div>
  </article>`;
}

function renderMeta() {
  if (!dom.resultMeta) return;
  if (state.error) {
    dom.resultMeta.innerHTML = '';
    return;
  }
  if (!state.meta) {
    dom.resultMeta.innerHTML = '';
    return;
  }
  const meta = state.meta;
  const count = state.results.length;
  const seconds = ((meta.ms || 0) / 1000).toFixed(2);
  const pages = totalPages();
  const cacheBadge = meta.cached
    ? `<span class="meta-badge meta-badge--cache" title="命中本地缓存，未重复调用 API">${icon(
        'check',
        'tiny-icon',
      )}缓存 ${Math.max(0, Math.round((meta.cacheAgeMs || 0) / 1000))} 秒前</span>`
    : `<span class="meta-badge meta-badge--live">实时请求</span>`;
  dom.resultMeta.innerHTML = `<span>返回 ${formatNumber(count)} 条结果</span>
    <span class="meta-sep">·</span>
    ${meta.cached ? '<span>本次未调用 API</span>' : `<span>用时 ${seconds} 秒</span>`}
    <span class="meta-sep">·</span>
    ${cacheBadge}
    <span class="meta-badge">第 ${state.page} / ${pages} 页</span>
    <span class="meta-spacer"></span>
    <button class="meta-btn" type="button" data-action="copy-search" title="复制当前搜索链接">${icon(
      'link',
      'tiny-icon',
    )}复制搜索链接</button>`;
}

function renderOverview() {
  if (!dom.overview) return;
  if (state.page !== 1 || !state.settings.overview || state.results.length < 3) {
    dom.overview.innerHTML = '';
    return;
  }
  const top = sortedResults()
    .filter((item) => item.summary && item.summary.length > 40)
    .slice(0, 3);
  if (top.length < 2) {
    dom.overview.innerHTML = '';
    return;
  }
  const terms = highlightTerms(state.q);
  const items = top
    .map(
      (item, index) =>
        `<li class="overview-item">${highlightText(
          truncateText(cleanDisplayText(item.summary), 200),
          terms,
        )} <a class="overview-cite" href="${escapeHtml(
          item.url,
        )}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(cleanTitle(item.title))}">[${index + 1}]</a></li>`,
    )
    .join('');
  dom.overview.innerHTML = `<section class="overview">
    <div class="overview-head">${icon('sparkle', 'tiny-icon')}结果速览
      <button class="link-btn" type="button" data-action="toggle-overview">${
        state.overviewCollapsed ? '展开' : '收起'
      }</button>
    </div>
    <ul class="overview-list"${state.overviewCollapsed ? ' hidden' : ''}>${items}</ul>
  </section>`;
}

function renderPagination() {
  if (!dom.pagination) return;
  const pages = totalPages();
  if (pages <= 1 || state.loading || state.error) {
    dom.pagination.innerHTML = '';
    return;
  }
  const buttons = [];
  buttons.push(
    `<button class="page-btn" type="button" data-page="${state.page - 1}" ${
      state.page === 1 ? 'disabled' : ''
    } aria-label="上一页">${icon('chevron-left')}</button>`,
  );
  for (let page = 1; page <= pages; page += 1) {
    buttons.push(
      `<button class="page-btn${page === state.page ? ' is-active' : ''}" type="button" data-page="${page}" ${
        page === state.page ? 'aria-current="page"' : ''
      }>${page}</button>`,
    );
  }
  buttons.push(
    `<button class="page-btn" type="button" data-page="${state.page + 1}" ${
      state.page === pages ? 'disabled' : ''
    } aria-label="下一页">${icon('chevron-right')}</button>`,
  );
  dom.pagination.innerHTML = buttons.join('');
}

function attachSiteIconFallbacks() {
  $$('.site-icon img', dom.resultList).forEach((img) => {
    const applyFallback = () => {
      const parent = img.parentElement;
      if (!parent) return;
      const url = parent.closest('.result')?.querySelector('.result-title')?.getAttribute('href') || '';
      parent.classList.add('site-icon--fallback');
      parent.style.setProperty('--hue', String(domainHue(url)));
      parent.textContent = domainInitial(url);
    };
    img.addEventListener('error', applyFallback, { once: true });
    if (img.complete && img.naturalWidth === 0) applyFallback();
  });
}

function renderResults() {
  if (!dom.resultList) return;
  if (state.error) {
    renderError(state.error);
    return;
  }
  if (state.loading) {
    renderLoading();
    return;
  }
  if (!state.meta) {
    dom.resultList.innerHTML = '';
    return;
  }

  state.sorted = sortedResults();
  const pages = totalPages();
  if (state.page > pages) {
    state.page = pages;
    replaceUrl(routeHref(currentRouteParams({ page: pages })));
  }

  renderMeta();
  renderOverview();

  const items = currentPageItems();
  if (!items.length) {
    renderEmpty();
    return;
  }

  dom.resultList.innerHTML = items
    .map((item, index) => resultItemHtml(item, (state.page - 1) * PER_PAGE + index))
    .join('');
  dom.resultList.dataset.loaded = '1';
  attachSiteIconFallbacks();
  state.selectedIndex = -1;
  renderPagination();
}

function renderLoading() {
  if (!dom.resultList) return;
  dom.overview.innerHTML = '';
  dom.pagination.innerHTML = '';
  if (dom.resultMeta) {
    dom.resultMeta.innerHTML = `<span>正在搜索「${escapeHtml(state.q)}」…</span>`;
  }
  dom.resultList.innerHTML = Array.from(
    { length: 5 },
    () => `<div class="skeleton-item">
      <div class="sk-line sk-line--meta"></div>
      <div class="sk-line sk-line--title"></div>
      <div class="sk-line sk-line--w80"></div>
      <div class="sk-line sk-line--w60"></div>
      <div class="sk-line sk-line--short"></div>
    </div>`,
  ).join('');
}

function stateCard({ tone = '', iconName = 'alert', title, message, actions = '', tips = '' }) {
  return `<div class="state-card ${tone}">
    <div class="state-icon">${icon(iconName)}</div>
    <h2>${escapeHtml(title)}</h2>
    <p>${message}</p>
    ${tips}
    ${actions ? `<div class="state-actions">${actions}</div>` : ''}
  </div>`;
}

function retryAction(label = '重试') {
  return `<button class="btn btn--primary" type="button" data-action="retry">${icon('refresh', 'tiny-icon')}${label}</button>`;
}

function setupKeyAction() {
  return `<button class="btn btn--primary" type="button" data-action="open-settings">${icon(
    'gear',
    'tiny-icon',
  )}设置 API Key</button>`;
}

function homeHref() {
  return ROUTE_MODE === 'hash' ? '#/' : '/';
}

function homeAction() {
  return `<a class="btn" href="${homeHref()}" data-nav-home>返回首页</a>`;
}

function renderEmpty() {
  dom.pagination.innerHTML = '';
  const activeFilters = state.time !== 'any' || state.lang !== 'all';
  const tips = `<div class="state-tips"><strong>可以试试：</strong><ul>
    <li>检查搜索词是否拼写正确，或换一个更宽泛的说法</li>
    ${activeFilters ? '<li>取消时间 / 语言筛选后再试</li>' : ''}
    <li>去掉 <code>site:</code>、<code>-</code> 等限定语法，扩大搜索范围</li>
    <li>使用引号精确匹配短语，例如 <code>\"DeepSeek V4\"</code></li>
  </ul></div>`;
  dom.resultList.innerHTML = stateCard({
    tone: 'is-empty',
    iconName: 'search',
    title: `没有找到「${state.q}」相关的结果`,
    message: 'DeepSeek 搜索没有返回匹配的网页，换个说法或减少筛选条件再试试。',
    actions: `${retryAction('再搜一次')}${homeAction()}`,
    tips,
  });
  renderMeta();
  renderOverview();
}

function renderError(error) {
  const info = friendlyError(error);
  const extra =
    info.code === 'no_api_key'
      ? setupKeyAction()
      : `${retryAction()}${info.code === 'network_error' ? '' : homeAction()}`;
  if (dom.resultMeta) dom.resultMeta.innerHTML = '';
  if (dom.overview) dom.overview.innerHTML = '';
  if (dom.pagination) dom.pagination.innerHTML = '';
  dom.resultList.innerHTML = stateCard({
    tone: 'is-error',
    iconName: 'alert',
    title: info.title,
    message: escapeHtml(info.message),
    actions: extra,
  });
  if (dom.resultsView) dom.resultsView.hidden = false;
  if (dom.homeView) dom.homeView.hidden = true;
}

function highlightResultSelection() {
  $$('.result', dom.resultList).forEach((element) => {
    const index = Number(element.dataset.index);
    element.classList.toggle('is-selected', index === state.selectedIndex);
  });
}

function moveSelection(delta) {
  if (state.error || !state.meta) return;
  const items = currentPageItems();
  if (!items.length) return;
  const start = (state.page - 1) * PER_PAGE;
  let position = state.selectedIndex - start;
  if (Number.isNaN(position) || position < 0) position = -1;
  position = clamp(position + delta, 0, items.length - 1);
  state.selectedIndex = start + position;
  highlightResultSelection();
  const element = dom.resultList.querySelector(`.result[data-index="${state.selectedIndex}"]`);
  if (element) element.scrollIntoView({ block: 'nearest' });
}

function openReaderForSelection() {
  if (state.error || !state.meta) return;
  if (state.selectedIndex < 0) {
    moveSelection(1);
    return;
  }
  const item = state.sorted[state.selectedIndex];
  if (item) openReader(item);
}

/* ------------------------------------------------------------------ */
/* 阅读器                                                              */
/* ------------------------------------------------------------------ */

const READER_FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function setAppInert(inert) {
  ['#topbar', '.main', '.footer'].forEach((selector) => {
    const element = $(selector);
    if (!element) return;
    if (inert) element.setAttribute('inert', '');
    else element.removeAttribute('inert');
  });
}

function readerFocusables() {
  if (!dom.reader) return [];
  return $$(READER_FOCUSABLE, dom.reader).filter(
    (element) => element.offsetParent !== null || element === document.activeElement,
  );
}

function readerSourceHtml(item, meta = null) {
  const parts = prettyUrlParts(item.url);
  const date = item.date ? formatDateShort(item.date) : '';
  const cache = meta && meta.cached ? '<span class="meta-badge meta-badge--cache">缓存</span>' : '';
  return `${parts.host ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(parts.host)}</a>` : ''}
    ${date ? `<span>${escapeHtml(date)}</span>` : ''}
    ${item.authority >= 3 ? `<span class="badge badge--authority">${icon('shield', 'tiny-icon')}极权威</span>` : ''}
    ${cache}`;
}

async function openReader(item) {
  if (!item || !item.url) return;
  const seq = ++state.readerSeq;
  state.reader = { item };
  state.readerReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  dom.reader.hidden = false;
  setAppInert(true);
  document.body.classList.add('reader-open');
  dom.readerClose.focus({ preventScroll: true });
  dom.readerTitle.textContent = cleanTitle(item.title);
  dom.readerSource.innerHTML = readerSourceHtml(item);
  dom.readerOpen.href = item.url;
  dom.readerBody.innerHTML = `<div class="reader-loading">
    <div class="sk-line sk-line--meta"></div>
    <div class="sk-line sk-line--title" style="width:70%"></div>
    <div class="sk-line"></div><div class="sk-line"></div><div class="sk-line sk-line--w80"></div>
    <div class="sk-line sk-line--w60"></div><div class="sk-line"></div><div class="sk-line sk-line--w80"></div>
    <div class="sk-line sk-line--w45"></div>
  </div>`;
  dom.readerBody.scrollTop = 0;
  try {
    const payload = await api('/api/fetch', { url: item.url });
    if (seq !== state.readerSeq) return;
    const title = cleanTitle(payload.title || item.title);
    const markdown = stripDuplicateTitle(payload.content || '', title);
    dom.readerTitle.textContent = cleanTitle(item.title || title);
    dom.readerSource.innerHTML = readerSourceHtml(item, payload.meta);
    dom.readerBody.innerHTML = `<article class="md-article">${renderMarkdown(markdown)}</article>`;
    dom.readerBody.scrollTop = 0;
  } catch (error) {
    if (seq !== state.readerSeq) return;
    const info = friendlyError(error);
    dom.readerBody.innerHTML = `<div class="reader-error">
      <div class="state-icon">${icon('alert')}</div>
      <h3>无法读取这篇网页的全文</h3>
      <p>${escapeHtml(
        error?.code === 'no_content' || error?.status === 404
          ? 'DeepSeek 未能从该页面提取正文（可能被站点拦截、需要登录，或内容不是文章）。'
          : info.message,
      )}</p>
      <div class="state-actions">
        <a class="btn btn--primary" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${icon(
          'external',
          'tiny-icon',
        )}直接打开原文</a>
        <button class="btn" type="button" data-action="reader-retry">${icon('refresh', 'tiny-icon')}重试</button>
      </div>
    </div>`;
  }
}

function closeReader({ restoreFocus = true } = {}) {
  if (!dom.reader || dom.reader.hidden) {
    state.reader = null;
    return;
  }
  dom.readerSeq += 1;
  dom.reader.hidden = true;
  setAppInert(false);
  document.body.classList.remove('reader-open');
  dom.readerBody.innerHTML = '';
  state.reader = null;
  const target = state.readerReturnFocus;
  state.readerReturnFocus = null;
  if (restoreFocus && target && target.isConnected) {
    try {
      target.focus({ preventScroll: true });
    } catch {
      /* 忽略 */
    }
  }
}

/* ------------------------------------------------------------------ */
/* 同步 UI                                                             */
/* ------------------------------------------------------------------ */

function syncSearchInputs() {
  if (state.route === 'results') {
    if (dom.resultsInput) dom.resultsInput.value = state.q;
    if (dom.homeInput) dom.homeInput.value = state.q;
  } else if (dom.resultsInput) {
    dom.resultsInput.value = '';
  }
  if (dom.homeClear) dom.homeClear.hidden = !(dom.homeInput?.value || '');
  if (dom.resultsClear) dom.resultsClear.hidden = !(dom.resultsInput?.value || '');
}

function syncTabs() {
  $$('.tab', dom.resultsView).forEach((tab) => {
    const active = tab.dataset.tab === state.tab;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

function syncFilters() {
  $$('.chip[data-time]', dom.resultsView).forEach((chip) => {
    const active = chip.dataset.time === state.time;
    chip.classList.toggle('is-active', active);
    chip.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  if (dom.langSelect) dom.langSelect.value = state.lang;
}

function renderHomeStatus() {
  if (!dom.homeStatus) return;
  if (!state.status || state.status.configured) {
    dom.homeStatus.hidden = true;
    return;
  }
  dom.homeStatus.hidden = false;
  dom.homeStatus.classList.remove('home-status--ok');
  dom.homeStatus.innerHTML = `<span>${icon(
    'alert',
    'tiny-icon',
  )} 尚未配置 DeepSeek API Key，搜索前请先完成设置</span>
    <button class="link-btn" type="button" data-action="open-settings">去设置 →</button>`;
}

function renderFooterStatus() {
  if (!dom.footerStatus) return;
  const isDirect = state.status?.mode === 'direct';
  if (dom.footerMode) {
    dom.footerMode.textContent = isDirect ? '单文件版 · 无需本地服务' : '仅本机可访问';
  }
  if (!state.status) {
    dom.footerStatus.textContent = 'Search / Fetch 按次计费 · 本地缓存减少重复调用';
    return;
  }
  if (state.status.configured) {
    dom.footerStatus.textContent = isDirect
      ? `单文件版已就绪 · ${state.status.key.label}`
      : `已就绪 · ${state.status.key.label}`;
  } else {
    dom.footerStatus.textContent = isDirect
      ? '单文件版 · 尚未配置 API Key · 在设置中填写后即可搜索'
      : '尚未配置 API Key · 在设置中填写后即可搜索';
  }
}

function renderSettingsInfo() {
  if (!dom.keyStatus) return;
  if (!state.status) {
    dom.keyStatus.textContent = '正在读取服务状态…';
    return;
  }
  const isDirect = state.status.mode === 'direct';
  if (state.status.configured) {
    dom.keyStatus.innerHTML = `已配置 · 来源：${escapeHtml(state.status.key.label)}<br>密钥：<code>${escapeHtml(
      state.status.key.masked,
    )}</code>`;
  } else if (isDirect) {
    dom.keyStatus.innerHTML = '尚未配置 API Key。粘贴到下方保存后，会仅保存在当前浏览器中。';
  } else {
    dom.keyStatus.innerHTML = '尚未配置 API Key。可以粘贴在下方保存，或设置环境变量 DEEPSEEK_API_KEY。';
  }

  if (dom.keyHint) {
    const storageWarning =
      isDirect && state.status.storageAvailable === false
        ? ' 当前浏览器禁用了本地存储，密钥只在本次会话有效。'
        : '';
    dom.keyHint.innerHTML = isDirect
      ? `密钥只保存在此浏览器的本地存储中（或来自构建时嵌入），不会上传到除 DeepSeek 以外的任何服务器。测试连接会产生一次真实的 Search 请求（约 ¥0.005）。${storageWarning}`
      : '密钥只保存在本机服务端（<code>data/config.json</code> 或环境变量），不会发送到浏览器。测试连接会产生一次真实的 Search 请求（约 ¥0.005）。';
  }

  if (dom.cacheInfo) {
    const cache = state.status.cache || {};
    const searchCache = cache.search || {};
    const fetchCache = cache.fetch || {};
    const hits = (searchCache.hits || 0) + (fetchCache.hits || 0);
    dom.cacheInfo.textContent = isDirect
      ? `浏览器内搜索缓存 ${searchCache.size || 0} 条 · 全文缓存 ${fetchCache.size || 0} 条 · 累计命中 ${hits} 次`
      : `搜索缓存 ${searchCache.size || 0} 条 · 全文缓存 ${fetchCache.size || 0} 条 · 累计命中 ${hits} 次`;
  }
  if (dom.aboutInfo) {
    dom.aboutInfo.textContent = isDirect
      ? `DeepSeek 搜索 v${state.status.version || '1.0.0'} · 单文件版（浏览器直连）· 无需本地服务 · API：${state.status.baseUrl}`
      : `DeepSeek 搜索 v${state.status.version || '1.0.0'} · 本地服务版 · 仅监听 127.0.0.1 · API：${state.status.baseUrl}`;
  }
}

function syncSettingsForm() {
  if (!dom.settingCount) return;
  dom.settingCount.value = String(state.settings.count);
  dom.settingTheme.value = state.settings.theme;
  dom.settingOverview.checked = state.settings.overview;
  dom.settingNewtab.checked = state.settings.newTab;
  renderSettingsInfo();
}

function applySettingsToUI() {
  applyTheme(state.settings.theme, { persist: false });
  syncSettingsForm();
}

/* ------------------------------------------------------------------ */
/* 对话框                                                              */
/* ------------------------------------------------------------------ */

function openSettings() {
  syncSettingsForm();
  refreshStatus();
  if (dom.keyTestResult) {
    dom.keyTestResult.hidden = true;
    dom.keyTestResult.className = 'hint';
  }
  if (dom.apiKeyInput) dom.apiKeyInput.value = '';
  if (dom.settingsDialog && !dom.settingsDialog.open) dom.settingsDialog.showModal();
}

function openHelp() {
  if (dom.helpDialog && !dom.helpDialog.open) dom.helpDialog.showModal();
}

function openAdvanced() {
  const parsed = parseQuery(state.q);
  const setValue = (element, value) => {
    if (element) element.value = value || '';
  };
  setValue(dom.advAll, parsed.terms.join(' '));
  setValue(dom.advPhrase, parsed.phrases[0] || '');
  setValue(dom.advExclude, parsed.excludeTerms.join(' '));
  setValue(dom.advSite, parsed.sites[0] || '');
  setValue(dom.advExcludeSite, parsed.excludeSites[0] || '');
  if (dom.advLang) dom.advLang.value = parsed.langs[0] || '';
  setValue(dom.advAfter, parsed.after[0] || '');
  setValue(dom.advBefore, parsed.before[0] || '');
  updateAdvancedPreview();
  if (dom.advancedDialog && !dom.advancedDialog.open) dom.advancedDialog.showModal();
}

function advancedFields() {
  return {
    all: dom.advAll?.value || '',
    phrase: dom.advPhrase?.value || '',
    exclude: dom.advExclude?.value || '',
    site: dom.advSite?.value || '',
    excludeSite: dom.advExcludeSite?.value || '',
    lang: dom.advLang?.value || '',
    after: dom.advAfter?.value || '',
    before: dom.advBefore?.value || '',
  };
}

function updateAdvancedPreview() {
  if (!dom.advPreview) return;
  const query = buildQuery(advancedFields());
  dom.advPreview.textContent = query || '（请至少填写一个条件）';
}

async function saveApiKey() {
  const raw = dom.apiKeyInput?.value?.trim() || '';
  if (!raw) {
    showToast('请先粘贴 API Key。', 'error');
    return;
  }
  dom.apiKeySave.disabled = true;
  try {
    const result = await api('/api/settings', { apiKey: raw });
    state.status = result.status;
    if (dom.apiKeyInput) dom.apiKeyInput.value = '';
    renderHomeStatus();
    renderFooterStatus();
    renderSettingsInfo();
    showToast('API Key 已保存。');
    if (state.error?.code === 'no_api_key' && state.route === 'results') {
      state.loadedKey = null;
      ensureResults({ resetPageIfNeeded: true });
    }
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    dom.apiKeySave.disabled = false;
  }
}

async function clearApiKey() {
  dom.apiKeyClear.disabled = true;
  try {
    const result = await api('/api/settings', { apiKey: '' });
    state.status = result.status;
    renderHomeStatus();
    renderFooterStatus();
    renderSettingsInfo();
    showToast(
      state.status.configured
        ? `已清除保存的密钥，仍在使用：${state.status.key.label}`
        : '已清除 API Key。',
    );
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    dom.apiKeyClear.disabled = false;
  }
}

async function testApiKey() {
  const candidate = dom.apiKeyInput?.value?.trim() || '';
  dom.apiKeyTest.disabled = true;
  if (dom.keyTestResult) {
    dom.keyTestResult.hidden = false;
    dom.keyTestResult.className = 'hint';
    dom.keyTestResult.textContent = '正在测试连接…';
  }
  try {
    const result = await api('/api/test', candidate ? { apiKey: candidate } : {});
    if (!dom.keyTestResult) return;
    dom.keyTestResult.hidden = false;
    if (result.ok) {
      dom.keyTestResult.className = 'hint is-ok';
      dom.keyTestResult.innerHTML = `连接成功 · ${result.ms} ms${
        result.sample ? ` · 示例结果：${escapeHtml(result.sample.title)}` : ''
      }`;
    } else {
      dom.keyTestResult.className = 'hint is-error';
      dom.keyTestResult.textContent = `连接失败：${result.error?.message || '未知错误'}`;
    }
  } catch (error) {
    if (dom.keyTestResult) {
      dom.keyTestResult.hidden = false;
      dom.keyTestResult.className = 'hint is-error';
      dom.keyTestResult.textContent = `连接失败：${error.message}`;
    }
  } finally {
    dom.apiKeyTest.disabled = false;
  }
}

async function clearCache() {
  dom.cacheClear.disabled = true;
  try {
    await api('/api/cache', undefined, { method: 'DELETE' });
    await refreshStatus();
    showToast('本地缓存已清空。');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    dom.cacheClear.disabled = false;
  }
}

async function refreshStatus() {
  try {
    state.status = await api('/api/status');
  } catch {
    state.status = null;
  }
  try {
    // 首次使用时，把服务端配置的默认条数同步到浏览器设置
    if (state.status?.defaults && !readLocalStorage(LS.settings)) {
      state.settings.count = clamp(Number(state.status.defaults.count) || 30, 10, 50);
      saveSettings();
      syncSettingsForm();
    }
  } catch {
    /* localStorage 被禁用或表单异常时，不应阻断下面的状态渲染 */
  } finally {
    renderHomeStatus();
    renderFooterStatus();
    renderSettingsInfo();
  }
  return state.status;
}

/* ------------------------------------------------------------------ */
/* 事件绑定                                                            */
/* ------------------------------------------------------------------ */

function focusSearch() {
  const input = state.route === 'home' ? dom.homeInput : dom.resultsInput;
  if (input) {
    input.focus();
    input.select();
  }
}

function bindEvents() {
  // 首页搜索
  on(dom.homeForm, 'submit', (event) => {
    event.preventDefault();
    startSearch(dom.homeInput.value);
  });
  on(dom.homeSearchBtn, 'click', (event) => {
    event.preventDefault();
    startSearch(dom.homeInput.value);
  });
  on(dom.homeInput, 'input', () => {
    if (dom.homeClear) dom.homeClear.hidden = !dom.homeInput.value;
    activeSuggestion = -1;
    renderSuggestions();
  });
  on(dom.homeInput, 'focus', () => renderSuggestions());
  on(dom.homeInput, 'blur', () => setTimeout(hideSuggestions, 120));
  on(dom.homeInput, 'keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!currentSuggestions.length) return;
      event.preventDefault();
      activeSuggestion += event.key === 'ArrowDown' ? 1 : -1;
      if (activeSuggestion < 0) activeSuggestion = currentSuggestions.length - 1;
      if (activeSuggestion >= currentSuggestions.length) activeSuggestion = 0;
      renderSuggestions();
      return;
    }
    if (event.key === 'Enter' && activeSuggestion >= 0 && currentSuggestions[activeSuggestion]) {
      event.preventDefault();
      selectSuggestion(activeSuggestion);
      return;
    }
    if (event.key === 'Escape') hideSuggestions();
  });
  on(dom.homeClear, 'click', () => {
    dom.homeInput.value = '';
    dom.homeClear.hidden = true;
    hideSuggestions();
    dom.homeInput.focus();
  });
  on(dom.suggestList, 'mousedown', (event) => {
    const item = event.target.closest('[data-suggest]');
    if (!item) return;
    event.preventDefault();
    selectSuggestion(Number(item.dataset.suggest));
  });
  on(dom.luckyBtn, 'click', tryLucky);

  // 结果页搜索
  on(dom.resultsForm, 'submit', (event) => {
    event.preventDefault();
    startSearch(dom.resultsInput.value);
  });
  on(dom.resultsInput, 'input', () => {
    if (dom.resultsClear) dom.resultsClear.hidden = !dom.resultsInput.value;
  });
  on(dom.resultsClear, 'click', () => {
    dom.resultsInput.value = '';
    dom.resultsClear.hidden = true;
    dom.resultsInput.focus();
  });

  // 主题 / 设置
  on(dom.themeToggle, 'click', toggleTheme);
  $$('[data-action="toggle-theme"]').forEach((button) => on(button, 'click', toggleTheme));
  $$('[data-action="open-settings"], #settings-open').forEach((button) => on(button, 'click', openSettings));
  $$('[data-open-help]').forEach((button) => on(button, 'click', openHelp));
  $$('#advanced-open, #home-advanced').forEach((button) => on(button, 'click', openAdvanced));

  // 标签 / 筛选
  on(dom.tabs, 'click', (event) => {
    const tab = event.target.closest('[data-tab]');
    if (!tab || tab.dataset.tab === state.tab) return;
    navigate(currentRouteParams({ tab: tab.dataset.tab, page: 1 }));
  });
  on(dom.timeChips, 'click', (event) => {
    const chip = event.target.closest('[data-time]');
    if (!chip) return;
    navigate(currentRouteParams({ time: chip.dataset.time, page: 1 }));
  });
  on(dom.langSelect, 'change', () => {
    navigate(currentRouteParams({ lang: dom.langSelect.value, page: 1 }));
  });

  // 高级搜索
  on(dom.advancedSearch, 'click', () => {
    const query = buildQuery(advancedFields());
    if (!query) {
      showToast('请至少填写一个高级搜索条件。', 'error');
      return;
    }
    dom.advancedDialog.close();
    startSearch(query);
  });
  $$('#adv-all, #adv-phrase, #adv-exclude, #adv-site, #adv-exclude-site, #adv-after, #adv-before').forEach(
    (input) => on(input, 'input', updateAdvancedPreview),
  );
  on(dom.advLang, 'change', updateAdvancedPreview);

  // 分页
  on(dom.pagination, 'click', (event) => {
    const button = event.target.closest('[data-page]');
    if (!button || button.disabled) return;
    const page = Number(button.dataset.page);
    if (!Number.isFinite(page)) return;
    navigate(currentRouteParams({ page }));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // 结果列表操作
  on(dom.resultList, 'click', (event) => {
    const actionEl = event.target.closest('[data-action]');
    if (actionEl) {
      const action = actionEl.dataset.action;
      const resultEl = actionEl.closest('.result');
      const index = resultEl ? Number(resultEl.dataset.index) : -1;
      const item = index >= 0 ? state.sorted[index] : null;
      if (action === 'read' && item) {
        event.preventDefault();
        openReader(item);
        return;
      }
      if (action === 'copy' && item) {
        copyText(item.url).then((ok) => showToast(ok ? '链接已复制。' : '复制失败，请手动复制。', ok ? '' : 'error'));
        return;
      }
      if (action === 'summary') {
        const summary = resultEl.querySelector('.result-summary');
        if (summary) {
          const hidden = summary.hasAttribute('hidden');
          if (hidden) summary.removeAttribute('hidden');
          else summary.setAttribute('hidden', '');
          actionEl.textContent = '';
          actionEl.innerHTML = `${icon(hidden ? 'chevron-down' : 'chevron-up', 'tiny-icon')}${
            hidden ? '收起摘要' : '查看摘要'
          }`;
        }
        return;
      }
      if (action === 'retry') {
        state.loadedKey = null;
        ensureResults({ resetPageIfNeeded: true });
        return;
      }
      if (action === 'open-settings') {
        openSettings();
        return;
      }
    }
    if (event.target.closest('[data-nav-home]')) {
      event.preventDefault();
      navigate({});
      return;
    }
  });

  // 概览折叠 / 复制搜索链接 / 设置 / 关闭对话框（document 级委托）
  document.addEventListener('click', (event) => {
    const closeButton = event.target.closest('[data-close-dialog]');
    if (closeButton) {
      const dialog = closeButton.closest('dialog');
      if (dialog) dialog.close();
      return;
    }
    const actionEl = event.target.closest('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    if (action === 'toggle-overview') {
      state.overviewCollapsed = !state.overviewCollapsed;
      renderOverview();
    } else if (action === 'copy-search') {
      copyText(window.location.href).then((ok) =>
        showToast(ok ? '搜索链接已复制。' : '复制失败。', ok ? '' : 'error'),
      );
    } else if (action === 'reader-retry' && state.reader) {
      openReader(state.reader.item);
    } else if (action === 'open-settings') {
      openSettings();
    }
  });

  // 最近搜索
  on(dom.recentList, 'click', (event) => {
    const chip = event.target.closest('[data-history]');
    if (!chip) return;
    startSearch(chip.dataset.history);
  });
  on(dom.recentClear, 'click', () => {
    state.history = [];
    persistHistory();
    renderRecent();
    showToast('已清除搜索历史。');
  });

  // 设置对话框
  on(dom.apiKeySave, 'click', saveApiKey);
  on(dom.apiKeyClear, 'click', clearApiKey);
  on(dom.apiKeyTest, 'click', testApiKey);
  on(dom.settingCount, 'change', () => {
    const count = clamp(Number(dom.settingCount.value) || 30, 10, 50);
    const changed = count !== state.settings.count;
    state.settings.count = count;
    saveSettings();
    if (changed && state.route === 'results') {
      state.loadedKey = null;
      ensureResults({ resetPageIfNeeded: true });
    }
  });
  on(dom.settingTheme, 'change', () => {
    state.settings.theme = dom.settingTheme.value;
    applyTheme(state.settings.theme);
  });
  on(dom.settingOverview, 'change', () => {
    state.settings.overview = dom.settingOverview.checked;
    saveSettings();
    if (state.route === 'results' && !state.loading) renderOverview();
  });
  on(dom.settingNewtab, 'change', () => {
    state.settings.newTab = dom.settingNewtab.checked;
    saveSettings();
  });
  on(dom.historyClear, 'click', () => {
    state.history = [];
    persistHistory();
    renderRecent();
    showToast('已清除搜索历史。');
  });
  on(dom.cacheClear, 'click', clearCache);

  // 阅读器
  on(dom.readerClose, 'click', () => closeReader());
  on(dom.readerBackdrop, 'click', () => closeReader());
  on(dom.readerCopy, 'click', () => {
    if (!state.reader) return;
    copyText(state.reader.item.url).then((ok) =>
      showToast(ok ? '原文链接已复制。' : '复制失败。', ok ? '' : 'error'),
    );
  });
  on(document, 'keydown', handleGlobalKeydown);

  // 路由
  window.addEventListener('popstate', () => applyRoute());
  if (ROUTE_MODE === 'hash') {
    // 手动改 hash / 某些浏览器只触发 hashchange，不触发 popstate
    window.addEventListener('hashchange', () => applyRoute());
  }
  on(dom.homeBrand, 'click', (event) => {
    event.preventDefault();
    navigate({});
  });
  $$('a[data-nav-home]').forEach((link) =>
    on(link, 'click', (event) => {
      event.preventDefault();
      navigate({});
    }),
  );

  // 系统主题变化
  if (window.matchMedia) {
    mediaThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (state.settings.theme === 'auto') applyTheme('auto', { persist: false });
    };
    if (typeof mediaThemeQuery.addEventListener === 'function') {
      mediaThemeQuery.addEventListener('change', onChange);
    } else if (typeof mediaThemeQuery.addListener === 'function') {
      mediaThemeQuery.addListener(onChange);
    }
  }

  // 对话框点击遮罩关闭
  [dom.settingsDialog, dom.helpDialog, dom.advancedDialog].forEach((dialog) => {
    if (!dialog) return;
    on(dialog, 'click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  });
}

function handleGlobalKeydown(event) {
  const target = event.target;
  const tag = target?.tagName;
  const typing =
    tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable === true;
  const modifier = event.metaKey || event.ctrlKey || event.altKey;

  // 阅读器是模态层：Tab 在面板内循环
  if (event.key === 'Tab' && dom.reader && !dom.reader.hidden) {
    const focusables = readerFocusables();
    if (focusables.length) {
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (!dom.reader.contains(active)) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
        return;
      }
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
        return;
      }
    }
  }

  if (event.key === 'Escape') {
    if (dom.reader && !dom.reader.hidden) {
      event.preventDefault();
      closeReader();
      return;
    }
    if (isDialogOpen()) return;
    if (dom.suggestList && !dom.suggestList.hidden) {
      hideSuggestions();
      return;
    }
  }

  if (modifier) return;

  if (event.key === '/' && !typing) {
    event.preventDefault();
    focusSearch();
    return;
  }

  if (event.key === '?' && !typing) {
    event.preventDefault();
    openHelp();
    return;
  }

  if (isDialogOpen() || (dom.reader && !dom.reader.hidden)) return;
  if (state.route !== 'results' || typing) return;

  const interactive = target?.closest
    ? target.closest('button, a, input, select, textarea, [contenteditable="true"], [role="button"], [role="link"], [role="tab"]')
    : null;

  if (event.key === 'j' || event.key === 'J') {
    event.preventDefault();
    moveSelection(1);
  } else if (event.key === 'k' || event.key === 'K') {
    event.preventDefault();
    moveSelection(-1);
  } else if (
    (event.key === 'Enter' || event.key === 'o' || event.key === 'O') &&
    state.selectedIndex >= 0 &&
    !interactive
  ) {
    event.preventDefault();
    openReaderForSelection();
  }
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

function cacheDom() {
  dom.homeView = $('#home-view');
  dom.resultsView = $('#results-view');
  dom.errorView = $('#error-view');
  dom.topbar = $('#topbar');
  dom.progress = $('#progress');
  dom.homeForm = $('#home-search-form');
  dom.homeInput = $('#home-q');
  dom.homeClear = $('#home-clear');
  dom.homeSearchBtn = $('#home-search-btn');
  dom.luckyBtn = $('#lucky-btn');
  dom.suggestList = $('#suggest-list');
  dom.homeStatus = $('#home-status');
  dom.recentBox = $('#recent-box');
  dom.recentList = $('#recent-list');
  dom.recentClear = $('#recent-clear');
  dom.homeBrand = $('.brand');
  dom.helpOpenHome = $('#home-help-open');
  dom.themeToggle = $('#theme-toggle');
  dom.resultsForm = $('#results-search-form');
  dom.resultsInput = $('#results-q');
  dom.resultsClear = $('#results-clear');
  dom.tabs = $('.tabs');
  dom.timeChips = $('#time-chips');
  dom.langSelect = $('#lang-select');
  dom.resultMeta = $('#result-meta');
  dom.overview = $('#overview');
  dom.resultList = $('#result-list');
  dom.pagination = $('#pagination');
  dom.footerStatus = $('#footer-status');
  dom.footerMode = $('#footer-mode');
  dom.toast = $('#toast');

  dom.settingsDialog = $('#settings-dialog');
  dom.apiKeyInput = $('#api-key-input');
  dom.apiKeySave = $('#api-key-save');
  dom.apiKeyClear = $('#api-key-clear');
  dom.apiKeyTest = $('#api-key-test');
  dom.keyStatus = $('#key-status');
  dom.keyHint = $('#key-hint');
  dom.keyTestResult = $('#key-test-result');
  dom.settingCount = $('#setting-count');
  dom.settingTheme = $('#setting-theme');
  dom.settingOverview = $('#setting-overview');
  dom.settingNewtab = $('#setting-newtab');
  dom.historyClear = $('#history-clear');
  dom.cacheInfo = $('#cache-info');
  dom.cacheClear = $('#cache-clear');
  dom.aboutInfo = $('#about-info');

  dom.helpDialog = $('#help-dialog');
  dom.advancedDialog = $('#advanced-dialog');
  dom.advAll = $('#adv-all');
  dom.advPhrase = $('#adv-phrase');
  dom.advExclude = $('#adv-exclude');
  dom.advSite = $('#adv-site');
  dom.advExcludeSite = $('#adv-exclude-site');
  dom.advLang = $('#adv-lang');
  dom.advAfter = $('#adv-after');
  dom.advBefore = $('#adv-before');
  dom.advPreview = $('#adv-preview');
  dom.advancedSearch = $('#adv-search');

  dom.reader = $('#reader');
  dom.readerBackdrop = $('.reader-backdrop');
  dom.readerTitle = $('#reader-title');
  dom.readerSource = $('#reader-source');
  dom.readerOpen = $('#reader-open');
  dom.readerCopy = $('#reader-copy');
  dom.readerClose = $('#reader-close');
  dom.readerBody = $('#reader-body');
}

async function init() {
  cacheDom();
  state.history = loadHistory();
  applyTheme(state.settings.theme, { persist: false });
  syncSettingsForm();
  renderRecent();
  renderFooterStatus();
  bindEvents();
  applyRoute();
  refreshStatus().catch(() => {
    /* 状态读取失败不应造成未处理的 Promise 错误；界面保持“未配置”状态 */
  });
  // 服务版首次进入首页时清空地址栏里的残留查询（单文件版用 hash，不需要）
  if (ROUTE_MODE === 'path' && state.route === 'home' && window.location.search) {
    replaceUrl('/');
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
