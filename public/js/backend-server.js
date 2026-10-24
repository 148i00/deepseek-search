/**
 * 服务版后端：把前端请求转发给本地 Node 服务的 /api/*。
 * 与 backend-direct.js 保持同样的 request(path, body, {method, signal}) 契约。
 */

function makeError(message, { code = 'network_error', status = 0, retryable = false } = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.retryable = retryable;
  return error;
}

export function createServerBackend() {
  return {
    mode: 'server',
    async request(path, body, { method, signal } = {}) {
      const options = { method: method || (body === undefined ? 'GET' : 'POST'), headers: {} };
      if (signal) options.signal = signal;
      if (body !== undefined) {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
      }

      let response;
      try {
        response = await fetch(path, options);
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        throw makeError('无法连接本地服务，请确认服务正在运行。');
      }

      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }

      if (!response.ok) {
        const detail = data && data.error ? data.error : {};
        throw makeError(detail.message || `请求失败（HTTP ${response.status}）`, {
          code: detail.code || `http_${response.status}`,
          status: response.status,
          retryable: Boolean(detail.retryable),
        });
      }
      return data;
    },
  };
}
