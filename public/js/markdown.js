/**
 * 安全、零依赖的 Markdown 渲染器（用于全文阅读器）。
 *
 * 设计要点：
 *  1. 永远先转义 HTML —— 抓来的网页内容是不可信的，禁止原始 HTML 注入。
 *  2. DeepSeek Fetch 返回的正文会把 Markdown 标点转义（如 \#、\-、\|、\:），
 *     这里先还原这些转义，再按 Markdown 结构解析。
 *  3. 只放行 http/https 链接与图片；javascript: 等一律降级为文本。
 *  4. 识别被拍平的行内代码/命令块（缩进 + 代码起始行），用 <pre> 保留换行。
 */
import { escapeHtml, safeHttpUrl, smartJoin } from './util.js';

const MAX_INPUT = 600_000;
const PUNCT_ESCAPE_RE = /\\([\\`*_{}\[\]()#+\-.!>~|:;=$%^&,?'"/@<])/g;

const ENTITY_MAP = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };

/** 还原 escapeHtml 产生的实体（用于 URL 二次处理）。 */
function decodeHtmlEntities(value) {
  return String(value ?? '').replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => ENTITY_MAP[name] ?? _);
}

const BLOCK_START_RE = /^( {0,3}#{1,6}\s| {0,3}(`{3,}|~{3,})| {0,3}([-*+]|\d{1,3}[.)])\s+| {0,3}>| {0,3}((\*{3,})|(-{3,})|(_{3,}))\s*$)/;

/** 还原 DeepSeek Fetch 输出里的 Markdown 标点转义。 */
export function unescapeMarkdown(src) {
  return String(src ?? '').replace(PUNCT_ESCAPE_RE, '$1');
}

/** 去掉正文开头与标题重复的 H1/H2（允许正文前有横幅、日期等少量文字）。 */
export function stripDuplicateTitle(markdown, title) {
  const lines = String(markdown ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const normalize = (value) =>
    String(value || '')
      .replace(/[\s\p{P}\p{S}]/gu, '')
      .toLowerCase();
  const titleText = normalize(title);
  if (!titleText) return markdown;

  let index = 0;
  let nonEmptySeen = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    nonEmptySeen += 1;
    if (nonEmptySeen > 8) break;
    const heading = /^#{1,2}\s+(.+?)\s*#*\s*$/.exec(unescapeMarkdown(line).trim());
    if (heading) {
      const headingText = normalize(heading[1]);
      if (
        headingText &&
        (headingText === titleText || headingText.includes(titleText) || titleText.includes(headingText))
      ) {
        const before = lines.slice(0, index);
        let after = lines.slice(index + 1);
        if (after.length && !after[0].trim()) after = after.slice(1);
        return [...before, ...after].join('\n').replace(/^\s*\n/, '');
      }
      break; // 第一个标题都不是重复标题，就不再往下找
    }
    index += 1;
  }
  return markdown;
}

function renderInline(raw) {
  const store = [];
  const stash = (html) => {
    store.push(html);
    return `\u0000${store.length - 1}\u0000`;
  };
  const restore = (value) => value.replace(/\u0000(\d+)\u0000/g, (_, i) => store[Number(i)] ?? '');

  let text = String(raw ?? '');

  // 1. 反斜杠转义 → 占位符（保留字面字符，不参与后续语法）
  text = text.replace(/\\([\\`*_{}\[\]()#+\-.!>~|:;=$%^&,?'"/@<])/g, (_, ch) => stash(escapeHtml(ch)));
  // 2. HTML 转义，之后所有替换都基于安全文本
  text = escapeHtml(text);

  // 3. 行内代码
  text = text.replace(/`([^`\n]+?)`/g, (_, code) => stash(`<code>${code}</code>`));

  // 4. 图片（只允许 http/https）
  text = text.replace(
    /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+["']([^"']*)["'])?\s*\)/g,
    (whole, alt, url, title) => {
      const safe = safeHttpUrl(decodeHtmlEntities(url));
      if (!safe) return alt || '';
      const titleAttr = title ? ` title="${title}"` : '';
      return stash(
        `<img src="${escapeHtml(safe)}" alt="${alt}"${titleAttr} loading="lazy" decoding="async" referrerpolicy="no-referrer" />`,
      );
    },
  );

  // 5. 链接
  text = text.replace(
    /\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+["']([^"']*)["'])?\s*\)/g,
    (whole, label, url, title) => {
      const safe = safeHttpUrl(decodeHtmlEntities(url), { allowMailto: true });
      const inner = emphasize(label);
      if (!safe) return inner || label;
      const titleAttr = title ? ` title="${title}"` : '';
      return stash(
        `<a href="${escapeHtml(safe)}"${titleAttr} target="_blank" rel="noopener noreferrer">${inner || escapeHtml(safe)}</a>`,
      );
    },
  );

  // 6. 尖括号自动链接（此时 < 已被转义为 &lt;）
  text = text.replace(/&lt;((?:https?|mailto):[^\s]*?)&gt;/g, (whole, url) => {
    const decoded = decodeHtmlEntities(url);
    const safe = safeHttpUrl(decoded, { allowMailto: true });
    if (!safe) return whole;
    return stash(
      `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(decoded)}</a>`,
    );
  });

  // 7. 加粗 / 斜体 / 删除线
  text = emphasize(text);

  // 8. 恢复占位符
  text = restore(text);
  // 9. 软换行与 <br>
  return text.replace(/\u0001/g, '<br />');
}

