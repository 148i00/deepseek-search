import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const PERSONAL = path.join(ROOT, 'dist', 'deepseek-search-personal.html');
const GENERIC = path.join(ROOT, 'dist', 'deepseek-search.html');

function readLocalKey() {
  const cred = path.join(os.homedir(), '.dsh', '.credentials.yaml');
  try {
    const text = fs.readFileSync(cred, 'utf8');
    const match = text.match(/DEEPSEEK_API_KEY:\s*([^\s#]+)/);
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

if (!fs.existsSync(PERSONAL) || !fs.existsSync(GENERIC)) {
  console.error('缺少 dist 构建产物，请先执行：');
  console.error('  node scripts/build-standalone.mjs');
  console.error('  node scripts/build-standalone.mjs --embed-key');
  process.exit(2);
}

const localKey = readLocalKey();
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const report = { checks: {}, errors: [], pageErrors: [], requests: [] };
const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}

function watch(page) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') report.errors.push(msg.text());
  });
  page.on('pageerror', (error) => report.pageErrors.push(error.message));
  page.on('request', (request) => {
    const url = request.url();
    try {
      report.requests.push(new URL(url).host || 'file');
    } catch {
      report.requests.push('unknown');
    }
  });
}

try {
  /* ============ 1. personal（内嵌 Key）============ */
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
    colorScheme: 'light',
    locale: 'zh-CN',
  });
  const page = await context.newPage();
  watch(page);

  await page.goto(pathToFileURL(PERSONAL).href, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#home-view:not([hidden])', { timeout: 15000 });
  await page.waitForTimeout(400);

  report.checks.personalProtocol = await page.evaluate(() => location.protocol);
  report.checks.homeVisible = await page.locator('#home-view').isVisible();
  report.checks.footerMode = (await page.locator('#footer-mode').innerText()).trim();
  report.checks.configuredHiddenBanner = await page.locator('#home-status').isHidden();
  await page.screenshot({ path: path.join(OUT, 'standalone-home.png') });

  await page.fill('#home-q', 'DeepSeek 搜索 API');
  await page.press('#home-q', 'Enter');
  await page.waitForSelector('.result', { timeout: 45000 });
  await page.waitForTimeout(400);

  report.checks.results = await page.locator('.result').count();
  report.checks.hashUrl = await page.evaluate(() => location.hash);
  report.checks.meta = (await page.locator('#result-meta').innerText()).replace(/\s+/g, ' ').trim();
  report.checks.firstTitle = (await page.locator('.result-title').first().innerText()).trim();
  report.checks.hasLocalhostRequest = report.requests.some(
    (host) => host === '127.0.0.1' || host === 'localhost',
  );
  report.checks.apiHosts = [...new Set(report.requests)].filter((host) => host !== 'file');
  await page.screenshot({ path: path.join(OUT, 'standalone-results.png') });

  // 换一个一定能被 Fetch 抓取的站点，验证全文阅读（先用 api-docs 文档页）
  await page.fill('#results-q', 'site:api-docs.deepseek.com 网页搜索与抓取');
  await page.press('#results-q', 'Enter');
  await page.waitForSelector('.result', { timeout: 45000 });
  await page.waitForTimeout(400);

  // 阅读器（Fetch API 直连）
  await page.locator('.result').first().locator('[data-action="read"]').click();
  await page.waitForSelector('.reader-body .md-article, .reader-error', { timeout: 60000 });
  await page.waitForTimeout(400);
  report.checks.readerArticle = await page.locator('.reader-body .md-article').count();
  report.checks.readerTextLen = (await page.locator('.reader-body').innerText()).length;
  report.checks.readerError = await page.locator('.reader-error').count();
  if (report.checks.readerError) {
    report.checks.readerErrorText = (await page.locator('.reader-error').innerText()).replace(/\s+/g, ' ').trim();
  }
  await page.screenshot({ path: path.join(OUT, 'standalone-reader.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // 设置：来源应为“构建时嵌入的密钥”，提示为浏览器本地
  await page.click('#settings-open');
  await page.waitForTimeout(400);
  report.checks.keyStatus = (await page.locator('#key-status').innerText()).replace(/\s+/g, ' ').trim();
  report.checks.keyHint = (await page.locator('#key-hint').innerText()).replace(/\s+/g, ' ').trim();
  report.checks.about = (await page.locator('#about-info').innerText()).trim();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // 前进 / 后退（hash 历史）
  const searchHash = await page.evaluate(() => location.hash);
  await page.goBack();
  await page.waitForTimeout(800);
  report.checks.backHash = await page.evaluate(() => location.hash);
  report.checks.backChanged = report.checks.backHash !== searchHash;
  await page.goForward();
  await page.waitForTimeout(1200);
  report.checks.forwardHash = await page.evaluate(() => location.hash);
  report.checks.forwardRestored = report.checks.forwardHash === searchHash;
  await page.waitForSelector('.result', { timeout: 45000 }).catch(() => {});

  // 刷新后仍能从 hash 还原搜索
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.result', { timeout: 45000 });
  await page.waitForTimeout(400);
  report.checks.reloadHash = await page.evaluate(() => location.hash);
  report.checks.reloadResults = await page.locator('.result').count();

  await context.close();

  /* ============ 2. 无 Key 版本 ============ */
  const noKeyContext = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
    colorScheme: 'light',
    locale: 'zh-CN',
  });
  const noKeyPage = await noKeyContext.newPage();
  watch(noKeyPage);
  await noKeyPage.goto(pathToFileURL(GENERIC).href, { waitUntil: 'domcontentloaded' });
  await noKeyPage.waitForSelector('#home-view:not([hidden])', { timeout: 15000 });
  await noKeyPage.waitForTimeout(500);

  report.checks.noKeyBanner = await noKeyPage.locator('#home-status').isVisible();
  await noKeyPage.screenshot({ path: path.join(OUT, 'standalone-no-key.png') });

  await noKeyPage.fill('#home-q', 'DeepSeek');
  await noKeyPage.press('#home-q', 'Enter');
  await noKeyPage.waitForSelector('#result-list .state-card', { timeout: 15000 });
  report.checks.noKeyError = (await noKeyPage.locator('#result-list .state-card h2').innerText()).trim();

  // 粘贴真实 Key -> 保存 -> 搜索成功（验证设置面板在单文件版的完整链路）
  if (localKey) {
    await noKeyPage.locator('#result-list [data-action="open-settings"]').click();
    await noKeyPage.waitForTimeout(300);
    await noKeyPage.fill('#api-key-input', localKey);
    await noKeyPage.click('#api-key-save');
    await noKeyPage.waitForTimeout(800);
    const keyStatus = (await noKeyPage.locator('#key-status').innerText()).replace(/\s+/g, ' ').trim();
    report.checks.noKeySaved = keyStatus.includes('已配置') && keyStatus.includes('浏览器本地');
    await noKeyPage.keyboard.press('Escape');
    await noKeyPage.waitForTimeout(300);
    // 保存成功后 app 会自动重试刚才失败的搜索，直接等结果即可
    await noKeyPage.waitForSelector('.result', { timeout: 45000 });
    report.checks.noKeySearchAfterSave = await noKeyPage.locator('.result').count();
    report.checks.keyPersisted = await noKeyPage.evaluate(
      () => Boolean(localStorage.getItem('dss.standalone.apiKey.v1')),
    );
  } else {
    report.checks.noKeySaved = 'skipped (no local key)';
  }

  await noKeyContext.close();

  /* ============ 3. 截图专用：用假 Key，避免把真实 Key 掩码写进仓库截图 ============ */
  const demoContext = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
    colorScheme: 'light',
    locale: 'zh-CN',
  });
  await demoContext.addInitScript(() => {
    try {
      localStorage.setItem('dss.standalone.apiKey.v1', 'sk-demo-0123456789abcdef');
    } catch {
      /* 忽略 */
    }
  });
  const demoPage = await demoContext.newPage();
  await demoPage.goto(pathToFileURL(GENERIC).href, { waitUntil: 'domcontentloaded' });
  await demoPage.waitForSelector('#home-view:not([hidden])', { timeout: 15000 });
  await demoPage.waitForTimeout(500);
  await demoPage.locator('.home-corner [data-action="open-settings"]').click();
  await demoPage.waitForTimeout(400);
  report.checks.demoKeyStatus = (await demoPage.locator('#key-status').innerText()).replace(/\s+/g, ' ').trim();
  await demoPage.screenshot({ path: path.join(OUT, 'standalone-settings.png') });
  await demoContext.close();

  /* ============ 4. localStorage 被禁用时页面仍可用 ============ */
  const blockedContext = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
    colorScheme: 'light',
    locale: 'zh-CN',
  });
  await blockedContext.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('localStorage disabled', 'SecurityError');
      },
    });
  });
  const blockedPage = await blockedContext.newPage();
  watch(blockedPage);
  await blockedPage.goto(pathToFileURL(GENERIC).href, { waitUntil: 'domcontentloaded' });
  await blockedPage.waitForSelector('#home-view:not([hidden])', { timeout: 15000 });
  await blockedPage.waitForTimeout(800);
  report.checks.blockedStorageHome = await blockedPage.locator('#home-view').isVisible();
  report.checks.blockedStorageBanner = await blockedPage.locator('#home-status').isVisible();
  report.checks.blockedStorageFooter = (await blockedPage.locator('#footer-status').innerText()).trim();
  await blockedContext.close();
} catch (error) {
  report.fatal = `${error.message}\n${error.stack || ''}`;
} finally {
  report.errors = [...new Set(report.errors)].slice(0, 10);
  report.pageErrors = [...new Set(report.pageErrors)].slice(0, 10);
  report.localhostRequests = report.requests.filter((host) => host === '127.0.0.1' || host === 'localhost').length;
  delete report.requests;

  const c = report.checks;
  check(!report.fatal, `fatal: ${report.fatal || ''}`);
  check(report.errors.length === 0, `console errors: ${JSON.stringify(report.errors)}`);
  check(report.pageErrors.length === 0, `page errors: ${JSON.stringify(report.pageErrors)}`);
  check(c.personalProtocol === 'file:', '单文件版未通过 file:// 打开');
  check(c.homeVisible === true, '首页未渲染');
  check(String(c.footerMode || '').includes('单文件版'), '页脚未显示单文件版模式');
  check(c.configuredHiddenBanner === true, '内嵌 Key 时仍显示未配置横幅');
  check(c.results >= 1, `搜索结果为空：${c.results}`);
  check(String(c.hashUrl || '').startsWith('#/search'), `hash 路由不正确：${c.hashUrl}`);
  check(c.readerArticle === 1 && c.readerError === 0, '全文阅读器失败');
  check(String(c.keyStatus || '').includes('构建时嵌入的密钥'), '设置页未显示嵌入 Key 来源');
  check(c.backChanged === true && c.forwardRestored === true, 'hash 前进/后退未恢复');
  check(c.reloadResults >= 1 && String(c.reloadHash || '').includes('/search?'), '刷新后未恢复搜索');
  check(c.hasLocalhostRequest === false && report.localhostRequests === 0, '单文件版请求了本地服务');
  check(c.noKeyBanner === true, '通用版未显示未配置横幅');
  check(String(c.noKeyError || '').includes('API Key'), '通用版无 Key 搜索未提示配置');
  if (localKey) {
    check(c.noKeySaved === true, '通用版保存 Key 失败');
    check(c.noKeySearchAfterSave >= 1, '通用版保存 Key 后自动重试失败');
    check(c.keyPersisted === true, '通用版 Key 未持久化');
  }
  check(c.blockedStorageHome === true && c.blockedStorageBanner === true, '禁用 localStorage 后页面未正常渲染');
  check(String(c.blockedStorageFooter || '').includes('单文件版'), '禁用 localStorage 后页脚状态未更新');
  check(String(c.demoKeyStatus || '').includes('已配置'), '截图用假 Key 设置页异常');

  report.failures = failures;
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) {
    console.error(`\nE2E 失败：${failures.length} 项检查未通过`);
    for (const failure of failures) console.error(` - ${failure}`);
    process.exitCode = 1;
  }
  await browser.close();
}
