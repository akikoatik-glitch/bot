'use strict';

// Smoke test — offline checks (no Telegram, no network).
//
//   • Engine produces sane probabilities for a known matchup.
//   • Arabic formatter emits every required section.
//   • DB schema migrates & round-trips a prediction.

const fs = require('fs');
const path = require('path');
const os = require('os');

// Use a temp data dir so this test never pollutes the real DB.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xwhiz-test-'));
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'TEST_TOKEN';

// Point logger at a tmp log dir, by temporarily editing config.paths.dataDir
const config = require('../src/lib/config');
config.paths.dataDir = tmp;
config.paths.logDir = path.join(tmp, 'logs');
config.telegram.botToken = 'TEST_TOKEN';
config.telegram.channelId = '@test';
config.telegram.adminIds = [1];
config.safety.dryRun = true;

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('  ✗ ' + msg); failed++; }
  else { console.log('  ✓ ' + msg); }
}

console.log('1. Engine sanity');
const engine = require('../src/lib/engine');
const r = engine.predictMatch({
  home: 'Arsenal', away: 'Chelsea', league: 'Premier League',
  standingsOk: true, recentResults: [], h2h: [], odds: null,
});
assert(r.p_home + r.p_draw + r.p_away > 95, '1X2 probabilities roughly sum to 100');
assert(r.conf >= 0 && r.conf <= 100, 'confidence is a 0..100 integer');
assert(['1', 'X', '2'].includes(r.pred_1x2), 'pred_1x2 is 1 / X / 2');
assert(r.over_under.over_2_5 >= 0 && r.over_under.over_2_5 <= 100, 'over_under.over_2_5 valid');
assert(r.btts.yes >= 0 && r.btts.yes <= 100, 'btts.yes valid');
assert(/^\d+-\d+$/.test(r.correct_score), 'correct_score is N-N');
assert(typeof r.xg.home === 'number' && typeof r.xg.away === 'number', 'xG numeric');
assert(typeof r.ranking_score === 'number', 'ranking_score is numeric');
assert(typeof r.data_quality === 'number', 'data_quality is numeric');
assert(typeof r.corners.total === 'number', 'corners.total numeric');
assert(typeof r.cards.total === 'number', 'cards.total numeric');
assert(typeof r.half_time.probs.home === 'number', 'half-time prob numeric');

console.log('\n2. Arabic formatter');
const { formatPrediction } = require('../src/lib/formatter');
const out = formatPrediction({
  home: 'Arsenal', away: 'Chelsea',
  league: 'Premier League',
  kickoff_iso: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
  result: r,
});
assert(typeof out.text === 'string' && out.text.length > 200, 'post is long enough');
assert(out.text.includes('توقعات المباراة'), 'header present');
assert(out.text.includes('توقع النتيجة'), '1X2 section present');
assert(out.text.includes('الأهداف'), 'Goals section present');
assert(out.text.includes('النتيجة المتوقعة'), 'Correct score section present');
assert(out.text.includes('مستوى الثقة'), 'Confidence section present');
assert(out.text.includes('ليست نتيجة مضمونة'), 'disclaimer present');
assert(!/٩٠٪/.test(out.text) || /ثقة/.test(out.text), 'confidence labelled, not guarantee');
const plain = out.text.replace(/<\/?[^>]+>/g, '');
// Disclaimer legitimately uses "ليست نتيجة مضمونة" — that's fine. We must
// NOT contain a positive guarantee claim like "مضمون 100%" or "حتمي".
assert(!/100٪|100%/.test(plain), 'no absolute "100%" claim');
assert(!/مضمون (بنسبة|100)|مضمونة (بنسبة|100)|حتم[يى]|تأكيد (النتيجة|الفوز)/.test(plain), 'no guarantee-style language');

