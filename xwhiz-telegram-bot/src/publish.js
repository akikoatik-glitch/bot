'use strict';

// Core orchestrator. One publish cycle:
//
//   1. Decide time window (HOURS_AHEAD_MIN..HOURS_AHEAD_MAX from now)
//   2. Fetch fixtures from all sources, dedupe
//   3. For each upcoming match, fetch recent form + standings + odds + H2H
//   4. Run engine.predictMatch → result
//   5. Apply league policy & minimum confidence
//   6. Rank by ranking_score, take top MAX_PREDICTIONS_PER_CYCLE
//   7. For each match:
//        - Save prediction to DB (UNIQUE on match_id)
//        - Format Arabic message
//        - sendMessage to channel
//        - Update message_id in DB
//        - Sleep briefly between messages
//   8. Trigger result tracking for past predictions (best-effort)

const log = require('./lib/logger');
const config = require('./lib/config');
const db = require('./lib/db');
const tg = require('./lib/telegram');
const agg = require('./sources/aggregator');
const apiFootball = require('./sources/api_football');
const fd = require('./sources/football_data');
const fallback = require('./sources/fallbacks');
const engine = require('./lib/engine');
const { formatPrediction } = require('./lib/formatter');
const results = require('./lib/results');

function dayString(d) { return d.toISOString().slice(0, 10); }

async function fetchFormForTeam(matches, teamName, leagueFilter) {
  // matches: array of internal-shape matches (need .scoreHome/.scoreAway normalised)
  const norm = matches.map(m => ({
    home: m.home_name || m.home,
    away: m.away_name || m.away,
    scoreHome: m.score_home != null ? m.score_home : (m.score && m.score.fullTime && m.score.fullTime.home),
    scoreAway: m.score_away != null ? m.score_away : (m.score && m.score.fullTime && m.score.fullTime.away),
    status: m.status,
  })).filter(x => x.status === 'FINISHED' && x.scoreHome != null && x.scoreAway != null);
  return engine.computeFormPoints(norm, teamName, 5);
}

async function fetchH2HForMatch(match) {
  const out = [];
  // Try football-data.org first
  if (fd.enabled() && match.id && match.id.startsWith('fd_')) {
    const mid = match.id.slice(3);
    const arr = await fd.fetchHeadToHead(mid, 8);
    return arr;
  }
  // Try API-Football next
  if (apiFootball.enabled() && match.home_id && match.away_id) {
    const arr = await apiFootball.fetchHeadToHead(match.home_id, match.away_id);
    return arr.map(m => ({
      home: m.home_name, away: m.away_name,
      scoreHome: m.score_home, scoreAway: m.score_away,
      status: m.status,
    })).filter(x => x.status === 'FINISHED' && x.scoreHome != null && x.scoreAway != null);
  }
  return out;
}

async function fetchOddsForMatch(match) {
  if (apiFootball.enabled() && match.id && match.id.startsWith('af_')) {
    const fid = match.id.slice(3);
    const o = await apiFootball.fetchOdds(fid);
    if (o && o.bookmakers && o.bookmakers.length) {
      // Use the first bookmaker with h2h market.
      for (const b of o.bookmakers) {
        for (const bet of (b.bets || [])) {
          if (bet.id === 1 && bet.values && bet.values.length) {
            const map = {};
            for (const v of bet.values) {
              if (v.value === 'Home') map.home = parseFloat(v.odd);
              if (v.value === 'Draw') map.draw = parseFloat(v.odd);
              if (v.value === 'Away') map.away = parseFloat(v.odd);
            }
            if (map.home && map.draw && map.away) return map;
          }
        }
      }
    }
  }
  return null;
}

