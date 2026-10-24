/** 极简 TTL + LRU 缓存，用于避免重复计费的 Search / Fetch 请求。 */
export class TTLCache {
  #map = new Map();
  #ttlMs;
  #max;
  stats = { hits: 0, misses: 0, evictions: 0 };

  constructor({ ttlMs = 5 * 60_000, max = 200 } = {}) {
    this.#ttlMs = ttlMs;
    this.#max = Math.max(1, max);
  }

  get(key) {
    const entry = this.#map.get(key);
    if (!entry) {
      this.stats.misses += 1;
      return null;
    }
    const ageMs = Date.now() - entry.at;
    if (ageMs > entry.ttlMs) {
      this.#map.delete(key);
      this.stats.misses += 1;
      return null;
    }
    // 触碰即刷新 LRU 顺序
    this.#map.delete(key);
    this.#map.set(key, entry);
    this.stats.hits += 1;
    return { value: entry.value, ageMs };
  }

  set(key, value, ttlMs = this.#ttlMs) {
    if (this.#map.has(key)) this.#map.delete(key);
    this.#map.set(key, { value, at: Date.now(), ttlMs });
    while (this.#map.size > this.#max) {
      const oldest = this.#map.keys().next().value;
      this.#map.delete(oldest);
      this.stats.evictions += 1;
    }
    return value;
  }

  delete(key) {
    return this.#map.delete(key);
  }

  clear() {
    this.#map.clear();
  }

  get size() {
    return this.#map.size;
  }
}
