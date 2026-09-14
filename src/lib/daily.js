'use strict';

// Human-like daily publishing pipeline.
//
// Flow (one normal day):
//   1. planDay()      — after midnight, fetch fixtures, run the engine on the
//                       whole day+tomorrow, and store *planned* predictions
//                       whose publish time is set to (kickoff − 3h).
//   2. greetingIfNeeded() — one Arabic morning intro per day, varied wording,
//                       mentioning today's planned picks in short lines.
//   3. publishDue()   — every few minutes, post any planned prediction whose
//                       publish time has arrived (compact, best-market only).
//   4. results tick   — after each match, results.trackMissing() replies with
//                       a win or loss follow-up.
//   5. dailySummary() — one Arabic recap at the end of the day.
//
// Anti-flood: one greeting, N ≤ MAX_PREDICTIONS_PER_DAY posts, one summary.
// Nothing is ever "guaranteed" — all text uses probability language.

const log = require('./logger');
const config = require('./config');
const db = require('./db');
const tg = require('./telegram');
const tz = require('./tz');
const engine = require('./engine');
const agg = require('../sources/aggregator');
const { formatCompactPrediction } = require('./formatter');
const { pick, toArDigits } = require('./phrases');
const results = require('./results');
const { gatherContextForMatch } = require('../publish');
const { collectRecentForPublish } = require('./aggregator2');

function dayString(d) { return d.toISOString().slice(0, 10); }

// ── phrase seed (rotation across the whole channel) ────────────────────────

function bumpSeed(step = 1) {
  let s = parseInt(db.stateGet('phrase_seed') || '0', 10);
  if (!Number.isFinite(s)) s = 0;
  s += step;
  db.stateSet('phrase_seed', String(s));
  return s;
}

function isPaused() {
  return config.scheduler.pause;
}

// ── 1. Morning greeting ────────────────────────────────────────────────────

// Only sends inside the morning window (greeting time .. +5h) so a bot that
// restarts at 17:00 doesn't say "good morning". One per local day.
async function greetingIfNeeded({ sender, force } = {}) {
  if (isPaused()) return { sent: false, reason: 'paused' };
  const today = tz.localDateString();
  if (!force && db.stateGet('greeting_date') === today) return { sent: false, reason: 'already' };

  const gt = config.daily.greetingTime || '08:30';
  if (!force && !tz.inTimeWindow(gt, addHHMM(gt, 5))) return { sent: false, reason: 'outside_window' };

  const seed = bumpSeed();
  const fromSched = tz.todayStartEpoch();
  const toSched = fromSched + 86400;
  const planned = db.listPlanned({ fromScheduledTs: fromSched, toScheduledTs: toSched, limit: config.daily.maxPredictionsPerDay });

  const lines = [];
  lines.push(pick('MORNING_GREETINGS', seed));
  lines.push('');
  if (planned.length) {
    lines.push('<b>توقعات النهار:</b>');
    for (const p of planned.slice(0, config.daily.maxPredictionsPerDay)) {
      const t = fmtClock(p.scheduled_at_ts);
      lines.push(`🕐 ${t} — ${escapeHtml(p.home_name)} 🆚 ${escapeHtml(p.away_name)}`);
    }
  } else {
    lines.push('لم نجد اليوم مباريات قوية تستحق النشر، نتابع ونوافيكم عند توفر فرص حقيقية 📊');
  }
  lines.push('');
  lines.push(pick('GREETING_CLOSINGS', seed));
  const text = lines.join('\n');

  const send = sender || tg.sendMessage;
  if (config.safety.dryRun) {
    log.info('daily.greeting.dry_run', { date: today });
    db.stateSet('greeting_date', today);
    return { sent: true, dryRun: true, counts: planned.length };
  }
  try {
    await send(config.telegram.channelId, text, { disable_web_page_preview: true });
    db.stateSet('greeting_date', today);
    log.info('daily.greeting.sent', { date: today, planned: planned.length });
    return { sent: true, counts: planned.length };
  } catch (e) {
    log.warn('daily.greeting.failed', { err: e.message });
    return { sent: false, reason: 'error', err: e.message };
  }
}

