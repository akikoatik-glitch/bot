'use strict';

// Generates SEO-friendly static HTML pages for each published prediction.
// Each page contains Schema.org SportsEvent + FAQPage structured data.
// Pages live under <publicDir>/predictions/<match_id>/index.html.

const fs = require('fs');
const path = require('path');
const config = require('../lib/config');
const db = require('../lib/db');
const log = require('../lib/logger');

// The HTML entity for an apostrophe is the literal 6-char sequence "& # 3 9 ;".
// We construct it from the chars so we never have to embed raw apostrophes.
const APOS = String.fromCharCode(38, 35, 51, 57, 59); // "'"
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/'/g, APOS);
}

function slug(s) {
  return String(s || '').toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function arDigits(n) {
  return String(n).replace(/[0-9]/g, c => '٠١٢٣٤٥٦٧٨٩'[parseInt(c, 10)]);
}

function template(pred, match) {
  const base = config.web.publicBaseUrl || '';
  const url = `${base}/predict/${encodeURIComponent(match.id)}/`;
  const home = match.home_name, away = match.away_name;
  const league = match.league || 'Football';
  const ko = new Date(match.utc_date);
  const dateStr = ko.toISOString();
  const conf = pred.conf;
  const cs = pred.correct_score || '';

  const ld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "SportsEvent",
        "name": `${home} vs ${away}`,
        "description": `Football prediction: ${home} vs ${away} (${league}) — probabilities, expected goals, corners, cards.`,
        "startDate": dateStr,
        "sport": "Football",
        "homeTeam": { "@type": "SportsTeam", "name": home },
        "awayTeam": { "@type": "SportsTeam", "name": away },
        "competitor": [
          { "@type": "SportsTeam", "name": home },
          { "@type": "SportsTeam", "name": away }
        ],
        "eventStatus": "https://schema.org/EventScheduled",
        "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode"
      },
      {
        "@type": "FAQPage",
        "mainEntity": [
          { "@type": "Question", "name": `Who is the favourite in ${home} vs ${away}?`,
            "acceptedAnswer": { "@type": "Answer", "text": `Our model gives ${home} ${pred.p_home}% win probability, draw ${pred.p_draw}%, ${away} ${pred.p_away}%.` } },
          { "@type": "Question", "name": "Will both teams score?",
            "acceptedAnswer": { "@type": "Answer", "text": `BTTS Yes probability: ${pred.btts_yes ? Math.round(pred.btts_yes * 100) : '—'}%.` } },
          { "@type": "Question", "name": "How many goals are expected?",
            "acceptedAnswer": { "@type": "Answer", "text": `Expected total goals: ${pred.xg_home != null ? (Number(pred.xg_home) + Number(pred.xg_away)).toFixed(2) : '—'}. Most likely correct score: ${cs}.` } }
        ]
      }
    ]
  };

  const head = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(home)} vs ${escapeHtml(away)} — Prediction & Odds | XWhiz</title>
