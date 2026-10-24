import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROUTE_LANGS,
  ROUTE_TABS,
  buildRouteHref,
  currentHref,
  readRouteFrom,
} from '../public/js/routing.js';

test('path 模式：首页与结果页解析', () => {
  assert.deepEqual(readRouteFrom({ pathname: '/', search: '' }, 'path'), {
    view: 'home',
    q: '',
    tab: 'all',
    page: 1,
    time: 'any',
    lang: 'all',
  });
  assert.deepEqual(
    readRouteFrom(
      { pathname: '/search', search: '?q=DeepSeek&tab=newest&p=2&t=month&l=zh' },
      'path',
    ),
    {
      view: 'results',
      q: 'DeepSeek',
      tab: 'newest',
      page: 2,
      time: 'month',
      lang: 'zh',
    },
  );
});

test('path 模式：非法参数回退默认值', () => {
  const route = readRouteFrom(
    { pathname: '/search', search: '?q=x&tab=bad&p=-3&t=decade&l=xx' },
    'path',
  );
  assert.equal(route.tab, 'all');
  assert.equal(route.page, 1);
  assert.equal(route.time, 'any');
  assert.equal(route.lang, 'all');
});

test('hash 模式：空 hash 为首页，搜索结果可解析', () => {
  assert.equal(readRouteFrom({ hash: '' }, 'hash').view, 'home');
  assert.equal(readRouteFrom({ hash: '#' }, 'hash').view, 'home');
  assert.equal(readRouteFrom({ hash: '#/' }, 'hash').view, 'home');

  const route = readRouteFrom(
    { hash: '#/search?q=DeepSeek+V4&tab=authority&p=3&t=week&l=en' },
    'hash',
  );
  assert.deepEqual(route, {
    view: 'results',
    q: 'DeepSeek V4',
    tab: 'authority',
    page: 3,
    time: 'week',
    lang: 'en',
  });
});

test('hash 模式：URL 编码与非法 hash', () => {
  const route = readRouteFrom(
    { hash: '#/search?q=%E6%B7%B1%E5%BA%A6%E6%B1%82%E7%B4%A2&tab=all' },
    'hash',
  );
  assert.equal(route.q, '深度求索');
  assert.equal(readRouteFrom({ hash: '#something-else' }, 'hash').view, 'home');
});

test('buildRouteHref：path 模式构造与 round-trip', () => {
  const href = buildRouteHref(
    { q: 'a b&c', tab: 'newest', page: 2, time: 'month', lang: 'zh' },
    'path',
  );
  assert.ok(href.startsWith('/search?'));
  assert.ok(href.includes('q=a+b%26c'));
  assert.ok(href.includes('tab=newest'));
  assert.ok(href.includes('p=2'));
  assert.ok(href.includes('t=month'));
  assert.ok(href.includes('l=zh'));
  const parsed = readRouteFrom(
    { pathname: href.split('?')[0], search: `?${href.split('?')[1]}` },
    'path',
  );
  assert.equal(parsed.q, 'a b&c');
  assert.equal(parsed.tab, 'newest');
  assert.equal(parsed.page, 2);
});

test('buildRouteHref：hash 模式与首页', () => {
  assert.equal(buildRouteHref({ q: '' }, 'hash'), '#/');
  assert.equal(buildRouteHref({}, 'path'), '/');
  const href = buildRouteHref({ q: 'DeepSeek', page: 1 }, 'hash');
  assert.equal(href, '#/search?q=DeepSeek');
  assert.equal(readRouteFrom({ hash: href }, 'hash').q, 'DeepSeek');
});

test('currentHref 便于比较是否写入历史', () => {
  assert.equal(currentHref({ pathname: '/search', search: '?q=x' }, 'path'), '/search?q=x');
  assert.equal(currentHref({ hash: '#/search?q=x' }, 'hash'), '#/search?q=x');
  assert.equal(currentHref({ hash: '' }, 'hash'), '#/');
});

test('路由常量覆盖 UI 选项', () => {
  assert.deepEqual([...ROUTE_TABS], ['all', 'newest', 'authority']);
  assert.ok(ROUTE_LANGS.has('zh'));
  assert.ok(ROUTE_LANGS.has('all'));
});
