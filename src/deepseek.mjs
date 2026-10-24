/**
 * 兼容 shim：共享核心已迁移到 public/js/deepseek-client.js，
 * 以便服务端（Node）与单文件版（浏览器直连）复用同一份实现。
 */
export * from '../public/js/deepseek-client.js';
