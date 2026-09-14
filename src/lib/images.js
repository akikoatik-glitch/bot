'use strict';

// Best-effort club-crest lookup for prediction posts.
//
// No API keys. For each team we ask Wikipedia's free MediaWiki API for the
// article's infobox image (usually the club crest) and download it as bytes
// ready to send to Telegram. If anything fails we return null and callers
// simply fall back to a text-only post.

const log = require('./logger');
const { httpGet } = require('../sources/http');

const mem = new Map(); // key -> { buffer, mime } | null

async function fetchBuffer(url, timeout = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const ct = res.headers.get('content-type') || 'image/jpeg';
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 200) throw new Error('image too small');
    return { buffer: buf, mime: ct.split(';')[0].trim() };
  } finally {
    clearTimeout(t);
  }
}

function rasterSource(pg, minWidth = 180) {
  if (!pg) return null;
  // Prefer the raster thumbnail (pageimages renders SVGs to PNG). Only fall
  // back to the original file when it is clearly a raster image (not .svg).
  const thumb = pg.thumbnail && pg.thumbnail.source
    && (minWidth == null || !pg.thumbnail.width || pg.thumbnail.width >= minWidth)
    ? pg.thumbnail.source : null;
  if (thumb) return thumb;
  const orig = pg.original && pg.original.source ? pg.original.source : null;
  if (orig && !/\.svg(\?|$)/i.test(orig)) return orig;
  return null;
}

async function wikiCrest(teamName) {
  const key = 'wiki:' + String(teamName || '').trim().toLowerCase();
  if (mem.has(key)) return mem.get(key);
  let crest = null;
  try {
    const title = encodeURIComponent(String(teamName || '').trim());
    const api = 'https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1'
      + '&prop=pageimages&piprop=thumbnail|original&pithumbsize=300&titles=' + title;
    const data = await httpGet(api, { cacheBucket: 'wiki', cacheKey: 'wiki:pi:' + String(teamName || '').trim(), timeout: 8000 });
    const pages = (data && data.query && data.query.pages) ? Object.values(data.query.pages) : [];
    const pg = pages[0];
    const realTitle = (pg && pg.title) || null;
    const src = rasterSource(pg);
    if (src) {
      crest = await fetchBuffer(src);
    } else if (realTitle) {
      // Fallback: REST summary endpoint — representative page image, broad coverage.
      const rest = await httpGet(
        'https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(realTitle.replace(/ /g, '_')),
        { cacheBucket: 'wiki', cacheKey: 'wiki:sum:' + realTitle, timeout: 8000 }
      );
      const srcB = (rest && rest.thumbnail && rest.thumbnail.source) || null;
      if (srcB && !/\.svg(\?|$)/i.test(srcB)) crest = await fetchBuffer(srcB);
    }
  } catch (e) {
    log.warn('images.wiki.failed', { team: teamName, err: e.message });
  }
  mem.set(key, crest);
  return crest;
}

// Returns [homeCrest, awayCrest]; each is { buffer, mime } or null.
// Optional cacheBust callback lets callers refuse the cache (unused for now).
async function getTeamCrests(teamNames) {
  const out = [];
  for (const name of teamNames || []) {
    const crest = await wikiCrest(name);
    out.push(crest);
    // gentle pause between image downloads
    await new Promise(r => setTimeout(r, 300));
  }
  return out;
}

function clearCache() { mem.clear(); }

module.exports = { getTeamCrests, wikiCrest, clearCache };