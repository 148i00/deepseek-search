import test from 'node:test';
import assert from 'node:assert/strict';
import { postJson } from '../public/js/deepseek-client.js';

const API_KEY = 'sk-test-1234567890';

function hangingFetch(counter) {
  return (url, options = {}) =>
    new Promise((resolve, reject) => {
      counter.calls += 1;
      const signal = options.signal;
      if (!signal) return; // 不应发生：postJson 总是传入内部 controller.signal
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      signal.addEventListener(
        'abort',
        () => reject(new DOMException('Aborted', 'AbortError')),
        { once: true },
      );
    });
}

test('调用方在请求前取消：不发起任何请求', async () => {
  const counter = { calls: 0 };
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () =>
      postJson(
        '/v1/tools/search',
        { query: 'DeepSeek', count: 1 },
        {
          apiKey: API_KEY,
          fetchImpl: hangingFetch(counter),
          retries: 1,
          signal: controller.signal,
        },
      ),
    (error) => error.name === 'AbortError' && error.code === 'aborted',
  );
  assert.equal(counter.calls, 0);
});

test('调用方在请求中取消：不重试，只调用一次上游', async () => {
  const counter = { calls: 0 };
  const controller = new AbortController();

  const pending = postJson(
    '/v1/tools/search',
    { query: 'DeepSeek', count: 1 },
    {
      apiKey: API_KEY,
      fetchImpl: hangingFetch(counter),
      retries: 1,
      signal: controller.signal,
    },
  );
  setTimeout(() => controller.abort(), 20);

  await assert.rejects(pending, (error) => error.name === 'AbortError' && error.code === 'aborted');
  assert.equal(counter.calls, 1, '主动取消不应触发重试/重复计费');
});

test('真正的超时仍按 retries 重试一次', async () => {
  const counter = { calls: 0 };
  const error = await postJson(
    '/v1/tools/search',
    { query: 'DeepSeek', count: 1 },
    {
      apiKey: API_KEY,
      fetchImpl: hangingFetch(counter),
      timeoutMs: 5,
      retries: 1,
    },
  ).catch((err) => err);

  assert.equal(counter.calls, 2);
  assert.equal(error.code, 'timeout');
  assert.equal(error.retryable, true);
});
