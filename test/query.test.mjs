import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TIME_RANGES,
  buildQuery,
  effectiveQuery,
  hasSearchContent,
  highlightTerms,
  parseQuery,
  removeToken,
} from '../public/js/query.js';

test('parseQuery 识别全部搜索语法', () => {
  const parsed = parseQuery(
    'DeepSeek "开源模型" -广告 -"release notes" site:github.com -site:csdn.net lang:zh,en after:2025-01-01 before:2026',
  );
  assert.deepEqual(parsed.terms, ['DeepSeek']);
  assert.deepEqual(parsed.phrases, ['开源模型']);
  assert.deepEqual(parsed.excludeTerms, ['广告']);
  assert.deepEqual(parsed.excludePhrases, ['release notes']);
  assert.deepEqual(parsed.sites, ['github.com']);
  assert.deepEqual(parsed.excludeSites, ['csdn.net']);
  assert.deepEqual(parsed.langs, ['zh', 'en']);
  assert.deepEqual(parsed.after, ['2025-01-01']);
  assert.deepEqual(parsed.before, ['2026']);
  assert.equal(parsed.tokens.length, 9);
});

test('parseQuery 保留 token 位置，removeToken 可以精确删除', () => {
  const query = 'DeepSeek site:github.com lang:zh';
  const parsed = parseQuery(query);
  const siteToken = parsed.tokens.find((token) => token.type === 'site');
  assert.equal(removeToken(query, siteToken), 'DeepSeek lang:zh');
});

test('buildQuery 生成语法并清理站点格式', () => {
  const query = buildQuery({
    all: 'DeepSeek',
    phrase: '开源模型',
    exclude: '广告 招聘',
    site: 'https://github.com/',
    excludeSite: 'csdn.net',
    lang: 'zh',
    after: '2025-01-01',
    before: '2026-06-01',
  });
  assert.equal(
    query,
    'DeepSeek "开源模型" -广告 -招聘 site:github.com -site:csdn.net lang:zh after:2025-01-01 before:2026-06-01',
  );
});

test('effectiveQuery 合并时间与语言筛选，且不重复添加', () => {
  const now = new Date('2026-10-24T12:00:00+08:00');
  assert.equal(effectiveQuery('DeepSeek', { time: 'week' }, now), 'DeepSeek after:2026-10-17');
  assert.equal(effectiveQuery('DeepSeek', { lang: 'en' }, now), 'DeepSeek lang:en');
  assert.equal(effectiveQuery('DeepSeek after:2020 lang:zh', { time: 'week', lang: 'en' }, now), 'DeepSeek after:2020 lang:zh');
  assert.equal(effectiveQuery('DeepSeek', { time: 'any', lang: 'all' }, now), 'DeepSeek');
});

test('highlightTerms 去重并包含短语', () => {
  const terms = highlightTerms('DeepSeek deepseek "开源 模型" site:github.com');
  assert.deepEqual(terms, ['DeepSeek', '开源 模型']);
});

test('hasSearchContent 判断是否有有效内容', () => {
  assert.equal(hasSearchContent('DeepSeek'), true);
  assert.equal(hasSearchContent('site:github.com'), true);
  assert.equal(hasSearchContent('   '), false);
  assert.equal(hasSearchContent('lang:zh'), false);
});

test('TIME_RANGES 定义完整', () => {
  assert.deepEqual(Object.keys(TIME_RANGES), ['any', 'day', 'week', 'month', 'year']);
});
