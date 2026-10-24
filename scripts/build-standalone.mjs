#!/usr/bin/env node
/**
 * 单文件版构建器（零依赖）。
 *
 *   node scripts/build-standalone.mjs                  # dist/deepseek-search.html（不含 Key）
 *   node scripts/build-standalone.mjs --embed-key      # dist/deepseek-search-personal.html（内嵌本机 Key）
 *   node scripts/build-standalone.mjs --out xxx.html   # 自定义输出
 *
 * 产物是一个自包含 HTML：内联 CSS / JS / favicon，双击通过 file:// 打开即可直连
 * DeepSeek API 搜索，无需启动本地服务。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readDshKey } from '../src/config.mjs';
import { maskKey, validateApiKey } from '../public/js/key-utils.js';

export const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const MODULES_DIR = path.join(PUBLIC_DIR, 'js');

const CSP = [
  "default-src 'none'",
  "img-src https: data:",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  'connect-src https://api.deepseek.com',
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const IMPORT_RE = /^import\s+[\s\S]*?from\s+['"]([^'"]+)['"]\s*;?/gm;
const DECL_RE = /^(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;

function escapeScriptContent(value) {
  return String(value).replace(/<\/script/gi, '<\\/script');
}

function escapeStyleContent(value) {
  return String(value).replace(/<\/style/gi, '<\\/style');
}

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

/**
 * 按静态 import 依赖递归收集模块（后序：依赖在前）。
 */
export function collectModules(entry = 'app.js', modulesDir = MODULES_DIR) {
  const order = [];
  const seen = new Set();
  const stack = new Set();

  function visit(file) {
    if (seen.has(file)) return;
    if (stack.has(file)) {
      throw new Error(`检测到循环依赖：${path.relative(modulesDir, file)}`);
    }
    stack.add(file);
    const source = readText(file);

    IMPORT_RE.lastIndex = 0;
    let match;
    while ((match = IMPORT_RE.exec(source)) !== null) {
      const spec = match[1];
      if (!spec.startsWith('.')) {
        throw new Error(`不支持非相对模块导入：${spec}（${path.basename(file)}）`);
      }
      const resolved = path.resolve(path.dirname(file), spec);
      if (!resolved.startsWith(modulesDir + path.sep)) {
        throw new Error(`模块越界：${spec}（${path.basename(file)}）`);
      }
      if (!fs.existsSync(resolved)) throw new Error(`找不到模块：${spec}`);
      visit(resolved);
    }

    stack.delete(file);
    seen.add(file);
    order.push({ file, source });
  }

  visit(path.join(modulesDir, entry));
  return order;
}

function stripModuleSyntax(source, file) {
  const withoutImports = source.replace(IMPORT_RE, '');
  const withoutExports = withoutImports
    .replace(/^export\s*\{[^}]*\}\s*;?/gm, '')
    .replace(/^export\s+/gm, '');

  if (/^\s*(?:import|export)\b/m.test(withoutExports)) {
    throw new Error(`模块中仍有未处理的 import/export：${path.basename(file)}`);
  }
  return withoutExports.trim();
}

function collectDeclarations(source) {
  const names = [];
  DECL_RE.lastIndex = 0;
  let match;
  while ((match = DECL_RE.exec(source)) !== null) names.push(match[1]);
  return names;
}

/**
 * 把前端 ES Module 打包成单个经典脚本（IIFE）。
 * @returns {{code: string, modules: string[]}}
 */