<meta name="description" content="Statistical prediction for ${escapeHtml(home)} vs ${escapeHtml(away)} (${escapeHtml(league)}). Probabilities, expected goals, BTTS, correct score, corners and cards.">
<meta name="robots" content="index,follow">
<meta property="og:title" content="${escapeHtml(home)} vs ${escapeHtml(away)} — Prediction">
<meta property="og:description" content="${escapeHtml(league)} — model confidence ${conf}/100. Most likely score: ${escapeHtml(cs)}.">
<meta property="og:type" content="article">
<link rel="canonical" href="${escapeHtml(url)}">
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<style>
  body { font: 16px/1.55 system-ui, -apple-system, Segoe UI, Tahoma, sans-serif; max-width: 760px; margin: 30px auto; padding: 0 18px; color: #1a2231; }
  h1 { font-size: 26px; margin-bottom: 4px; }
  h2 { font-size: 18px; margin-top: 22px; border-bottom: 1px solid #eee; padding-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0; }
  td, th { padding: 6px 10px; border-bottom: 1px solid #eee; text-align: left; }
  .meta { color: #6b7280; font-size: 13px; margin-bottom: 18px; }
  .conf { display: inline-block; padding: 2px 10px; border-radius: 999px; background: #eef5ff; color: #1d4ed8; font-weight: 600; }
  .warn { background: #fff8e6; border: 1px solid #fde68a; padding: 10px 14px; border-radius: 6px; font-size: 14px; }
</style>
</head>
<body>`;

  const body = `
<h1>${escapeHtml(home)} vs ${escapeHtml(away)}</h1>
<div class="meta">${escapeHtml(league)} • ${escapeHtml(dateStr)} • Confidence <span class="conf">${conf}/100</span></div>
<div class="warn">These are statistical probabilities from a mathematical model, not guaranteed outcomes. Please gamble responsibly.</div>

<h2>Match result probabilities</h2>
<table>
  <tr><th>Outcome</th><th>Probability</th></tr>
  <tr><td>${escapeHtml(home)} win</td><td>${Math.round(pred.p_home * 100)}%</td></tr>
  <tr><td>Draw</td><td>${Math.round(pred.p_draw * 100)}%</td></tr>
  <tr><td>${escapeHtml(away)} win</td><td>${Math.round(pred.p_away * 100)}%</td></tr>
</table>

<h2>Goals & BTTS</h2>
<table>
  <tr><th>Market</th><th>Probability</th></tr>
  <tr><td>Over 2.5</td><td>${pred.over_2_5 != null ? Math.round(pred.over_2_5 * 100) : '—'}%</td></tr>
  <tr><td>Under 2.5</td><td>${pred.under_2_5 != null ? Math.round(pred.under_2_5 * 100) : '—'}%</td></tr>
  <tr><td>BTTS Yes</td><td>${pred.btts_yes != null ? Math.round(pred.btts_yes * 100) : '—'}%</td></tr>
</table>

<h2>Expected goals (xG)</h2>
<table>
  <tr><th>Team</th><th>xG</th></tr>
  <tr><td>${escapeHtml(home)}</td><td>${pred.xg_home ?? '—'}</td></tr>
  <tr><td>${escapeHtml(away)}</td><td>${pred.xg_away ?? '—'}</td></tr>
</table>

<h2>Most likely correct score</h2>
<p><strong>${escapeHtml(cs)}</strong></p>

<h2>Methodology</h2>
<p>Predictions are computed from a Dixon-Coles bivariate Poisson model combined with Elo ratings, league-average goal scaling, recent form, and (where available) head-to-head and bookmaker odds as a secondary signal. Probabilities are explicit; markets with insufficient data are omitted. We never claim certainty.</p>
<p><small>Prediction generated at ${escapeHtml(pred.published_at || '')} UTC.</small></p>
`;

  const tail = `</body></html>`;
  return head + body + tail;
}

async function writeOne(pred) {
  const match = db.getMatch(pred.match_id);
  if (!match) return null;
  const dir = path.join(config.paths.publicDir, 'predictions', match.id);
  fs.mkdirSync(dir, { recursive: true });
  const html = template({
    p_home: pred.p_home, p_draw: pred.p_draw, p_away: pred.p_away,
    conf: pred.conf, correct_score: pred.correct_score,
    xg_home: pred.xg_home, xg_away: pred.xg_away,
    btts_yes: pred.btts_yes, over_2_5: pred.over_2_5, under_2_5: pred.under_2_5,
    published_at: pred.published_at,
  }, match);
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  return path.join(dir, 'index.html');
}

async function regenerate() {
  const ps = db.listPredictions({ limit: 500 });
  let written = 0;
  for (const p of ps) {
    try {
      const f = await writeOne(p);
      if (f) written++;
    } catch (e) {
      log.warn('seo.write.failed', { id: p.match_id, err: e.message });
    }
  }
  // Sitemap fragment for predictions
  try {
    const base = config.web.publicBaseUrl || '';
    const lines = ['<?xml version="1.0" encoding="UTF-8"?>'];
    lines.push('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    for (const p of ps) {
      const m = db.getMatch(p.match_id);
      if (!m) continue;
      const url = `${base}/predict/${encodeURIComponent(m.id)}/`;
      lines.push(`  <url><loc>${escapeHtml(url)}</loc><lastmod>${escapeHtml((p.published_at || '').slice(0,10))}</lastmod></url>`);
    }
    lines.push('</urlset>');
    fs.mkdirSync(path.join(config.paths.publicDir, 'predictions'), { recursive: true });
    fs.writeFileSync(path.join(config.paths.publicDir, 'predictions', 'sitemap.xml'), lines.join('\n'));
  } catch (e) {
    log.warn('seo.sitemap.failed', { err: e.message });
  }
  log.info('seo.regenerated', { written });
  return { written };
}

module.exports = { regenerate, writeOne };
