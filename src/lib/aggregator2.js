'use strict';

// Lightweight helper for command handlers: collects recent results across
// the last N days so the engine can compute form points.

const fallback = require('../sources/fallbacks');
const agg = require('../sources/aggregator');

async function collectRecentForPublish(daysBack = 7) {
  const out = [];
  const today = new Date();
  for (let i = 1; i <= daysBack; i++) {
    const d = new Date(today.getTime() - i * 86400000);
    const ds = d.toISOString().slice(0, 10);
    try {
      const ms = await agg.fetchDay(ds);
      out.push(...ms);
    } catch (e) {
      // ignore
    }
  }
  // Also include any "raw" results from SportScore not in our aggregator (broad window).
  try {
    const ss = await fallback.fetchSportScoreMatches('football', 200);
    out.push(...ss);
  } catch (e) {}
  return out;
}

module.exports = { collectRecentForPublish };
