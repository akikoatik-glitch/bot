#!/usr/bin/env node
'use strict';

// Manually publish one prediction for a specific match id.

const log = require('../lib/logger');
const config = require('../lib/config');
const db = require('../lib/db');
const tg = require('../lib/telegram');
const engine = require('../lib/engine');
const agg = require('../sources/aggregator');
const fallback = require('../sources/fallbacks');
const apiFootball = require('../sources/api_football');
const { formatPrediction } = require('../lib/formatter');

(async () => {
  const matchId = process.argv[2];
  if (!matchId) {
    console.error('Usage: node src/cli/publish-one.js <match_id>');
    process.exit(2);
  }
  let m = db.getMatch(matchId);
  if (!m) {
    console.error('Match not found in DB.');
    process.exit(2);
  }
  const allRecent = await fallback.fetchSportScoreMatches('football', 200);
  const ctx = {
    standingsOk: engine.leaguePriorityScore(m.league) >= 50,
    recentResults: allRecent,
    homeForm: engine.computeFormPoints(allRecent, m.home_name),
    awayForm: engine.computeFormPoints(allRecent, m.away_name),
    h2h: [],
    odds: null,
  };
  const r = engine.predictMatch({ home: m.home_name, away: m.away_name, league: m.league, ...ctx });
  const { text } = formatPrediction({ home: m.home_name, away: m.away_name, league: m.league, kickoff_iso: m.utc_date, result: r });
  console.log('Confidence:', r.conf, 'Pred:', r.pred_1x2, 'CS:', r.correct_score);
  console.log('--- POST ---');
  console.log(text);
  if (!config.safety.dryRun && config.telegram.channelId) {
    const msg = await tg.sendMessage(config.telegram.channelId, text);
    db.savePrediction({
      match_id: m.id, channel_message_id: msg.message_id,
      published_at: new Date().toISOString(),
      kickoff_ts: Math.floor(new Date(m.utc_date).getTime() / 1000),
      league: m.league, home_name: m.home_name, away_name: m.away_name,
      conf: r.conf,
      p_home: r.p_home / 100, p_draw: r.p_draw / 100, p_away: r.p_away / 100,
      xg_home: r.xg.home, xg_away: r.xg.away,
      btts_yes: r.btts.yes / 100, over_2_5: r.over_under.over_2_5 / 100, under_2_5: r.over_under.under_2_5 / 100,
      pred_1x2: r.pred_1x2, correct_score: r.correct_score, correct_score_prob: r.correct_score_prob / 100,
      arabic_text: text, english_text: null, sources_json: { manual: true },
      accuracy_score: r.ranking_score, data_quality: r.data_quality,
    });
    console.log('Published. message_id =', msg.message_id);
  }
  process.exit(0);
})();
