#!/usr/bin/env node
'use strict';

// One-shot analysis run (no Telegram publish, no scheduler).
// Plans today's predictions through the NEW daily pipeline and prints a
// dry-run preview of every post that would be published to the channel.

const log = require('../lib/logger');
const config = require('../lib/config');
const db = require('../lib/db');
const daily = require('../lib/daily');
const { formatCompactPrediction } = require('../lib/formatter');

(async () => {
  log.info('cli.analyze.start');
  config.safety.dryRun = true; // never actually send anything

  const res = await daily.planDay({ force: true });
  console.log('--- PLAN RESULT ---');
  console.log('planned:', res.planned, '| reason:', res.reason);

  const planned = db.listPlanned({ fromScheduledTs: 0, limit: 50 });
  console.log('--- PLANNED POSTS (dry-run preview) ---');
  for (const p of planned) {
    const m = db.getMatch(p.match_id);
    const { text } = formatCompactPrediction({
      home: p.home_name, away: p.away_name, league: p.league,
      kickoff_iso: m ? m.utc_date : new Date().toISOString(),
      result: daily.reconstructResult(p),
      seed: 0,
    });
    console.log('\n===== ' + p.home_name + ' vs ' + p.away_name + ' =====');
    console.log('status:', p.status, '| scheduled at:', new Date(p.scheduled_at_ts * 1000).toISOString());
    console.log('market:', p.best_bet_key, '(' + p.best_bet_label + ')', p.best_bet_prob);
    console.log(text);
  }

  log.info('cli.analyze.done', res);
  process.exit(0);
})().catch(e => { console.error('cli.analyze.crash', e); process.exit(1); });