function addHHMM(hhmm, hours) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = (h + hours) * 60 + m;
  const hh = Math.floor(total / 60) % 24;
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function fmtClock(epoch) {
  try {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: config.tz }).format(new Date(epoch * 1000));
  } catch (e) {
    return '—';
  }
}

// ── 2. Plan the day ────────────────────────────────────────────────────────

// Relaunch-at-midnight guard: runs at most once per local day. Predicts the
// coming fixtures (today + tomorrow) and persists planned rows. Only matches
// with best-bet confidence ≥ GOOD are planned, and only when their publish
// time (kickoff − N hours) hasn't already passed.
async function planDay({ recentOverride, force } = {}) {
  if (isPaused()) return { planned: 0, reason: 'paused' };
  const today = tz.localDateString();
  if (!force && db.stateGet('plan_date') === today) return { planned: 0, reason: 'already' };

  const windowDays = config.daily.planWindowDays || 2;
  const now = Math.floor(Date.now() / 1000);
  const days = [];
  for (let i = 0; i < windowDays; i++) {
    days.push(dayString(new Date(Date.now() + i * 86400000)));
  }

  let upcoming = [];
  for (const ds of days) {
    try {
      const ms = await agg.fetchDay(ds);
      upcoming = upcoming.concat(ms);
    } catch (e) {
      log.warn('daily.plan.fetchDay.failed', { date: ds, err: e.message });
    }
  }

  // Dedupe + keep only upcoming TIMED fixtures
  const seen = new Set();
  upcoming = upcoming
    .filter(m => (m.status === 'TIMED' || m.status === 'SCHEDULED'))
    .filter(m => { if (seen.has(m.id)) return false; seen.add(m.id); return true; })
    .filter(m => (m.kickoff_ts || Math.floor(new Date(m.utc_date).getTime() / 1000)) >= now - 600);

  // League policy: prioritize major leagues only.
  try { upcoming = agg.applyLeaguePolicy(upcoming); } catch (_) {}

  if (!upcoming.length) {
    db.stateSet('plan_date', today);
    return { planned: 0, reason: 'no_fixtures' };
  }

  for (const m of upcoming) {
    db.upsertMatch({ ...m, raw_json: m.raw });
  }

  const allRecent = recentOverride || await collectRecentForPublish(7);
  const recentKeys = (db.recentBestBetKeys ? db.recentBestBetKeys(10) : []) || [];
  const bestFloor = (config.daily && config.daily.confGood) || 70;
  const hoursBefore = (config.daily && config.daily.predictHoursBefore) || 3;
  const maxPerDay = (config.daily && config.daily.maxPredictionsPerDay) || 8;

  const planned = [];
  for (const m of upcoming) {
    try {
      const ctx = await gatherContextForMatch(m, allRecent);
      const result = engine.predictMatch({
        home: m.home_name, away: m.away_name, league: m.league,
        ...ctx, recentKeys,
      });
      const bb = result.best_bet;
      if (!bb || bb.prob == null || bb.prob < bestFloor) continue;

      const kickoffTs = m.kickoff_ts || Math.floor(new Date(m.utc_date).getTime() / 1000);
      const schedTs = tz.publishAtEpoch(kickoffTs, hoursBefore);
      // Never plan a post for a time that has already passed.
      if (schedTs <= now) continue;

      const existing = db.getPredictionByMatch(m.id);
      if (existing && existing.channel_message_id) {
        recentKeys.push(result.best_bet.key);
        continue;
      }

      db.upsertPlannedPrediction({
        match_id: m.id,
        published_at: new Date().toISOString(),
        scheduled_at_ts: schedTs,
        kickoff_ts: kickoffTs,
        league: m.league,
        home_name: m.home_name, away_name: m.away_name,
        conf: result.conf,
        p_home: result.p_home / 100, p_draw: result.p_draw / 100, p_away: result.p_away / 100,
        xg_home: result.xg.home, xg_away: result.xg.away,
        btts_yes: result.btts.yes / 100, over_2_5: result.over_under.over_2_5 / 100, under_2_5: result.over_under.under_2_5 / 100,
        pred_1x2: result.pred_1x2,
        correct_score: result.correct_score,
        correct_score_prob: result.correct_score_prob / 100,
        best_bet_key: bb.key,
        best_bet_label: bb.label,
        best_bet_prob: bb.prob / 100,
        arabic_text: '',
        english_text: null,
        sources_json: { provider: m.provider, league_code: m.league_code },
        accuracy_score: result.ranking_score,
        data_quality: result.data_quality,
      });
      recentKeys.push(bb.key);
      planned.push({ match_id: m.id, schedTs, bestBet: bb.key, prob: bb.prob, home: m.home_name, away: m.away_name });
      if (planned.length >= maxPerDay) break;
    } catch (e) {
      log.warn('daily.plan.match.failed', { id: m.id, err: e.message });
    }
  }

  db.stateSet('plan_date', today);
  log.info('daily.plan.done', { today, fixtures: upcoming.length, planned: planned.length });
  return { planned: planned.length, reason: 'ok' };
}

