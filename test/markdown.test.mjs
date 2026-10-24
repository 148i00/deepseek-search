import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, stripDuplicateTitle, unescapeMarkdown } from '../public/js/markdown.js';

test('标题、段落、列表、引用', () => {
  const html = renderMarkdown(`# 一级标题

这是一个段落。

## 二级标题

- 第一项
- 第二项
  - 嵌套项

> 引用内容`);

  assert.ok(html.includes('<h1 id="一级标题">一级标题</h1>'), html);
  assert.ok(html.includes('<h2 id="二级标题">二级标题</h2>'), html);
  assert.ok(html.includes('<p>这是一个段落。</p>'), html);
  assert.ok(html.includes('<ul><li>第一项</li><li>第二项<ul><li>嵌套项</li></ul></li></ul>'), html);
  assert.ok(html.includes('<blockquote><p>引用内容</p></blockquote>'), html);
});

test('表格渲染', () => {
  const html = renderMarkdown(`| 名称 | 说明 |
| --- | :---: |
| Search | 搜索 |
| Fetch | 抓取 |`);

  assert.ok(html.includes('<table>'), html);
  assert.ok(html.includes('<th class="md-align-left">名称</th>'), html);
  assert.ok(html.includes('<th class="md-align-center">说明</th>'), html);
  assert.ok(html.includes('<td class="md-align-left">Search</td>'), html);
  assert.ok(html.includes('<td class="md-align-center">搜索</td>'), html);
});

test('行内语法：加粗、斜体、删除线、代码、链接', () => {
  const html = renderMarkdown(
    '**加粗** *斜体* ~~删除~~ `code <b>` [链接](https://example.com/a?b=1) ![图](https://example.com/x.png)',
  );
  assert.ok(html.includes('<strong>加粗</strong>'), html);
  assert.ok(html.includes('<em>斜体</em>'), html);
  assert.ok(html.includes('<del>删除</del>'), html);
  assert.ok(html.includes('<code>code &lt;b&gt;</code>'), html);
  assert.ok(
    html.includes('<a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer">链接</a>'),
    html,
  );
  assert.ok(
    html.includes(
      '<img src="https://example.com/x.png" alt="图" loading="lazy" decoding="async" referrerpolicy="no-referrer" />',
    ),
    html,
  );
});

test('链接 / 图片 URL 与 alt 中的 & 只转义一次', () => {
  const link = renderMarkdown('[x](https://example.com/?a=1&b=2)');
  assert.ok(link.includes('href="https://example.com/?a=1&amp;b=2"'), link);
  assert.ok(!link.includes('&amp;amp;'), link);
  const image = renderMarkdown('![a&b](https://example.com/i.png?x=1&y=2)');
  assert.ok(image.includes('alt="a&amp;b"'), image);
  assert.ok(image.includes('src="https://example.com/i.png?x=1&amp;y=2"'), image);
  assert.ok(!image.includes('&amp;amp;'), image);
});

test('代码围栏内的 Markdown 不解析', () => {
  const html = renderMarkdown('```js\nconst a = "# not heading";\nconsole.log("<b>");\n```');
  assert.ok(html.includes('<pre class="md-code" data-lang="js"><code>'), html);
  assert.ok(html.includes('const a = &quot;'), html);
  assert.ok(html.includes('&lt;b&gt;'), html);
  assert.ok(!html.includes('<h1'), html);
  assert.ok(!html.includes('<b>'), html);
});

test('XSS：原始 HTML、危险链接与非 https 图片都被降级', () => {
  const html = renderMarkdown(
    '<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n[坏链接](javascript:alert(3)) [data](data:text/html,x)\n\n![坏图](javascript:alert(4))',
  );
  assert.ok(!html.includes('<script>'), html);
  assert.ok(!html.includes('<img src=x'), html);
  assert.ok(!html.includes('javascript:'), html);
  assert.ok(!html.includes('data:text/html'), html);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), html);
  assert.ok(html.includes('&lt;img src=x onerror=alert(2)&gt;'), html);
  assert.ok(html.includes('坏链接'), html);
  assert.ok(html.includes('坏图'), html);
});

test('还原 DeepSeek Fetch 的标点转义并识别结构', () => {
  const raw = [
    '\\# 网页搜索与抓取',
    '',
    'Search 接口和 Fetch 接口为 Agent 与 RAG 应用提供实时网页内容：',
    '',
    '\\- Search 接口按 query 搜索网页。',
    '\\- Fetch 接口抓取单个网页。',
    '',
    'API \\| Endpoint ',
    '\\-\\-\\-\\|\\-\\-\\-',
    'Search \\| POST https\\:\\/\\/api\\.deepseek\\.com\\/v1\\/tools\\/search ',
    '',
    '\\#\\# 鉴权',
    '',
    'Bearer \\<DeepSeek API Key\\>',
  ].join('\n');

  const unescaped = unescapeMarkdown(raw);
  assert.ok(unescaped.includes('# 网页搜索与抓取'));
  assert.ok(unescaped.includes('https://api.deepseek.com/v1/tools/search'));
  assert.ok(unescaped.includes('---|---'));

  const html = renderMarkdown(raw);
  assert.ok(html.includes('<h1 id="网页搜索与抓取">网页搜索与抓取</h1>'), html);
  assert.ok(html.includes('<h2 id="鉴权">鉴权</h2>'), html);
  assert.ok(html.includes('<ul><li>Search 接口按 query 搜索网页。</li>'), html);
  assert.ok(html.includes('<table>'), html);
  assert.ok(html.includes('https://api.deepseek.com/v1/tools/search'), html);
  assert.ok(!html.includes('\\#'), html);
});

test('被拍平的命令行缩进块用 pre 保留换行', () => {
  const raw = ['curl https://api.deepseek.com/v1/tools/search \\', '  -H "Authorization: Bearer sk-x" \\', "  -d '{\"query\":\"x\"}'"].join('\n');
  const html = renderMarkdown(raw);
  assert.ok(html.includes('<pre class="md-code md-code--flat"><code>'), html);
  assert.ok(html.includes('  -H &quot;Authorization: Bearer sk-x&quot; \\'), html);
});

test('stripDuplicateTitle 去掉与标题重复的开头 H1', () => {
  const md = '\\# 网页搜索与抓取\n\n正文第一段。';
  assert.equal(stripDuplicateTitle(md, '网页搜索与抓取'), '正文第一段。');
  const keep = '# 另一个标题\n\n正文';
  assert.equal(stripDuplicateTitle(keep, '网页搜索与抓取'), keep);
});

test('stripDuplicateTitle 跳过正文前的横幅文字', () => {
  const md = 'Search / Fetch API 已上线。\n\n\\# 网页搜索与抓取\n\n正文第一段。';
  assert.equal(stripDuplicateTitle(md, '网页搜索与抓取'), 'Search / Fetch API 已上线。\n\n正文第一段。');
});

test('空内容返回占位', () => {
  assert.ok(renderMarkdown('').includes('没有可显示的正文'));
});

test('重复标题 id 自动去重', () => {
  const html = renderMarkdown('# 同名\n\n内容\n\n# 同名');
  assert.ok(html.includes('id="同名"'));
  assert.ok(html.includes('id="同名-2"'));
});
