/**
 * 密钥格式校验与掩码（浏览器 / Node 共用）。
 * 迁移自 src/config.mjs，供单文件版直连模式复用。
 */

const KEY_RE = /^sk-[A-Za-z0-9_-]{8,256}$/;

export function isValidApiKey(raw) {
  return typeof raw === 'string' && KEY_RE.test(raw.trim());
}

export function validateApiKey(raw) {
  if (typeof raw !== 'string') return { ok: false, message: '密钥必须是字符串' };
  const key = raw.trim();
  if (!key) return { ok: false, message: '密钥不能为空' };
  if (!KEY_RE.test(key)) {
    return { ok: false, message: '密钥格式不正确（应以 sk- 开头，仅含字母、数字、_ 和 -）' };
  }
  return { ok: true, key };
}

export function maskKey(key) {
  if (!key) return '';
  if (key.length <= 12) return key.slice(0, 3) + '***';
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}
