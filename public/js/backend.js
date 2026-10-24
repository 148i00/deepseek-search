/**
 * 选择后端：本地 Node 服务版（/api/*）或单文件版浏览器直连。
 * 单文件构建会提前注入 window.__DSS_STANDALONE__ = true。
 */
import { createDirectBackend } from './backend-direct.js';
import { createServerBackend } from './backend-server.js';

export function createBackend() {
  const standalone =
    typeof window !== 'undefined' && Boolean(window.__DSS_STANDALONE__);
  return standalone ? createDirectBackend() : createServerBackend();
}
