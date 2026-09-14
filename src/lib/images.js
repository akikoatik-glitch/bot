'use strict';

// Best-effort club CREST lookup for prediction posts.
//
// No API keys. We fetch the Wikimedia list of files used in the club's
// article and pick the one that is clearly the club LOGO / CREST (scored by
// filename: "logo|crest|badge|emblem|shield" keywords or the team name),
// excluding noise (kit parts, flags, maps). The chosen SVG/PNG is rasterized
// to a PNG/JPEG thumbnail and returned as bytes ready for Telegram.
// Anything that fails returns null and callers fall back to a text-only post.

const log = require('./logger');
const { httpGet } = require('../sources/http');

// Wikimedia's API policy requires a descriptive, contactable User-Agent;
// anonymous requests get rate-limited (429) quickly.
const WIKI_UA = 'KikoPredictionsBot/1.0 (Telegram football predictions; source https://github.com/akikoatik-glitch/bot)';

const mem = new Map(); // key -> { buffer, mime } | null

async function fetchBuffer(url, timeout = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': WIKI_UA, 'Accept': 'image/*' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const ct = res.headers.get('content-type') || 'image/jpeg';
    if (!/^image\//.test(ct.split(';')[0].trim())) throw new Error('not an image: ' + ct);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 500) throw new Error('image too small');
    return { buffer: buf, mime: ct.split(';')[0].trim() };
  } finally {
    clearTimeout(t);
  }
}

const IMAGE_EXT = /\.(svg|png|jpe?g|webp|gif)$/i;
function isImageFile(name) { return IMAGE_EXT.test(name); }
function teamish(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

// Wikimedia sister-project logos and other junk appear at the bottom of every
// article and must never be picked as a club crest.
const JUNK = /(commons|wikinews|wikivoyage|wiktionary|wikisource|wikibooks|wikidata)-logo|wikimedia|sister|website|favicon|location map|locator|blank\.|kit\s*(left|right|body|shorts|socks|arm)|flag[ _\-]of|\b(19|20)\d\d\b|edit[_-]/i;

// Score a file name as a likely club crest/logo. Returns >= 1 when it looks
// like a logo, negative when it is clearly junk, 0 when unknown.
function scoreFile(name, teamKey) {
  const n = String(name || '').toLowerCase();
  if (!isImageFile(n)) return 0;
  if (JUNK.test(n)) return -200;
  const fkey = teamish(n);
  const hasTeam = !!(teamKey && teamKey.length >= 4 && fkey.includes(teamKey));
  const startsTeam = hasTeam && fkey.startsWith(teamKey);
  let s = 0;
  if (/(logo|crest|badge|emblem|shield|wappen|escudo|escut)/.test(n)) s += 20;
  if (hasTeam) s += 50;
  if (startsTeam) s += 15;
  if (/\.svg$/i.test(n)) s += 5;
  if (/\.(png|jpe?g)$/i.test(n)) s -= 2;
  return s;
}

async function fileThumb(name) {
  // imageinfo gives the exact raster thumbnail URL (SVG → PNG) on Wikimedia.
  const t = 'File:' + String(name || '').replace(/^File:/i, '');
  const api = 'https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1'
    + '&prop=imageinfo&iiprop=url&iiurlwidth=320&titles=' + encodeURIComponent(t);
  const data = await httpGet(api, {
    headers: { 'User-Agent': WIKI_UA },
    cacheBucket: 'wiki', cacheKey: 'wiki:ii:' + t, timeout: 8000, retries: 1,
  });
  const pages = (data && data.query && data.query.pages) ? Object.values(data.query.pages) : [];
  const info = pages[0] && pages[0].imageinfo ? pages[0].imageinfo[0] : null;
  const thumbUrl = (info && info.thumburl) || null;
  if (!thumbUrl) return null;
  return fetchBuffer(thumbUrl);
}

async function wikiCrest(teamName) {
  const key = 'wiki:' + String(teamName || '').trim().toLowerCase();
  if (mem.has(key)) return mem.get(key);
  let crest = null;
  try {
    const teamKey = teamish(teamName);
    const title = encodeURIComponent(String(teamName || '').trim());
    const api = 'https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1'
      + '&prop=images&imlimit=500&titles=' + title;
    const data = await httpGet(api, {
      headers: { 'User-Agent': WIKI_UA },
      cacheBucket: 'wiki', cacheKey: 'wiki:img:' + String(teamName || '').trim(), timeout: 8000, retries: 1,
    });
    const pages = (data && data.query && data.query.pages) ? Object.values(data.query.pages) : [];
    const images = (pages[0] && pages[0].images) ? pages[0].images.map(f => f.title) : [];
    if (!images.length) throw new Error('no file list');

    const candidates = images
      .map(f => ({ name: f, score: scoreFile(f, teamKey) }))
      .filter(c => c.score >= 1)
      .sort((a, b) => b.score - a.score);

    for (const c of candidates.slice(0, 12)) {
      try {
        crest = await fileThumb(c.name);
        if (crest) break;
      } catch (e) {
        log.warn('images.thumb.failed', { name: c.name, err: e.message });
      }
    }
  } catch (e) {
    log.warn('images.wiki.failed', { team: teamName, err: e.message });
  }
  mem.set(key, crest);
  return crest;
}

// Returns [homeCrest, awayCrest]; each is { buffer, mime } or null.
async function getTeamCrests(teamNames) {
  const out = [];
  for (const name of teamNames || []) {
    const crest = await wikiCrest(name);
    out.push(crest);
    await new Promise(r => setTimeout(r, 1000));
  }
  return out;
}

function clearCache() { mem.clear(); }

module.exports = { getTeamCrests, wikiCrest, clearCache };