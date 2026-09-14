'use strict';

// Track prediction outcomes:
//   • Pull finished matches (latest results) for any predictions that have
//     no recorded result yet.
//   • Compute outcome correctness (1X2, BTTS, O/U 2.5, correct score, best bet).
//   • Store into the `results` table for the admin dashboard.
//   • Post a HUMAN-LIKE follow-up reply after every published prediction that
//     finished — correct ones are celebrated, wrong ones acknowledged openly —
//     so the channel looks like a real admin who reports results honestly.
//     Void markets (e.g. a draw in a draw-no-bet pick) stay silent.

const log = require('./logger');
const db = require('./db');
const tg = require('./telegram');
const config = require('./config');
const agg = require('../sources/aggregator');
const apiFootball = require('../sources/api_football');
const { pick, toArDigits } = require('./phrases');
const { escapeHtml } = require('./formatter');

function dayString(d) { return d.toISOString().slice(0, 10); }

async function fetchLatestResultsForMatch(matchId) {
  // Try API-Football if match id starts with af_
  if (apiFootball.enabled() && matchId && matchId.startsWith('af_')) {
    const fid = matchId.slice(3);
    const m = await apiFootball.fetchFixtureById(fid);
    if (m && m.status === 'FINISHED' && m.score_home != null && m.score_away != null) return m;
  }
  return null;
}

async function ensureLatestScores() {
  // Refresh scores for matches on today + yesterday (best effort)
  const today = new Date();
  for (let i = 1; i <= 3; i++) {
    const d = new Date(today.getTime() - i * 86400000);
    const ds = dayString(d);
    try {
      const ms = await agg.fetchDay(ds);
      for (const m of ms) {
        if (m.status === 'FINISHED' && m.score_home != null && m.score_away != null) {
          db.upsertMatch({ ...m, raw_json: m.raw });
        }
      }
    } catch (e) {
      log.warn('results.fetchDay.failed', { date: ds, err: e.message });
    }
  }
}

function bestBetOutcome(key, m) {
  if (!key) return null;
  const sh = m.score_home, sa = m.score_away;
  const total = sh + sa;
  const btts = sh > 0 && sa > 0;
  switch (key) {
    case '1': return sh > sa ? 1 : 0;
    case 'X': return sh === sa ? 1 : 0;
    case '2': return sh < sa ? 1 : 0;
    case '1X': return sh >= sa ? 1 : 0;
    case 'X2': return sh <= sa ? 1 : 0;
    case '12': return sh !== sa ? 1 : 0;
    case 'O15': return total > 1 ? 1 : 0;
    case 'O25': return total > 2 ? 1 : 0;
    case 'O35': return total > 3 ? 1 : 0;
    case 'U25': return total < 3 ? 1 : 0;
    case 'U35': return total < 4 ? 1 : 0;
    case 'BTTS_Y': return btts ? 1 : 0;
    case 'BTTS_N': return !btts ? 1 : 0;
    case 'DNB_H': return sh === sa ? null : (sh > sa ? 1 : 0); // draw voids
    case 'DNB_A': return sh === sa ? null : (sh < sa ? 1 : 0);
    case 'CRNR_H': return total > 9 ? 1 : 0; // >9.5 corners
    case 'YEL_H': return null; // we don't track yellow cards; voids
    default: return null; // HT markets: no half-time score stored
  }
}

function computeOutcomes(p, m) {
  const sh = m.score_home, sa = m.score_away;
  const total = sh + sa;
  const btts = (sh > 0 && sa > 0) ? 1 : 0;
  const over25 = total > 2 ? 1 : 0;
  const cs = `${sh}-${sa}`;

  const oneX2 = (sh > sa ? '1' : sh === sa ? 'X' : '2');
  const out1x2 = (oneX2 === p.pred_1x2) ? 1 : 0;
  const outBTTS = (p.btts_yes >= 0.5 ? btts === 1 : btts === 0) ? 1 : 0;
  const outOver = (p.over_2_5 >= 0.5 ? over25 === 1 : over25 === 0) ? 1 : 0;
  const outCS = (p.correct_score && p.correct_score === cs) ? 1 : 0;
  const outBest = bestBetOutcome(p.best_bet_key, m);
  return { sh, sa, total, btts, over25, cs, out1x2, outBTTS, outOver, outCS, outBest };
}

// Human-ish Arabic reply for a CORRECT prediction.
function winReplyText(p, seed, out) {
  const lines = [];
  if (p.best_bet_label) {
    lines.push(`${pick('WIN_REPLIES', seed)} ✅`);
    lines.push(`التوقع الرابح: <b>${escapeHtml(p.best_bet_label)}</b> 🎯`);
  } else {
    lines.push(pick('WIN_REPLIES', seed));
    lines.push('توقعنا صدق 🎯');
  }
  if (out && Number.isFinite(out.sh) && Number.isFinite(out.sa)) {
    lines.push(`النتيجة النهائية: <b>${toArDigits(out.sh)} - ${toArDigits(out.sa)}</b> ⚽`);
  }
  return lines.join('\n');
}