// ── 3. Publish due predictions ─────────────────────────────────────────────

function reconstructResult(p) {
  return {
    conf: p.conf != null ? p.conf : 0,
    p_home: (p.p_home != null ? p.p_home : 0) * 100,
    p_draw: (p.p_draw != null ? p.p_draw : 0) * 100,
    p_away: (p.p_away != null ? p.p_away : 0) * 100,
    best_bet: {
      key: p.best_bet_key || null,
      label: p.best_bet_label || null,
      prob: (p.best_bet_prob != null ? p.best_bet_prob : 0) * 100,
    },
    xg: {
      home: p.xg_home,
      away: p.xg_away,
      total: (p.xg_home || 0) + (p.xg_away || 0),
    },
    correct_score: p.correct_score || '0-0',
    correct_score_prob: (p.correct_score_prob != null ? p.correct_score_prob : 0) * 100,
  };
}

// Posts any planned prediction whose time has come. Compact best-market post,
// published 30 minutes before kickoff. Text-only.
async function publishDue({ sender } = {}) {
  if (isPaused()) return { published: 0, reason: 'paused' };
  const lookahead = (config.daily && config.daily.dueLookaheadSeconds) || 300;
  const due = db.listPlannedDueSoon({ withinSeconds: lookahead, limit: 20 });
  if (!due.length) return { published: 0, reason: 'none_due' };

  const send = sender || tg.sendMessage;
  let published = 0;
  for (const p of due) {
    const m = db.getMatch(p.match_id);
    if (!m) continue;
    const seed = bumpSeed();
    const { text } = formatCompactPrediction({
      home: p.home_name, away: p.away_name, league: p.league,
      kickoff_iso: m.utc_date, result: reconstructResult(p), seed,
      affiliate: { link: config.affiliate.melbetLink, code: config.affiliate.promoCode },
    });
    if (config.safety.dryRun) {
      log.info('daily.publish.dry_run', { id: p.match_id, key: p.best_bet_key, conf: p.conf });
      db.markPredictionPublished(p.match_id, null);
      published++;
      continue;
    }
    try {
      // Occasionally talk to the audience before a pick (real channel only —
      // injected senders keep the clean test path). ~1 in 3 picks gets a teaser.
      if (!sender && seed % 3 === 0) {
        try {
          await send(config.telegram.channelId, pick('PICK_TEASERS', seed), { disable_web_page_preview: true });
          await new Promise(r => setTimeout(r, 2500));
        } catch (_) { /* teaser is optional */ }
      }
      const msg = await send(config.telegram.channelId, text, { disable_web_page_preview: true });
      db.markPredictionPublished(p.match_id, msg && msg.message_id ? msg.message_id : null);
      published++;
      log.info('daily.publish.ok', { id: p.match_id, key: p.best_bet_key, prob: p.best_bet_prob, conf: p.conf });
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      db.logError('publish', `publish failed for ${p.match_id}`, e.stack || e.message);
      log.warn('daily.publish.failed', { id: p.match_id, err: e.message });
    }
  }
  db.stateSet('last_publish', new Date().toISOString());
  db.stateSet('last_publish_status', 'ok');
  db.stateSet('last_publish_count', String(published));
  return { published };
}