// standingsOk = true if we managed to fetch at least one of the two
// teams' recent standings (i.e. we have league-level data).
async function gatherContextForMatch(match, allRecent) {
  const ctx = {
    standingsOk: false,
    recentResults: allRecent,
    homeForm: [],
    awayForm: [],
    h2h: [],
    odds: null,
  };
  ctx.homeForm = await fetchFormForTeam(allRecent, match.home_name);
  ctx.awayForm = await fetchFormForTeam(allRecent, match.away_name);
  // standingsOk: we have a standings API call would be expensive per match;
  // treat as true if we have a recognised league in our priority list.
  ctx.standingsOk = engine.leaguePriorityScore(match.league) >= 50;
  ctx.h2h = await fetchH2HForMatch(match);
  ctx.odds = await fetchOddsForMatch(match);
  return ctx;
}

async function collectRecentMatches(daysBack = 7) {
  const out = [];
  // Allow tests to inject a stub
  if (global.__XWHIZ_STUB_RECENT__) return global.__XWHIZ_STUB_RECENT__;
  const today = new Date();
  for (let i = 1; i <= daysBack; i++) {
    const d = new Date(today.getTime() - i * 86400000);
    const ds = dayString(d);
    try {
      const ms = await agg.fetchDay(ds);
      out.push(...ms);
    } catch (e) {
      log.warn('recent.fetchDay.failed', { date: ds, err: e.message });
    }
  }
  return out;
}

async function refreshRecentResults() {
  // Pull finished matches from yesterday (and earlier) to update scores.
  const today = new Date();
  for (let i = 1; i <= 2; i++) {
    const d = new Date(today.getTime() - i * 86400000);
    const ds = dayString(d);
    try {
      const ms = await agg.fetchDay(ds);
      for (const m of ms) {
        if (m.status === 'FINISHED' && m.score_home != null && m.score_away != null) {
          db.upsertMatch({
            ...m,
            raw_json: m.raw,
            fetched_at: new Date().toISOString(),
          });
        }
      }
    } catch (e) {
      log.warn('refresh.fetchDay.failed', { date: ds, err: e.message });
    }
  }
}

function inWindow(match) {
  const now = Math.floor(Date.now() / 1000);
  const min = now + config.scheduler.hoursAheadMin * 3600;
  const max = now + config.scheduler.hoursAheadMax * 3600;
  const ts = match.kickoff_ts || Math.floor(new Date(match.utc_date).getTime() / 1000);
  return ts >= min && ts <= max;
}