export function bundleFrontend({ modulesDir = MODULES_DIR } = {}) {
  const modules = collectModules('app.js', modulesDir);
  const seenNames = new Map();
  const parts = [];

  for (const { file, source } of modules) {
    const name = path.basename(file);
    const declarations = collectDeclarations(source);
    for (const declaration of declarations) {
      if (seenNames.has(declaration)) {
        throw new Error(
          `顶层标识符重复：${declaration}（${seenNames.get(declaration)} 与 ${name}），无法安全打包`,
        );
      }
      seenNames.set(declaration, name);
    }
    parts.push(`// ---- ${name} ----\n${stripModuleSyntax(source, file)}`);
  }

  const code = `(function () {\n'use strict';\n${parts.join('\n\n')}\n})();\n`;
  try {
    // 只做语法编译，不执行（执行需要浏览器 DOM）
    new Function(code);
  } catch (error) {
    throw new Error(`打包结果语法错误：${error.message}`);
  }
  return { code, modules: modules.map(({ file }) => path.basename(file)) };
}

function replaceOnce(haystack, needle, replacement, label) {
  const index = haystack.indexOf(needle);
  if (index === -1) throw new Error(`模板中找不到替换点：${label}`);
  if (haystack.indexOf(needle, index + needle.length) !== -1) {
    throw new Error(`模板替换点出现多次：${label}`);
  }
  return haystack.slice(0, index) + replacement + haystack.slice(index + needle.length);
}

/**
 * 渲染自包含 HTML。
 */
