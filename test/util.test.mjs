import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanDisplayText,
  cleanTitle,
  domainHue,
  escapeHtml,
  highlightText,
  prettyUrlParts,
  relativeTime,
  safeHttpUrl,
  smartJoin,
  truncateText,
  unicodeLength,
} from '../public/js/util.js';

test('escapeHtml 转义全部 HTML 元字符', () => {
  assert.equal(escapeHtml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  assert.equal(escapeHtml(null), '');
});

test('safeHttpUrl 只放行 http/https（可选 mailto）', () => {
  assert.equal(safeHttpUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(safeHttpUrl('http://example.com'), 'http://example.com/');
  assert.equal(safeHttpUrl('javascript:alert(1)'), null);
  assert.equal(safeHttpUrl('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(safeHttpUrl('/relative/path'), null);
  assert.equal(safeHttpUrl('mailto:a@b.com'), null);
  assert.equal(safeHttpUrl('mailto:a@b.com', { allowMailto: true }), 'mailto:a@b.com');
});

test('highlightText 安全高亮：先切分再转义', () => {
  const html = highlightText('DeepSeek <script>alert(1)</script> DeepSeek', ['DeepSeek']);
  assert.ok(html.includes('<mark>DeepSeek</mark>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.equal(highlightText('abc', []), 'abc');
});

test('cleanDisplayText 去掉摘要开头的 Markdown 标记', () => {
  assert.equal(cleanDisplayText('# DeepSeek 发布\n\n新模型上线'), 'DeepSeek 发布 新模型上线');
  assert.equal(cleanDisplayText('- 第一项\n- 第二项'), '第一项 第二项');
  assert.equal(cleanDisplayText('1. 第一项\n2. 第二项'), '第一项 第二项');
  assert.equal(cleanDisplayText('  a   b  '), 'a b');
  assert.equal(cleanDisplayText('a \\# b'), 'a # b');
  assert.equal(cleanDisplayText('a \\* b'), 'a * b');
});

test('cleanTitle 去掉重复的标题后缀', () => {
  assert.equal(cleanTitle('DeepSeek V4 来了 - DeepSeek V4 来了'), 'DeepSeek V4 来了');
  assert.equal(cleanTitle('说明 - 站点名'), '说明 - 站点名');
  assert.equal(cleanTitle('A - A：补充说明'), 'A');
  assert.equal(cleanTitle('正常标题'), '正常标题');
});

test('prettyUrlParts 生成面包屑', () => {
  const parts = prettyUrlParts('https://www.example.com/a/b/c/d?x=1');
  assert.equal(parts.host, 'example.com');
  assert.equal(parts.path, 'a › b › c');
});

test('relativeTime 中文相对时间', () => {
  const now = new Date('2026-10-24T12:00:00+08:00');
  assert.equal(relativeTime('2026-10-24T11:59:30+08:00', now), '刚刚');
  assert.equal(relativeTime('2026-10-24T09:00:00+08:00', now), '3 小时前');
  assert.equal(relativeTime('2026-10-20T12:00:00+08:00', now), '4 天前');
  assert.equal(relativeTime(null), '');
});

test('smartJoin 中文之间不加空格，英文之间加', () => {
  assert.equal(smartJoin('DeepSeek', 'V4'), 'DeepSeek V4');
  assert.equal(smartJoin('深度', '求索'), '深度求索');
  assert.equal(smartJoin('DeepSeek', '发布'), 'DeepSeek发布');
});

test('truncateText / unicodeLength / domainHue', () => {
  assert.equal(truncateText('abcdef', 4), 'abc…');
  assert.equal(truncateText('abc', 4), 'abc');
  assert.equal(unicodeLength('😀ab'), 3);
  assert.equal(typeof domainHue('https://example.com'), 'number');
});