// Human-ish Arabic reply for a WRONG prediction (honest, not deleted).
function lossReplyText(p, seed, out) {
  const lines = [];
  lines.push(pick('LOSS_REPLIES', seed));
  if (p.best_bet_label) {
    lines.push(`توقعنا كان: <i>${escapeHtml(p.best_bet_label)}</i>`);
  }
  if (out && Number.isFinite(out.sh) && Number.isFinite(out.sa)) {
    lines.push(`النتيجة النهائية: <b>${toArDigits(out.sh)} - ${toArDigits(out.sa)}</b> ⚽`);
  }
  return lines.join('\n');
}

// Deterministic seed from prediction id → same reply never repeats per match.
function seedFor(p) {
  return p.id || 0;
}

async function trackMissing({ sender, skipRefresh } = {}) {
  if (!skipRefresh) await ensureLatestScores();
  const candidates = db.listPredictionsMissingResult({ limit: 200 });
  if (!candidates.length) return { recorded: 0, celebrated: 0, followed: 0 };

  const send = sender || tg.sendMessage;
  const MAX_REPLIES_PER_RUN = 5;

  let recorded = 0, celebrated = 0, followed = 0;
  for (const p of candidates) {
    let m = db.getMatch(p.match_id);
    let refreshed = null;
    if (!m || (m.status !== 'FINISHED' && (!m.score_home == null || !m.score_away == null))) {
      refreshed = await fetchLatestResultsForMatch(p.match_id);
      if (refreshed) {
        db.upsertMatch(refreshed);
        m = db.getMatch(p.match_id);
      }
    }
    if (!m || m.status !== 'FINISHED' || m.score_home == null || m.score_away == null) continue;
    const out = computeOutcomes(p, m);
    db.recordResult({
      prediction_id: p.id,
      match_id: p.match_id,
      result_home: out.sh, result_away: out.sa, total_goals: out.total,
      btts_actual: out.btts, over_2_5_actual: out.over25, correct_score_actual: out.cs,
      outcome_1x2_correct: out.out1x2, outcome_btts_correct: out.outBTTS,
      outcome_over_correct: out.outOver, outcome_cs_correct: out.outCS,
      outcome_best_correct: out.outBest,
    });
    recorded++;

    // Post a follow-up reply for EVERY settled prediction: wins are
    // celebrated, losses are acknowledged openly, void markets stay silent.
    const won = out.outBest === 1 || (out.outBest == null && p.best_bet_key == null && out.out1x2 === 1);
    const lost = out.outBest === 0 || (out.outBest == null && p.best_bet_key == null && out.out1x2 === 0);
    const isVoid = !won && !lost;
    if (isVoid) continue;

    if (celebrated + followed >= MAX_REPLIES_PER_RUN) continue;
    if (p.channel_message_id == null) continue;
    if (!config.telegram.channelId) {
      log.warn('followup.skipped', { match_id: p.match_id, reason: 'no_channel' });
      continue;
    }
    if (config.safety.dryRun) {
      log.info('followup.dry_run', { match_id: p.match_id });
      continue; // don't mark — a later live run should still post
    }
    try {
      const text = won ? winReplyText(p, seedFor(p), out) : lossReplyText(p, seedFor(p), out);
      const msg = await send(config.telegram.channelId, text, {
        replyToMessageId: p.channel_message_id,
        disable_web_page_preview: true,
      });
      const mid = msg && msg.message_id ? msg.message_id : -1;
      if (won) {
        db.markCelebrated(p.id, mid);
        db.setPredictionResultState(p.match_id, 'correct');
        celebrated++;
        log.info('results.followup.ok', { match_id: p.match_id, kind: 'win' });
      } else {
        db.markFollowupSent(p.id, mid);
        db.setPredictionResultState(p.match_id, 'wrong');
        followed++;
        log.info('results.followup.ok', { match_id: p.match_id, kind: 'loss' });
      }
    } catch (e) {
      log.warn('results.followup.failed', { match_id: p.match_id, err: e.message });
    }
  }
  log.info('results.tracked', { recorded, celebrated, followed });
  return { recorded, celebrated, followed };
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>');
}

// Backwards-compatible alias used by older callers/tests.
function celebrationText(p) {
  return winReplyText(p, seedFor(p));
}

// Build a short result summary for the daily recap & follow-ups.
function outcomeSummary(p, m) {
  const out = computeOutcomes(p, m);
  return {
    ...out,
    label: p.best_bet_label || null,
  };
}

module.exports = {
  trackMissing,
  computeOutcomes,
  bestBetOutcome,
  celebrationText,
  winReplyText,
  lossReplyText,
  outcomeSummary,
  toArDigits,
  esc,
};