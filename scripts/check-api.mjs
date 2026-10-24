#!/usr/bin/env node
/**
 * 命令行自查：验证 API Key，并演示一次 Search + Fetch。
 *
 *   node scripts/check-api.mjs "DeepSeek V4"
 *
 * 会真实调用 DeepSeek API（Search 计费约 ¥0.005 / 次，Fetch 同价）。
 */
import { readConfig, resolveApiKey, maskKey, SOURCE_LABELS } from '../src/config.mjs';
import { fetchPage, search } from '../src/deepseek.mjs';

const query = (process.argv.slice(2).join(' ') || 'DeepSeek').trim();

const config = readConfig();
const keyInfo = resolveApiKey(config);
if (!keyInfo.key) {
  console.error('✘ 未找到 API Key。');
  console.error('  请设置环境变量 DEEPSEEK_API_KEY，或在网页设置中保存，或确认 ~/.dsh/.credentials.yaml 中存在 DEEPSEEK_API_KEY。');
  process.exit(2);
}

console.log(`✓ 密钥来源：${SOURCE_LABELS[keyInfo.source]}`);
console.log(`  密钥掩码：${maskKey(keyInfo.key)}`);

const started = Date.now();
const result = await search({ query, count: 3 }, { apiKey: keyInfo.key });
console.log(`\n✓ Search 成功（${result.meta.ms} ms，${result.results.length} 条结果，query="${result.meta.query}"）`);
for (const [index, item] of result.results.entries()) {
  console.log(`  ${index + 1}. [${item.rerankScore.toFixed(2)}] ${item.title}`);
  console.log(`     ${item.url}`);
  if (item.siteName) console.log(`     站点：${item.siteName}｜权威性：${item.authority}｜日期：${item.date || '未知'}`);
}

const first = result.results.find((item) => item.url);
if (first) {
  try {
    const page = await fetchPage({ url: first.url }, { apiKey: keyInfo.key });
    console.log(`\n✓ Fetch 成功（${page.meta.ms} ms，正文 ${page.meta.contentLength} 字符）：${page.title}`);
    console.log(`  正文开头：${page.content.slice(0, 120).replace(/\s+/g, ' ')}…`);
  } catch (error) {
    console.log(`\n✘ Fetch 失败：${error.message}`);
    process.exitCode = 1;
  }
}

console.log(`\n总耗时 ${Date.now() - started} ms。本次调用会产生 1–2 次计费请求。`);