/** 处理 **粗体**、__粗体__、*斜体*、_斜体_、~~删除线~~。 */
function emphasize(input) {
  let text = String(input ?? '');
  text = text.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__([^_\n]+?)__/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
  text = text.replace(/(^|[^_])_([^_\n]+?)_(?!_)/g, '$1<em>$2</em>');
  text = text.replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');
  return text;
}

function slugify(value, used) {
  const base =
    String(value || '')
      .trim()
      .toLowerCase()
      .replace(/<[^>]*>/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'section';
  let id = base;
  let counter = 2;
  while (used.has(id)) {
    id = `${base}-${counter}`;
    counter += 1;
  }
  used.add(id);
  return id;
}

function isTableSeparator(line) {
  const trimmed = String(line || '').trim().replace(/^\|/, '').replace(/\|$/, '').trim();
  if (!trimmed) return false;
  return trimmed.split('|').every((cell) => /^\s*:?-{2,}:?\s*$/.test(cell));
}

function splitTableRow(line) {
  let value = String(line || '').trim();
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|')) value = value.slice(0, -1);
  return value.split('|').map((cell) => cell.trim());
}

function tableAlign(cell) {
  const value = cell.trim();
  if (value.startsWith(':') && value.endsWith(':')) return 'center';
  if (value.endsWith(':')) return 'right';
  return 'left';
}

function tryTable(lines, start) {
  if (start + 1 >= lines.length) return null;
  const headerLine = lines[start];
  if (!headerLine.includes('|')) return null;
  if (!isTableSeparator(lines[start + 1])) return null;
  const headers = splitTableRow(headerLine);
  if (!headers.length) return null;
  const alignments = splitTableRow(lines[start + 1]).map(tableAlign);
  let i = start + 2;
  const rows = [];
  while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
    rows.push(splitTableRow(lines[i]));
    i += 1;
  }
  let html = '<div class="md-table-wrap"><table><thead><tr>';
  headers.forEach((cell, index) => {
    html += `<th class="md-align-${alignments[index] || 'left'}">${renderInline(cell)}</th>`;
  });
  html += '</tr></thead><tbody>';
  for (const row of rows) {
    html += '<tr>';
    for (let cellIndex = 0; cellIndex < headers.length; cellIndex += 1) {
      html += `<td class="md-align-${alignments[cellIndex] || 'left'}">${renderInline(row[cellIndex] ?? '')}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  return { html, next: i };
}

/** 段落是否像被拍平的代码块：有缩进行，或以常见代码开头。 */
function looksLikeCode(lines) {
  if (lines.length < 2) return false;
  const indented = lines.filter((line) => /^\s{2,}\S/.test(line)).length;
  if (indented === 0) return false;
  const first = lines[0].trim();
  const codeStart = /^(curl|wget|pip\d?\s|npm\s|pnpm\s|yarn\s|node\s|python\d?\s|import\s|from\s|def\s|class\s|function\s|const\s|let\s|var\s|function\s|\$ |GET\s|POST\s|PUT\s|DELETE\s|PATCH\s|\{|\}|<[a-z]+|\/\/|#include|package\s)/i.test(
    first,
  );
  const endsWithContinuation = /\\\s*$/.test(lines[0]);
  return codeStart || endsWithContinuation || indented >= Math.ceil(lines.length / 2);
}

function joinParagraph(lines) {
  let output = '';
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];
    const hardBreak = /( {2,}|\\)$/.test(line);
    line = line.replace(/ {2,}$/, '').replace(/\\$/, '');
    output = i === 0 ? line : smartJoin(output, line);
    if (hardBreak) output += '\u0001';
  }
  return output;
}

function isBlockStart(line) {
  return BLOCK_START_RE.test(line);
}

function renderBlocks(lines, ctx) {
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // 代码围栏
    const fence = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/.exec(line);
    if (fence) {
      const marker = fence[1][0];
      const length = fence[1].length;
      const lang = fence[2] || '';
      const closing = new RegExp(`^ {0,3}${marker === '`' ? '`' : '~'}{${length},}\\s*$`);
      i += 1;
      const codeLines = [];
      while (i < lines.length) {
        if (closing.test(lines[i])) {
          i += 1;
          break;
        }
        codeLines.push(lines[i]);
        i += 1;
      }
      html += `<pre class="md-code"${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}><code>${escapeHtml(
        codeLines.join('\n'),
      )}</code></pre>`;
      continue;
    }

    // 标题
    const heading = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const inner = renderInline(heading[2]);
      const id = slugify(heading[2], ctx.usedIds);
      html += `<h${level} id="${id}">${inner}</h${level}>`;
      i += 1;
      continue;
    }

    // 分隔线
    if (/^ {0,3}((\*{3,})|(-{3,})|(_{3,}))\s*$/.test(line)) {
      html += '<hr />';
      i += 1;
      continue;
    }

    // 引用
    if (/^ {0,3}>/.test(line)) {
      const inner = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
        inner.push(lines[i].replace(/^ {0,3}> ?/, ''));
        i += 1;
      }
      html += `<blockquote>${renderBlocks(inner, ctx)}</blockquote>`;
      continue;
    }

    // 列表
    if (/^\s*([-*+]|\d{1,3}[.)])\s+/.test(line)) {
      const result = parseList(lines, i, ctx);
      html += result.html;
      i = result.next;
      continue;
    }

    // 表格
    const table = tryTable(lines, i);
    if (table) {
      html += table.html;
      i = table.next;
      continue;
    }

    // 段落 / 被拍平的代码块
    const paragraph = [];
    while (i < lines.length) {
      const current = lines[i];
      if (!current.trim()) break;
      if (paragraph.length > 0 && isBlockStart(current)) break;
      paragraph.push(current);
      i += 1;
    }
    if (!paragraph.length) {
      i += 1;
      continue;
    }
    if (themeIsFlatCode(paragraph)) {
      html += `<pre class="md-code md-code--flat"><code>${escapeHtml(paragraph.join('\n'))}</code></pre>`;
    } else {
      html += `<p>${renderInline(joinParagraph(paragraph))}</p>`;
    }
  }
  return html;
}

function themeIsFlatCode(lines) {
  return lines.length >= 2 && looksLikeCode(lines);
}

function parseList(lines, start, ctx) {
  const entries = [];
  let i = start;
  let baseIndent = null;
  while (i < lines.length) {
    const line = lines[i];
    const match = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
    if (match) {
      const indent = match[1].replace(/\t/g, '  ').length;
      if (baseIndent === null) baseIndent = indent;
      if (indent < baseIndent) break;
      entries.push({ indent, ordered: /\d/.test(match[2]), text: match[3] });
      i += 1;
      continue;
    }
    if (!line.trim()) break;
    if (entries.length && /^\s{2,}\S/.test(line)) {
      entries[entries.length - 1].text += ` ${line.trim()}`;
      i += 1;
      continue;
    }
    break;
  }
  const [html] = buildList(entries, 0, baseIndent ?? 0);
  return { html, next: i };
}

function buildList(entries, index, indent) {
  const ordered = entries[index].ordered;
  let html = ordered ? '<ol>' : '<ul>';
  let i = index;
  while (i < entries.length && entries[i].indent >= indent) {
    if (entries[i].indent > indent) {
      i += 1;
      continue;
    }
    const entry = entries[i];
    i += 1;
    let inner = renderInline(entry.text);
    if (i < entries.length && entries[i].indent > indent) {
      const [childHtml, nextIndex] = buildList(entries, i, entries[i].indent);
      inner += childHtml;
      i = nextIndex;
    }
    html += `<li>${inner}</li>`;
  }
  html += ordered ? '</ol>' : '</ul>';
  return [html, i];
}

/**
 * 渲染 Markdown 为安全 HTML。
 * @param {string} markdown
 * @returns {string}
 */
export function renderMarkdown(markdown) {
  let source = String(markdown ?? '');
  if (source.length > MAX_INPUT) {
    source = `${source.slice(0, MAX_INPUT)}\n\n> 内容过长，已截断显示。`;
  }
  source = source.replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
  // DeepSeek Fetch 的正文是“转义后的 Markdown”，先还原标点转义再解析结构。
  source = unescapeMarkdown(source);
  const ctx = { usedIds: new Set() };
  const html = renderBlocks(source.split('\n'), ctx);
  return html || '<p class="md-empty">（没有可显示的正文）</p>';
}