console.log('\n3. DB migrations');
const db = require('../src/lib/db');
db.db(); // triggers migrate
const sampleId = 'test_' + Date.now();
db.upsertMatch({
  id: sampleId, provider: 'test', league: 'Premier League', league_code: 'PL',
  utc_date: new Date(Date.now() + 86400000).toISOString(), status: 'TIMED',
  home_name: 'A', away_name: 'B', score_home: null, score_away: null,
  fetched_at: new Date().toISOString(), kickoff_ts: Math.floor(Date.now() / 1000) + 86400,
});
const got = db.getMatch(sampleId);
assert(got && got.home_name === 'A', 'match upserted');

db.savePrediction({
  match_id: sampleId, published_at: new Date().toISOString(),
  kickoff_ts: Math.floor(Date.now() / 1000) + 86400,
  league: 'Premier League', home_name: 'A', away_name: 'B',
  conf: 70, p_home: 0.6, p_draw: 0.2, p_away: 0.2,
  xg_home: 1.8, xg_away: 1.0, btts_yes: 0.6, over_2_5: 0.6, under_2_5: 0.4,
  pred_1x2: '1', correct_score: '2-1', correct_score_prob: 0.13,
  arabic_text: 'sample', sources_json: { provider: 'test' },
  accuracy_score: 80, data_quality: 75,
});
const p = db.getPredictionByMatch(sampleId);
assert(p && p.conf === 70, 'prediction saved');
assert(p.arabic_text === 'sample', 'arabic text stored');

console.log('\n4. Result tracker (with synthetic data)');
db.upsertMatch({
  ...got, status: 'FINISHED', score_home: 2, score_away: 1,
});
const results = require('../src/lib/results');
// We won't call trackMissing (would hit the network). Test computeOutcomes directly.
const out_ = results.computeOutcomes(
  { pred_1x2: '1', correct_score: '2-1', btts_yes: 0.6, over_2_5: 0.6 },
  { score_home: 2, score_away: 1 }
);
assert(out_.out1x2 === 1, '1X2 outcome correct');
assert(out_.outCS === 1, 'correct-score outcome correct');
assert(out_.over25 === 1, 'over 2.5 actual correct');
assert(out_.btts === 1, 'BTTS actual correct');

console.log('\n5. Accuracy stats');
db.recordResult({
  prediction_id: p.id, match_id: sampleId,
  result_home: 2, result_away: 1, total_goals: 3,
  btts_actual: 1, over_2_5_actual: 1, correct_score_actual: '2-1',
  outcome_1x2_correct: 1, outcome_btts_correct: 1,
  outcome_over_correct: 1, outcome_cs_correct: 1,
});
const acc = db.accuracyStats();
assert(acc.totals.predictions_recorded >= 1, 'accuracy stats has data');
assert(acc.totals.one_x_two.hits >= 1, 'one_x_two hit counted');

console.log('\n6. Aggregator league policy');
const agg = require('../src/sources/aggregator');
const okPolicy = agg.applyLeaguePolicy([
  { home_name: 'A', away_name: 'B', utc_date: new Date().toISOString(), league: 'Premier League' },
  { home_name: 'C', away_name: 'D', utc_date: new Date().toISOString(), league: 'Some random u19 league' },
]);
assert(okPolicy.length === 1, 'noise league filtered out');
assert(okPolicy[0].league === 'Premier League', 'kept the top league');

console.log('\n7. Form points');
const fp = engine.computeFormPoints([
  { home: 'Arsenal', away: 'X', scoreHome: 3, scoreAway: 0, status: 'FINISHED' },
  { home: 'Y', away: 'Arsenal', scoreHome: 1, scoreAway: 2, status: 'FINISHED' },
  { home: 'Arsenal', away: 'Z', scoreHome: 1, scoreAway: 1, status: 'FINISHED' },
], 'Arsenal', 5);
assert(fp.length === 3 && fp[0] === 3 && fp[1] === 3 && fp[2] === 1, 'W/D/L → 3/3/1');

console.log(failed === 0 ? '\n✅ All smoke checks passed.' : `\n❌ ${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
