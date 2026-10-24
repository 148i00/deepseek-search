import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildHtml,
  buildStandalone,
  bundleFrontend,
  PROJECT_ROOT,
  renderStandaloneHtml,
} from '../scripts/build-standalone.mjs';

test('bundleFrontend：打包 11 个模块、无 import/export 残留、语法可编译', () => {
  const { code, modules } = bundleFrontend();
  assert.equal(modules.length, 11);
  assert.ok(modules.includes('app.js'));
  assert.ok(modules.includes('backend-direct.js'));
  assert.ok(modules.includes('deepseek-client.js'));
  assert.ok(!/^\s*(?:import|export)\b/m.test(code), 'bundle 中不应有 import/export');
  assert.ok(code.includes('function createBackend('));
  assert.ok(code.includes('function renderMarkdown('));
  assert.doesNotThrow(() => new Function(code));
});

test('buildHtml：自包含、无外部引用、CSP/单文件标记/版本齐全', () => {
  const { html, version } = buildHtml();
  assert.equal(version, '1.0.0');
  assert.ok(html.includes('Content-Security-Policy'));
  assert.ok(html.includes('__DSS_STANDALONE__ = true'));
  assert.ok(html.includes('connect-src https://api.deepseek.com'));
  assert.ok(html.includes('<style>'));
  assert.ok(!html.includes('<script type="module"'));
  assert.ok(!html.includes('src="/js/'));
  assert.ok(!html.includes('href="/styles.css"'));
  assert.ok(!html.includes('href="/favicon.svg"'));
  assert.ok(html.includes('href="#/"'));
  assert.ok(html.includes('data:image/svg+xml;base64,'));
  assert.ok(!html.includes('window.__DSS_EMBEDDED_KEY__ ='), '默认构建不应注入嵌入 Key');
});

test('buildHtml：embedKey 只在需要时注入', () => {
  const fakeKey = 'sk-buildtest-1234567890';
  const { html } = buildHtml({ embeddedKey: fakeKey });
  assert.ok(html.includes('__DSS_EMBEDDED_KEY__'));
  assert.ok(html.includes(JSON.stringify(fakeKey)));
});

test('buildHtml：恶意 version / key 不会提前闭合 script 标签', () => {
  const marker = '</script><script>alert(1)</script>';
  const { html } = buildHtml({ version: marker, embeddedKey: marker });
  assert.ok(!html.includes(marker), 'boot 脚本中的 </script 必须被转义');
  assert.ok(html.includes('<\\/script><script>alert(1)<\\/script>'));
});

test('bundle 输出确定性（同样输入两次结果一致）', () => {
  assert.equal(bundleFrontend().code, bundleFrontend().code);
});

test('buildStandalone：非法 Key 拒绝构建；合法 Key 生成 personal 文件', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dss-build-'));
  try {
    assert.throws(
      () =>
        buildStandalone({
          embedKey: true,
          key: 'not-a-key',
          outFile: path.join(tmpDir, 'bad.html'),
          quiet: true,
        }),
      /API Key 格式不正确/,
    );
    assert.equal(fs.existsSync(path.join(tmpDir, 'bad.html')), false);

    const result = buildStandalone({
      embedKey: true,
      key: 'sk-buildtest-1234567890',
      outFile: path.join(tmpDir, 'personal.html'),
      quiet: true,
    });
    assert.equal(result.outFile, path.join(tmpDir, 'personal.html'));
    assert.ok(fs.existsSync(result.outFile));
    const html = fs.readFileSync(result.outFile, 'utf8');
    assert.ok(html.includes('sk-buildtest-1234567890'));
    assert.ok(html.includes('__DSS_STANDALONE__ = true'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('renderStandaloneHtml：缺少替换点会显式报错', () => {
  assert.throws(
    () =>
      renderStandaloneHtml({
        indexHtml: '<html><head></head><body></body></html>',
        css: '',
        themeBoot: '',
        bundle: 'console.log(1)',
        faviconSvg: '<svg></svg>',
      }),
    /模板中找不到替换点/,
  );
});

test('PROJECT_ROOT 指向项目根目录', () => {
  assert.ok(fs.existsSync(path.join(PROJECT_ROOT, 'package.json')));
  assert.ok(fs.existsSync(path.join(PROJECT_ROOT, 'public', 'index.html')));
});
