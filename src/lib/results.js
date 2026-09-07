'use strict';

// Track prediction outcomes:
//   • Pull finished matches (latest results) for any predictions that have
//     no recorded result yet.
//   • Compute outcome correctness (1X2, BTTS, O/U 2.5, correct score).
//   • Store into the `results` table for the admin dashboard.

const log = require('./logger');
const db = require('./db');
const agg = require('../sources/aggregator');
const apiFootball = require('../sources/api_football');

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
  return { sh, sa, total, btts, over25, cs, out1x2, outBTTS, outOver, outCS };
}

async function trackMissing() {
  await ensureLatestScores();
  const candidates = db.listPredictionsMissingResult({ limit: 200 });
  if (!candidates.length) return { recorded: 0 };

  let recorded = 0;
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
    });
    recorded++;
  }
  log.info('results.tracked', { recorded });
  return { recorded };
}

module.exports = { trackMissing, computeOutcomes };