// ── 4. Result tracking ─────────────────────────────────────────────────────

async function trackResults({ sender, skipRefresh } = {}) {
  if (isPaused()) return { recorded: 0, reason: 'paused' };
  return results.trackMissing({ sender, skipRefresh });
}

// ── 5. Evening summary ─────────────────────────────────────────────────────

// One recap per day, only after DAILY_SUMMARY_TIME.
async function dailySummary({ sender, force } = {}) {
  if (isPaused()) return { sent: false, reason: 'paused' };
  const today = tz.localDateString();
  if (!force && db.stateGet('summary_date') === today) return { sent: false, reason: 'already' };
  if (!force && (tz.localTimeString() || '').localeCompare((config.daily.summaryTime || '23:30')) < 0) {
    return { sent: false, reason: 'too_early' };
  }

  const stats = db.dailySummaryStats(tz.todayStartEpoch(), tz.tomorrowStartEpoch());
  const seed = bumpSeed();

  let verdictKey = null;
  if (stats.total > 0) {
    const pct = Math.round((stats.wins / stats.total) * 100);
    if (Number.isFinite(pct)) verdictKey = pct >= 60 ? 'SUMMARY_GOOD' : pct >= 45 ? 'SUMMARY_OK' : 'SUMMARY_BAD';
  }
  const verdictText = verdictKey ? pick(verdictKey, seed) : pick('SUMMARY_ZERO', seed);

  const lines = [];
  lines.push(`📊 ${pick('EVENING_SUMMARIES', seed)}`);
  lines.push('');
  if (stats.total) {
    const pct = Math.round((stats.wins / stats.total) * 100);
    lines.push(`توقعات منشورة اليوم: <b>${toArDigits(stats.total)}</b>`);
    lines.push(`✅ صحيحة: <b>${toArDigits(stats.wins)}</b>`);
    lines.push(`❌ خاطئة: <b>${toArDigits(stats.losses)}</b>`);
    lines.push(`🔥 نسبة النجاح: <b>${toArDigits(Number.isFinite(pct) ? pct : 0)}%</b>`);
    lines.push('');
    lines.push(verdictText);
    lines.push('');
    lines.push('شكراً لكل من تابعنا اليوم ❤️⚽');
    lines.push('نلتقي غداً مع توقعات جديدة 🔥💰');
  } else {
    lines.push(verdictText);
  }

  const text = lines.join('\n');
  const send = sender || tg.sendMessage;
  if (config.safety.dryRun) {
    log.info('daily.summary.dry_run', { date: today });
    db.stateSet('summary_date', today);
    return { sent: true, dryRun: true, stats };
  }
  try {
    await send(config.telegram.channelId, text, { disable_web_page_preview: true });
    db.stateSet('summary_date', today);
    log.info('daily.summary.sent', { date: today, stats });
    return { sent: true, stats };
  } catch (e) {
    log.warn('daily.summary.failed', { err: e.message });
    return { sent: false, reason: 'error', err: e.message };
  }
}

// ── tick: called by the scheduler every few minutes ────────────────────────

async function tick({ sender } = {}) {
  const out = {};
  out.plan = await planDay();
  out.greeting = await greetingIfNeeded({ sender });
  out.published = await publishDue({ sender });
  return out;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>');
}

module.exports = {
  tick,
  greetingIfNeeded,
  planDay,
  publishDue,
  trackResults,
  dailySummary,
  reconstructResult,
  bumpSeed,
};