async function publishCycle({ dryRun = false } = {}) {
  if (config.scheduler.pause) {
    log.info('publish.skipped', { reason: 'paused' });
    return { published: 0, skipped: 'paused' };
  }

  const now = new Date();
  const today = dayString(now);
  const tomorrow = dayString(new Date(now.getTime() + 86400000));

  log.info('publish.cycle.start', {
    today, tomorrow,
    minConf: config.scheduler.minConfidence,
    maxPerCycle: config.scheduler.maxPredictionsPerCycle,
    hoursAhead: [config.scheduler.hoursAheadMin, config.scheduler.hoursAheadMax],
    dryRun,
  });

  // Fetch upcoming fixtures (today + tomorrow)
  let upcoming = [];
  try {
    const [a, b] = await Promise.all([
      agg.fetchDay(today),
      agg.fetchDay(tomorrow),
    ]);
    upcoming = a.concat(b);
  } catch (e) {
    log.error('publish.fetch.failed', { err: e.message });
    return { published: 0, error: e.message };
  }

  // Filter to window & status TIMED
  upcoming = upcoming.filter(m => (m.status === 'TIMED' || m.status === 'SCHEDULED') && inWindow(m));

  // Dedupe by id (the aggregator already dedupes within a day, but a match can
  // appear in both today's and tomorrow's window).
  const seen = new Set();
  upcoming = upcoming.filter(m => { if (seen.has(m.id)) return false; seen.add(m.id); return true; });

  // Persist to DB
  for (const m of upcoming) {
    db.upsertMatch({ ...m, raw_json: m.raw });
  }

  // Recent results for form (cached by aggregator's cache)
  const allRecent = await collectRecentMatches(7);

  // For each match, compute prediction
  const enriched = [];
  for (const m of upcoming) {
    try {
      const ctx = await gatherContextForMatch(m, allRecent);
      const result = engine.predictMatch({
        home: m.home_name, away: m.away_name, league: m.league,
        ...ctx,
      });
      // Skip if already predicted
      const existing = db.getPredictionByMatch(m.id);
      if (existing && existing.channel_message_id) {
        continue;
      }
      enriched.push({
        match: m, result, existing,
        ranking: result.ranking_score,
      });
    } catch (e) {
      log.warn('publish.match.failed', { id: m.id, err: e.message });
    }
  }

  // Filter & rank
  const eligible = enriched.filter(e => e.result.conf >= config.scheduler.minConfidence);
  eligible.sort((a, b) => b.ranking - a.ranking);
  const top = eligible.slice(0, config.scheduler.maxPredictionsPerCycle);

  log.info('publish.cycle.summary', {
    upcoming: upcoming.length,
    enriched: enriched.length,
    eligible: eligible.length,
    selected: top.length,
  });

  if (!top.length) {
    db.stateSet('last_publish', new Date().toISOString());
    db.stateSet('last_publish_status', 'no-opportunities');
    return { published: 0, eligible: eligible.length, upcoming: upcoming.length };
  }

  let published = 0;
  for (const e of top) {
    const m = e.match;
    const r = e.result;
    try {
      const { text } = formatPrediction({
        home: m.home_name, away: m.away_name, league: m.league,
        kickoff_iso: m.utc_date, result: r,
        affiliate: { link: config.affiliate.melbetLink, code: config.affiliate.promoCode },
      });
      if (dryRun || config.safety.dryRun) {
        log.info('publish.dry_run', { id: m.id, conf: r.conf });
        published++;
        continue;
      }
      const msg = await tg.sendMessage(config.telegram.channelId, text, {
        disable_web_page_preview: true,
      });
      const messageId = msg && msg.message_id ? msg.message_id : null;
      db.savePrediction({
        match_id: m.id,
        channel_message_id: messageId,
        published_at: new Date().toISOString(),
        kickoff_ts: m.kickoff_ts || Math.floor(new Date(m.utc_date).getTime() / 1000),
        league: m.league,
        home_name: m.home_name, away_name: m.away_name,
        conf: r.conf,
        p_home: r.p_home / 100, p_draw: r.p_draw / 100, p_away: r.p_away / 100,
        xg_home: r.xg.home, xg_away: r.xg.away,
        btts_yes: r.btts.yes / 100, over_2_5: r.over_under.over_2_5 / 100, under_2_5: r.over_under.under_2_5 / 100,
        pred_1x2: r.pred_1x2,
        correct_score: r.correct_score,
        correct_score_prob: r.correct_score_prob / 100,
        arabic_text: text,
        english_text: null,
        sources_json: { provider: m.provider, league_code: m.league_code },
        accuracy_score: r.ranking_score,
        data_quality: r.data_quality,
      });
      published++;
      db.stateSet('last_publish', new Date().toISOString());
      db.stateSet('last_publish_id', String(m.id));
      log.info('publish.ok', {
        id: m.id, league: m.league, conf: r.conf,
        home: m.home_name, away: m.away_name,
        kickoff: m.utc_date,
      });
      // Sleep a bit between messages to avoid burst triggers
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      db.logError('publish', `publish failed for ${m.id}`, e.stack || e.message);
      log.error('publish.failed', { id: m.id, err: e.message });
    }
  }

  db.stateSet('last_publish_status', 'ok');
  db.stateSet('last_publish_count', String(published));

  // Best-effort: track results for past predictions.
  try {
    await results.trackMissing();
  } catch (e) {
    log.warn('results.track.failed', { err: e.message });
  }

  return { published, eligible: eligible.length, upcoming: upcoming.length };
}

module.exports = {
  publishCycle,
  refreshRecentResults,
  gatherContextForMatch,
};
