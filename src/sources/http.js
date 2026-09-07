'use strict';

// Shared HTTP client for football sources.
// Features:
//   • Per-domain rate limiting (token bucket)
//   • Retries with exponential backoff
//   • Simple in-memory TTL cache
//   • AbortSignal-based timeouts

const log = require('../lib/logger');

const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_RETRIES = 2;

// token buckets per host (rough): requests per second budget
const HOST_BUDGET = {
  'v3.football.api-sports.io': 5,
  'api.football-data.org': 8,
  'api.the-odds-api.com': 4,
  'worldcup26.ir': 5,
  'sportscore.com': 4,
  'raw.githubusercontent.com': 8,
  'football-data.org': 8,
  'default': 4,
};

const buckets = new Map(); // host -> { tokens, last, capacity, refillPerSec }

function bucket(host) {
  let b = buckets.get(host);
  if (!b) {
    const cap = HOST_BUDGET[host] || HOST_BUDGET.default;
    b = { tokens: cap, last: Date.now(), capacity: cap, refillPerSec: cap };
    buckets.set(host, b);
  }
  return b;
}

async function takeToken(host) {
  const b = bucket(host);
  while (b.tokens < 1) {
    const now = Date.now();
    const dt = (now - b.last) / 1000;
    b.tokens = Math.min(b.capacity, b.tokens + dt * b.refillPerSec);
    b.last = now;
    if (b.tokens < 1) {
      const wait = ((1 - b.tokens) / b.refillPerSec) * 1000;
      await new Promise(r => setTimeout(r, Math.max(20, wait)));
    }
  }
  b.tokens -= 1;
  b.last = Date.now();
}

// Cache
const cache = new Map(); // key -> { value, ts }
const CACHE_TTL_MS = {
  fixtures_today: 5 * 60 * 1000,       // 5 min
  fixtures_upcoming: 15 * 60 * 1000,    // 15 min
  standings: 60 * 60 * 1000,            // 1h
  h2h: 24 * 60 * 60 * 1000,             // 1 day
  form: 30 * 60 * 1000,                  // 30 min
  odds: 10 * 60 * 1000,                  // 10 min
};

function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > (CACHE_TTL_MS[key] || 5 * 60 * 1000)) {
    cache.delete(key);
    return null;
  }
  return e.value;
}

function cacheSet(key, value) {
  cache.set(key, { value, ts: Date.now() });
}

function cacheClear() { cache.clear(); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function httpGet(url, opts = {}) {
  const u = new URL(url);
  const host = u.host;
  const headers = opts.headers || {};
  const timeout = opts.timeout || DEFAULT_TIMEOUT_MS;
  const retries = opts.retries != null ? opts.retries : DEFAULT_RETRIES;
  const useCache = opts.cache !== false;
  const cacheKey = opts.cacheKey || (opts.cacheBucket ? `${opts.cacheBucket}:${url}` : null);

  if (useCache && cacheKey) {
    const c = cacheGet(cacheKey);
    if (c !== null) return c;
  }

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await takeToken(host);
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeout);
      const res = await fetch(url, { headers, signal: ctrl.signal });
      clearTimeout(t);
      if (res.status === 429 || res.status === 403) {
        const ra = parseInt(res.headers.get('retry-after') || '0', 10);
        const wait = (isFinite(ra) && ra > 0 ? ra : 1) * 1000 * Math.pow(2, attempt);
        log.warn(`http.${host}.${res.status}`, { url, attempt, waitMs: wait });
        await sleep(Math.min(wait, 15000));
        continue;
      }
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status} from ${host}`);
        log.warn(`http.${host}.${res.status}`, { url, attempt });
        await sleep(500 * Math.pow(2, attempt));
        continue;
      }
      const ct = res.headers.get('content-type') || '';
      const value = ct.includes('application/json') ? await res.json() : await res.text();
      if (useCache && cacheKey) cacheSet(cacheKey, value);
      return value;
    } catch (e) {
      lastErr = e;
      log.warn(`http.${host}.error`, { url, attempt, err: e.message });
      await sleep(500 * Math.pow(2, attempt));
    }
  }
  throw lastErr || new Error(`httpGet(${url}) failed`);
}

module.exports = { httpGet, cacheGet, cacheSet, cacheClear, sleep };
