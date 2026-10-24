/**
 * 路由解析与构造（服务版 path 路由 / 单文件版 hash 路由共用）。
 *
 *   path 模式：/search?q=…&tab=…&p=…&t=…&l=…
 *   hash 模式：#/search?q=…&tab=…&p=…&t=…&l=…
 *
 * 纯函数，不读写 window，便于单测。
 */
import { TIME_RANGES } from './query.js';

export const ROUTE_TABS = new Set(['all', 'newest', 'authority']);
export const ROUTE_LANGS = new Set(['all', 'zh', 'en', 'ja', 'ko']);

function homeRoute() {
  return { view: 'home', q: '', tab: 'all', page: 1, time: 'any', lang: 'all' };
}

function parseRouteParams(searchParams) {
  const tab = searchParams.get('tab') || 'all';
  const time = searchParams.get('t') || 'any';
  const lang = searchParams.get('l') || 'all';
  const page = Number(searchParams.get('p')) || 1;
  return {
    view: 'results',
    q: searchParams.get('q') || '',
    tab: ROUTE_TABS.has(tab) ? tab : 'all',
    page: Math.max(1, Math.trunc(page)),
    time: Object.prototype.hasOwnProperty.call(TIME_RANGES, time) ? time : 'any',
    lang: ROUTE_LANGS.has(lang) ? lang : 'all',
  };
}

/**
 * 从 location 对象解析路由。
 * @param {{pathname?:string, search?:string, hash?:string}} locationLike
 * @param {'path'|'hash'} mode
 */
export function readRouteFrom(locationLike, mode = 'path') {
  if (mode === 'hash') {
    const hash = String(locationLike.hash || '').replace(/^#/, '');
    if (!hash || hash === '/') return homeRoute();
    let url;
    try {
      url = new URL(hash, 'http://local.invalid');
    } catch {
      return homeRoute();
    }
    if (url.pathname !== '/search') return homeRoute();
    return parseRouteParams(url.searchParams);
  }

  let url;
  try {
    url = new URL(`${locationLike.pathname || '/'}${locationLike.search || ''}`, 'http://local.invalid');
  } catch {
    return homeRoute();
  }
  if (url.pathname !== '/search') return homeRoute();
  return parseRouteParams(url.searchParams);
}

/**
 * 构造路由 href。
 * @param {{q?:string, tab?:string, page?:number, time?:string, lang?:string}} params
 * @param {'path'|'hash'} mode
 */
export function buildRouteHref(params = {}, mode = 'path') {
  const q = String(params.q || '').trim();
  const home = mode === 'hash' ? '#/' : '/';
  if (!q) return home;

  const search = new URLSearchParams();
  search.set('q', q);
  if (params.tab && params.tab !== 'all') search.set('tab', params.tab);
  if (params.page && params.page > 1) search.set('p', String(params.page));
  if (params.time && params.time !== 'any') search.set('t', params.time);
  if (params.lang && params.lang !== 'all') search.set('l', params.lang);

  const path = `/search?${search.toString()}`;
  return mode === 'hash' ? `#${path}` : path;
}

/** 当前地址的简写形式，用于判断是否需要写入历史。 */
export function currentHref(locationLike, mode = 'path') {
  if (mode === 'hash') return String(locationLike.hash || '') || '#/';
  return `${locationLike.pathname || '/'}${locationLike.search || ''}`;
}