export function renderStandaloneHtml({
  indexHtml,
  css,
  themeBoot,
  bundle,
  faviconSvg,
  version = '1.0.0',
  embeddedKey = '',
} = {}) {
  if (!indexHtml) throw new Error('缺少 index.html 模板');
  if (!bundle) throw new Error('缺少前端 bundle');

  const faviconData = `data:image/svg+xml;base64,${Buffer.from(faviconSvg, 'utf8').toString('base64')}`;
  const bootLines = [
    'window.__DSS_STANDALONE__ = true;',
    `window.__DSS_VERSION__ = ${escapeScriptContent(JSON.stringify(version))};`,
  ];
  if (embeddedKey) {
    bootLines.push(`window.__DSS_EMBEDDED_KEY__ = ${escapeScriptContent(JSON.stringify(embeddedKey))};`);
  }
  const bootScript = `<script>${bootLines.join(' ')}</script>`;
  const appScript = `<script>${escapeScriptContent(bundle)}</script>`;
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`;

  let html = indexHtml;
  html = replaceOnce(html, '<meta charset="utf-8" />', `<meta charset="utf-8" />\n  ${cspMeta}`, 'charset meta');
  html = replaceOnce(
    html,
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml" />',
    `<link rel="icon" href="${faviconData}" type="image/svg+xml" />`,
    'favicon',
  );
  html = replaceOnce(
    html,
    '<link rel="stylesheet" href="/styles.css" />',
    `<style>\n${escapeStyleContent(css)}\n</style>`,
    'stylesheet',
  );
  html = replaceOnce(
    html,
    '<script src="/js/theme-boot.js"></script>',
    `<script>${escapeScriptContent(themeBoot)}</script>`,
    'theme boot',
  );
  html = replaceOnce(
    html,
    '<script type="module" src="/js/app.js"></script>',
    `${bootScript}\n  ${appScript}`,
    'app module',
  );
  html = replaceOnce(
    html,
    '<a class="brand brand--small" href="/" aria-label="DeepSeek 搜索首页">',
    '<a class="brand brand--small" href="#/" aria-label="DeepSeek 搜索首页">',
    'brand home link',
  );

  const leftovers = [
    ['<script type="module"', '仍存在 ES module 脚本'],
    ['src="/js/', '仍存在绝对 JS 引用'],
    ['href="/styles.css"', '仍存在绝对样式引用'],
    ['href="/favicon.svg"', '仍存在绝对 favicon 引用'],
    ['<a class="brand brand--small" href="/"', '品牌首页链接仍是绝对路径'],
  ];
  for (const [needle, message] of leftovers) {
    if (html.includes(needle)) throw new Error(`构建产物校验失败：${message}`);
  }
  if (!html.includes('__DSS_STANDALONE__')) throw new Error('构建产物缺少单文件标记');

  return html;
}

/**
 * 读取构建所需资源并生成 HTML 字符串（不写盘，便于测试）。
 */
export function buildHtml({ root = PROJECT_ROOT, version, embeddedKey = '' } = {}) {
  const publicDir = path.join(root, 'public');
  const modulesDir = path.join(publicDir, 'js');

  const packageJson = JSON.parse(readText(path.join(root, 'package.json')));
  const resolvedVersion = version || packageJson.version || '1.0.0';
  const indexHtml = readText(path.join(publicDir, 'index.html'));
  const css = readText(path.join(publicDir, 'styles.css'));
  const themeBoot = readText(path.join(modulesDir, 'theme-boot.js'));
  const faviconSvg = readText(path.join(publicDir, 'favicon.svg'));
  const bundle = bundleFrontend({ modulesDir });

  return {
    html: renderStandaloneHtml({
      indexHtml,
      css,
      themeBoot,
      bundle: bundle.code,
      faviconSvg,
      version: resolvedVersion,
      embeddedKey,
    }),
    modules: bundle.modules,
    version: resolvedVersion,
  };
}

function resolveEmbeddedKey(explicitKey) {
  if (explicitKey) return explicitKey.trim();
  const envKey = (process.env.DEEPSEEK_API_KEY || '').trim();
  if (envKey) return envKey;
  const dshKey = readDshKey();
  return dshKey || '';
}

/**
 * 构建并写盘。
 */
export function buildStandalone({
  root = PROJECT_ROOT,
  embedKey = false,
  outFile,
  quiet = false,
  key,
} = {}) {
  let embeddedKey = '';
  if (embedKey) {
    const candidate = resolveEmbeddedKey(key);
    if (!candidate) {
      throw new Error(
        '未找到可嵌入的 API Key：请设置 DEEPSEEK_API_KEY、确保 ~/.dsh/.credentials.yaml 中存在 DEEPSEEK_API_KEY，或不要使用 --embed-key。',
      );
    }
    const check = validateApiKey(candidate);
    if (!check.ok) throw new Error(`API Key 格式不正确：${check.message}`);
    embeddedKey = check.key;
  }

  const { html, modules, version } = buildHtml({ root, embeddedKey });
  const target = outFile
    ? path.resolve(outFile)
    : path.join(
        root,
        'dist',
        embeddedKey ? 'deepseek-search-personal.html' : 'deepseek-search.html',
      );

  fs.mkdirSync(path.dirname(target), { recursive: true });
  // personal 版本等同于密钥文件：Unix 下收紧为 0600（Windows 的 ACL 由用户目录权限决定）。
  fs.writeFileSync(target, html, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    /* Windows / 不支持 chmod 的文件系统 */
  }

  const sizeKb = (Buffer.byteLength(html) / 1024).toFixed(1);
  if (!quiet) {
    console.log(`✓ 单文件版已生成：${target}`);
    console.log(`  大小 ${sizeKb} KB · 版本 ${version} · 内联模块 ${modules.length} 个`);
    if (embeddedKey) {
      console.log(`  ⚠ 已嵌入 API Key（${maskKey(embeddedKey)}）：该 HTML 等同于密钥文件，请勿分享或提交到仓库。`);
    } else {
      console.log('  不含 API Key：首次打开时在页面设置里粘贴即可（保存在浏览器本地）。');
    }
  }

  return { outFile: target, bytes: Buffer.byteLength(html), modules, version, embeddedKey };
}

function parseArgs(argv) {
  const args = { embedKey: false, outFile: null, quiet: false, key: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--embed-key') args.embedKey = true;
    else if (arg === '--quiet') args.quiet = true;
    else if (arg === '--out') {
      args.outFile = argv[i + 1];
      i += 1;
    } else if (arg === '--key') {
      args.key = argv[i + 1] || '';
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log('用法：node scripts/build-standalone.mjs [--embed-key] [--out <file>] [--quiet]');
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return args;
}

const isMain = (() => {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    buildStandalone(args);
  } catch (error) {
    console.error(`✘ 构建失败：${error.message}`);
    process.exitCode = 1;
  }
}
