/**
 * 配置与密钥管理。
 *
 * 密钥解析优先级：
 *   1. data/config.json        （在网页「设置」里保存的密钥，用户显式覆盖）
 *   2. 环境变量 DEEPSEEK_API_KEY
 *   3. DSH 凭据文件 ~/.dsh/.credentials.yaml 的 refs.DEEPSEEK_API_KEY（只读兜底）
 *
 * 密钥永远不会被发送到浏览器：/api/status 只返回来源与掩码。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isValidApiKey, maskKey, validateApiKey } from '../public/js/key-utils.js';

export { maskKey, validateApiKey };

export const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const DATA_DIR = process.env.DSH_SEARCH_DATA
  ? path.resolve(process.env.DSH_SEARCH_DATA)
  : path.join(PROJECT_ROOT, 'data');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

const DEFAULTS = Object.freeze({
  apiKey: '',
  defaultCount: 30,
  updatedAt: null,
});

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULTS,
      ...(parsed && typeof parsed === 'object' ? parsed : {}),
      apiKey: typeof parsed?.apiKey === 'string' ? parsed.apiKey : '',
      defaultCount: clampCount(parsed?.defaultCount),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function clampCount(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return DEFAULTS.defaultCount;
  return Math.min(50, Math.max(10, Math.round(v)));
}

export function writeConfig(patch) {
  ensureDataDir();
  const next = { ...readConfig(), ...patch, updatedAt: new Date().toISOString() };
  const tmp = `${CONFIG_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH);
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch {
    /* Windows 上 chmod 基本无效，忽略 */
  }
  return next;
}

/** 从 DSH 凭据文件里读只读兜底密钥。 */
export function readDshKey() {
  const file = path.join(os.homedir(), '.dsh', '.credentials.yaml');
  try {
    const text = fs.readFileSync(file, 'utf8');
    const m = text.match(/^\s*DEEPSEEK_API_KEY:\s*["']?([^\s"'#]+)["']?\s*$/m);
    if (m && isValidApiKey(m[1])) return m[1];
  } catch {
    /* 文件不存在或不可读 */
  }
  return null;
}

/**
 * @returns {{ key: string|null, source: 'settings'|'env'|'dsh'|'none' }}
 */
export function resolveApiKey(config = readConfig()) {
  if (config.apiKey && isValidApiKey(config.apiKey)) {
    return { key: config.apiKey, source: 'settings' };
  }
  const envKey = (process.env.DEEPSEEK_API_KEY || '').trim();
  if (envKey && isValidApiKey(envKey)) {
    return { key: envKey, source: 'env' };
  }
  const dshKey = readDshKey();
  if (dshKey) return { key: dshKey, source: 'dsh' };
  return { key: null, source: 'none' };
}

export const SOURCE_LABELS = Object.freeze({
  settings: '网页设置中保存的密钥',
  env: '环境变量 DEEPSEEK_API_KEY',
  dsh: 'DSH 凭据文件（~/.dsh/.credentials.yaml）',
  none: '未配置',
});
