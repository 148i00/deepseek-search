import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const OUT = path.join(ROOT, 'docs', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });
// 清理旧截图，避免混淆
for (const name of ['home.png', 'results.png', 'reader.png']) {
  try { fs.unlinkSync(path.join(OUT, name)); } catch {}
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, colorScheme: 'light', locale: 'zh-CN' });
const page = await context.newPage();

const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('requestfailed', (request) => {
  if (!request.url().includes('/site-icons/')) failedRequests.push(`${request.method()} ${request.url()} :: ${request.failure()?.errorText}`);
});

const report = { checks: {} };
const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}
const shot = async (name, options = {}) => {
  await page.screenshot({ path: path.join(OUT, name), ...options });
};
const text = async (selector) => (await page.locator(selector).first().innerText()).replace(/\s+/g, ' ').trim();

async function waitForServer(url, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`服务未在 ${timeoutMs}ms 内启动：${url}`);
}

try {
  /* 1. 首页 */
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(400);
  report.checks.homeTitle = await page.title();
  report.checks.homeWordmark = await text('.home-wordmark');
  report.checks.homeStatusHidden = await page.locator('#home-status').isHidden();
  report.checks.homeClearHidden = await page.locator('#home-clear').isHidden();
  await shot('home-light.png');

  /* 2. 首页建议下拉（最近搜索为空时应隐藏；先做一次搜索再回首页验证） */
  await page.fill('#home-q', 'DeepSeek V4 发布');
  await page.press('#home-q', 'Enter');
  await page.waitForSelector('.result', { timeout: 45000 });
  await page.waitForTimeout(300);

  report.checks.url = page.url();
  report.checks.resultCount = await page.locator('.result').count();
  report.checks.meta = await text('#result-meta');
  report.checks.firstTitle = await text('.result-title');
  report.checks.firstTarget = await page.locator('.result-title').first().getAttribute('target');
  report.checks.overviewCount = await page.locator('.overview').count();
  report.checks.overviewHasMarkdownHash = (await page.locator('.overview').innerText()).includes('# DeepSeek');
  report.checks.pageButtons = await page.locator('.page-btn').count();
  report.checks.titleHighlight = await page.locator('.result-title mark').count();
  await shot('results-light.png');

  /* 3. 排序 tab */
  const firstTitleAll = report.checks.firstTitle;
  await page.click('.tab[data-tab="newest"]');
  await page.waitForTimeout(500);
  report.checks.newestFirstTitle = await text('.result-title');
  report.checks.newestChanged = report.checks.newestFirstTitle !== firstTitleAll;
  await shot('results-newest.png');

  /* 4. 分页 */
  await page.click('.tab[data-tab="all"]');
  await page.waitForTimeout(300);
  await page.click('.page-btn[data-page="2"]');
  await page.waitForFunction(() => window.location.search.includes('p=2'), null, { timeout: 10000 });
  await page.waitForTimeout(400);
  report.checks.page2Url = page.url();
  report.checks.page2FirstTitle = await text('.result-title');
  report.checks.page2Differs = report.checks.page2FirstTitle !== firstTitleAll;
  report.checks.page2Active = await page.locator('.page-btn.is-active').innerText();
  await shot('results-page2.png');

  /* 5. 时间筛选 */
  await page.click('.page-btn[data-page="1"]');
  await page.waitForTimeout(300);
  await page.click('.chip[data-time="month"]');
  await page.waitForSelector('.result', { timeout: 45000 });
  await page.waitForTimeout(400);
  report.checks.filterUrl = page.url();
  report.checks.filterMeta = await text('#result-meta');
  await shot('results-filtered.png');
  await page.click('.chip[data-time="any"]');
  await page.waitForSelector('.result', { timeout: 45000 });
  await page.waitForTimeout(400);

  /* 6. 阅读器：文档页（验证 Markdown 结构） */
  await page.fill('#results-q', 'site:api-docs.deepseek.com 网页搜索与抓取');
  await page.press('#results-q', 'Enter');
  await page.waitForSelector('.result', { timeout: 45000 });
  await page.waitForTimeout(300);
  report.checks.docsResultCount = await page.locator('.result').count();
  await page.locator('.result').first().locator('[data-action="read"]').click();
  await page.waitForSelector('.reader-body .md-article, .reader-error', { timeout: 60000 });
  await page.waitForTimeout(600);
  report.checks.readerArticle = await page.locator('.reader-body .md-article').count();
  report.checks.readerHeadings = await page.locator('.reader-body h1, .reader-body h2, .reader-body h3').count();
  report.checks.readerTables = await page.locator('.reader-body table').count();
  report.checks.readerPre = await page.locator('.reader-body pre').count();
  report.checks.readerLinks = await page.locator('.reader-body a').count();
  report.checks.readerTitle = await text('#reader-title');
  report.checks.readerRawEscapes = (await page.locator('.reader-body').innerText()).includes('\\#');
  report.checks.readerTextLen = (await page.locator('.reader-body').innerText()).length;
  // 模态焦点：打开后焦点在关闭按钮、背景 inert、Tab 不会跑出面板
  report.checks.readerInitialFocus = await page.evaluate(() => document.activeElement?.id || '');
  report.checks.readerInert = await page.evaluate(
    () => document.querySelector('.main')?.hasAttribute('inert') === true,
  );
  await page.keyboard.press('Tab');
  report.checks.readerTabStaysInside = await page.evaluate(
    () => document.querySelector('#reader')?.contains(document.activeElement) === true,
  );
  await shot('reader-docs.png');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  report.checks.readerInertRemoved = await page.evaluate(
    () => document.querySelector('.main')?.hasAttribute('inert') !== true,
  );
  report.checks.readerClosed = await page.locator('#reader').isHidden();

  /* 7. 键盘导航 */
  await page.keyboard.press('j');
  await page.waitForTimeout(200);
  report.checks.selectedAfterJ = await page.locator('.result.is-selected').count();
  await page.keyboard.press('Enter');
  await page.waitForSelector('.reader-body .md-article, .reader-error', { timeout: 60000 });
  report.checks.readerOpenedByKeyboard = await page.locator('#reader').isVisible();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  /* 7.0 Enter 快捷键不应劫持聚焦按钮的默认行为 */
  await page.evaluate(() => document.querySelector('#settings-open').focus());
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  report.checks.enterOnButtonOpenedSettings = await page.locator('#settings-dialog').isVisible();
  report.checks.enterOnButtonReaderHidden = await page.locator('#reader').isHidden();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  /* 7.1 键盘快捷键：/ 聚焦搜索框 */
  await page.locator('body').click({ position: { x: 10, y: 500 } });
  await page.keyboard.press('/');
  await page.waitForTimeout(200);
  report.checks.slashFocus = await page.evaluate(() => document.activeElement?.id);

  /* 7.2 超长查询被前端拦截 */
  await page.fill('#results-q', 'x'.repeat(200));
  await page.press('#results-q', 'Enter');
  await page.waitForTimeout(400);
  report.checks.longQueryToast = (await page.locator('#toast').innerText().catch(() => '')).trim();
  report.checks.longQueryStayed = page.url().includes('/search');

  /* 7.3 浏览器前进 / 后退 */
  const urlBeforeBack = page.url();
  await page.goBack();
  await page.waitForTimeout(1200);
  report.checks.backUrlChanged = page.url() !== urlBeforeBack;
  await page.goForward();
  await page.waitForTimeout(1500);
  report.checks.forwardRestored = page.url() === urlBeforeBack;
  await page.waitForSelector('.result', { timeout: 45000 }).catch(() => {});

  /* 7.4 首页角落按钮：设置 + 主题 */
  await page.locator('.brand').click();
  await page.waitForTimeout(500);
  report.checks.backToHomeByLogo = await page.locator('#home-view').isVisible();
  await page.click('.home-corner [data-action="open-settings"]');
  await page.waitForTimeout(300);
  report.checks.cornerSettings = await page.locator('#settings-dialog').isVisible();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const themeBefore = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.click('.home-corner [data-action="toggle-theme"]');
  await page.waitForTimeout(300);
  const themeAfter = await page.evaluate(() => document.documentElement.dataset.theme);
  report.checks.cornerTheme = `${themeBefore} -> ${themeAfter}`;
  await page.click('.home-corner [data-action="toggle-theme"]');
  await page.waitForTimeout(200);

  /* 回到结果页，继续测试设置 / 暗色模式 */
  await page.fill('#home-q', 'DeepSeek V4 发布');
  await page.press('#home-q', 'Enter');
  await page.waitForSelector('.result', { timeout: 45000 });
  await page.waitForTimeout(300);

  /* 8. 设置对话框 + 测试连接 */
  await page.click('#settings-open');
  await page.waitForTimeout(300);
  report.checks.settingsVisible = await page.locator('#settings-dialog').isVisible();
  report.checks.keyStatus = await text('#key-status');
  // 点击「搜索历史」文字不应触发清除按钮
  const historyBefore = await page.evaluate(
    () => JSON.parse(localStorage.getItem('dss.history.v1') || '[]').length,
  );
  await page.locator('#settings-dialog').getByText('搜索历史', { exact: true }).click();
  await page.waitForTimeout(200);
  const historyAfter = await page.evaluate(
    () => JSON.parse(localStorage.getItem('dss.history.v1') || '[]').length,
  );
  report.checks.historyLabelSafe = historyBefore > 0 && historyAfter === historyBefore;
  await page.click('#api-key-test');
  await page.waitForFunction(
    () => {
      const el = document.querySelector('#key-test-result');
      return el && !el.hidden && !el.textContent.includes('正在测试连接');
    },
    null,
    { timeout: 40000 },
  );
  report.checks.keyTest = await text('#key-test-result');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  /* 9. 暗色主题 */
  await page.click('#theme-toggle');
  await page.waitForTimeout(400);
  report.checks.theme = await page.evaluate(() => document.documentElement.dataset.theme);
  await shot('results-dark.png');
  await page.click('#theme-toggle');
  await page.waitForTimeout(300);

  /* 10. 高级搜索 */
  await page.click('#advanced-open');
  await page.waitForTimeout(300);
  await page.fill('#adv-phrase', '开源模型');
  await page.fill('#adv-site', 'github.com');
  await page.waitForTimeout(200);
  report.checks.advPreview = await text('#adv-preview');
  await shot('advanced.png');
  await page.click('#advanced-dialog [data-close-dialog]');
  await page.waitForTimeout(300);
  report.checks.advancedCancelCloses = await page.locator('#advanced-dialog').isHidden();

  /* 11. 空结果 */
  await page.goto(`${BASE}/search?q=${encodeURIComponent('DeepSeek site:no-such-site-abcdef123.invalid')}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('#result-list .state-card', { timeout: 45000 });
  await page.waitForTimeout(400);
  report.checks.emptyState = await text('#result-list .state-card h2');
  await shot('empty.png');

  /* 12. 首页最近搜索 */
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  report.checks.recentChips = await page.locator('.recent-chip').count();
  await page.fill('#home-q', 'Deep');
  await page.waitForTimeout(400);
  report.checks.suggestItems = await page.locator('.suggest-item').count();
  report.checks.suggestHidden = await page.locator('#suggest-list').isHidden();
  await shot('home-suggest.png');
  await page.keyboard.press('Escape');

  /* 13. 移动端 */
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light', locale: 'zh-CN', isMobile: true, hasTouch: true });
  const mobilePage = await mobile.newPage();
  await mobilePage.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await mobilePage.waitForTimeout(400);
  await mobilePage.screenshot({ path: path.join(OUT, 'mobile-home.png') });
  await mobilePage.fill('#home-q', 'DeepSeek');
  await mobilePage.press('#home-q', 'Enter');
  await mobilePage.waitForSelector('.result', { timeout: 45000 });
  await mobilePage.waitForTimeout(400);
  await mobilePage.screenshot({ path: path.join(OUT, 'mobile-results.png') });
  report.checks.mobileResults = await mobilePage.locator('.result').count();
  report.checks.mobileHorizontalOverflow = await mobilePage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  await mobile.close();

  /* 14. 无密钥场景（独立临时 HOME + 临时数据目录） */
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dss-home-'));
  const noKeyData = fs.mkdtempSync(path.join(os.tmpdir(), 'dss-nokey-'));
  const child = spawn(process.execPath, ['server.mjs', '--port', '8792'], {
    cwd: ROOT,
    env: {
      ...process.env,
      USERPROFILE: fakeHome,
      HOME: fakeHome,
      DSH_SEARCH_DATA: noKeyData,
      DEEPSEEK_API_KEY: '',
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  try {
    await waitForServer('http://127.0.0.1:8792');
    const noKeyContext = await browser.newContext({
      viewport: { width: 1280, height: 1000 },
      colorScheme: 'light',
      locale: 'zh-CN',
    });
    const noKeyPage = await noKeyContext.newPage();
    await noKeyPage.goto('http://127.0.0.1:8792/', { waitUntil: 'networkidle' });
    await noKeyPage.waitForTimeout(300);
    report.checks.noKeyBanner = await noKeyPage.locator('#home-status').isVisible();
    await noKeyPage.screenshot({ path: path.join(OUT, 'home-nokey.png') });
    await noKeyPage.fill('#home-q', 'DeepSeek');
    await noKeyPage.press('#home-q', 'Enter');
    await noKeyPage.waitForSelector('#result-list .state-card', { timeout: 15000 });
    report.checks.noKeyError = (await noKeyPage.locator('#result-list .state-card h2').innerText()).trim();
    report.checks.noKeySetupButton = await noKeyPage.locator('#result-list [data-action="open-settings"]').count();
    await noKeyPage.screenshot({ path: path.join(OUT, 'no-key.png') });
    await noKeyContext.close();
  } finally {
    child.kill();
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(noKeyData, { recursive: true, force: true });
  }
} catch (error) {
  report.fatal = `${error.message}\n${error.stack || ''}`;
} finally {
  report.consoleErrors = consoleErrors.slice(0, 10);
  report.pageErrors = pageErrors.slice(0, 10);
  report.failedRequests = failedRequests.slice(0, 10);

  const c = report.checks;
  check(!report.fatal, `fatal: ${report.fatal || ''}`);
  check(report.consoleErrors.length === 0, `console errors: ${JSON.stringify(report.consoleErrors)}`);
  check(report.pageErrors.length === 0, `page errors: ${JSON.stringify(report.pageErrors)}`);
  check(report.failedRequests.length === 0, `failed requests: ${JSON.stringify(report.failedRequests)}`);
  check(c.homeTitle === 'DeepSeek 搜索', '首页标题不正确');
  check(c.homeStatusHidden === true, '已配置时首页仍显示未配置提示');
  check(typeof c.url === 'string' && c.url.includes('/search?q='), '搜索后 URL 不是结果页');
  check(c.resultCount >= 10, `结果数不足：${c.resultCount}`);
  check(c.pageButtons >= 2, '分页按钮不足');
  check(c.page2Differs === true, '第 2 页内容与第 1 页相同');
  check(c.readerArticle === 1, '阅读器未渲染文章');
  check(c.readerHeadings >= 1, '阅读器缺少标题');
  check(c.readerRawEscapes === false, '阅读器出现原始 Markdown 转义');
  check(c.readerInert === true && c.readerTabStaysInside === true, '阅读器焦点隔离失败');
  check(c.readerInertRemoved === true && c.readerClosed === true, '阅读器关闭后未恢复页面');
  check(c.backUrlChanged === true && c.forwardRestored === true, '前进/后退未恢复 URL');
  check(c.backToHomeByLogo === true, '点击 Logo 未回到首页');
  check(c.settingsVisible === true, '设置对话框未打开');
  check(String(c.keyStatus || '').includes('已配置'), '设置页未显示已配置状态');
  check(String(c.keyTest || '').includes('连接成功'), '测试连接失败');
  check(c.advancedCancelCloses === true, '高级搜索取消按钮无效');
  check(String(c.emptyState || '').includes('没有找到'), '空结果状态未显示');
  check(c.mobileResults >= 1, '移动端无结果');
  check(c.mobileHorizontalOverflow === false, '移动端出现横向溢出');
  check(c.noKeyBanner === true, '无 Key 实例未显示横幅');
  check(String(c.noKeyError || '').includes('API Key'), '无 Key 搜索未提示配置');
  check(c.noKeySetupButton >= 1, '无 Key 搜索缺少设置按钮');

  report.failures = failures;
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) {
    console.error(`\nE2E 失败：${failures.length} 项检查未通过`);
    for (const failure of failures) console.error(` - ${failure}`);
    process.exitCode = 1;
  }
  await browser.close();
}
