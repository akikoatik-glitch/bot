'use strict';

// Smoke test — offline checks (no Telegram, no network).
//
//   • Engine produces sane probabilities for a known matchup.
//   • Arabic formatter emits every required section.
//   • DB schema migrates & round-trips a prediction.
//   • Daily pipeline helpers work.

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
config.tz = 'Africa/Algiers';

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
assert(r.best_bet && typeof r.best_bet.key === 'string', 'best_bet.key exists');
assert(typeof r.best_bet.prob === 'number' && r.best_bet.prob >= 0, 'best_bet.prob numeric');
assert(typeof r.best_bet.label === 'string' && r.best_bet.label.length > 0, 'best_bet.label present');

console.log('\n1b. Engine corners/cards NOT in best-bet candidates (no real stats)');
// With no cornerData/cardData, best-bet should never be a corner/card market
assert(r.best_bet.key !== 'CRNR_H' && r.best_bet.key !== 'YEL_H',
  'best_bet is not a corner/card market when no real stat data provided');

console.log('\n2. Arabic formatter — full format');
const { formatPrediction, formatCompactPrediction } = require('../src/lib/formatter');
const out = formatPrediction({
  home: 'Arsenal', away: 'Chelsea',
  league: 'Premier League',
  kickoff_iso: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
  result: r,
});
assert(typeof out.text === 'string' && out.text.length > 200, 'full post is long enough');
assert(out.text.includes('توقعات المباراة'), 'header present');
assert(out.text.includes('توقع النتيجة'), '1X2 section present');
assert(out.text.includes('الأهداف'), 'Goals section present');
assert(out.text.includes('النتيجة المتوقعة'), 'Correct score section present');
assert(out.text.includes('مستوى الثقة'), 'Confidence section present');
assert(out.text.includes('ليست نتيجة مضمونة'), 'disclaimer present');
assert(!out.text.includes('Model:'), 'no English Model line');
assert(!out.text.includes('Asia/Riyadh'), 'no Asia/Riyadh timezone in post');
assert(!/٩٠٪/.test(out.text) || /ثقة/.test(out.text), 'confidence labelled, not guarantee');
const plain = out.text.replace(/<\/?[^>]+>/g, '');
assert(!/100٪|100%/.test(plain), 'no absolute "100%" claim');
assert(!/مضمون (بنسبة|100)|مضمونة (بنسبة|100)|حتم[يى]|تأكيد (النتيجة|الفوز)/.test(plain), 'no guarantee-style language');

console.log('\n2b. Arabic formatter — compact format');
const compact = formatCompactPrediction({
  home: 'Arsenal', away: 'Chelsea',
  league: 'Premier League',
  kickoff_iso: new Date(Date.now() + 3 * 3600 * 1000).toISOString(),
  result: { ...r, best_bet: { key: 'O25', label: 'أكثر من 2.5 هدف', prob: 76 } },
  seed: 42,
});
assert(typeof compact.text === 'string' && compact.text.length > 80, 'compact post has content');
assert(!compact.text.includes('Model:'), 'compact has no English Model line');
assert(!compact.text.includes('UTC'), 'compact has no UTC text');
assert(!compact.text.includes('Asia/Riyadh'), 'compact has no Riyadh TZ');
assert(compact.text.includes('🔥'), 'compact has confidence tier emoji');
assert(compact.text.includes('أكثر من 2.5 هدف'), 'compact shows best market label');
assert(compact.text.includes('ليست نتيجة مضمونة') || compact.text.includes('قراءة رياضية'), 'compact has Arabic disclaimer');
assert(!/مضمون (بنسبة|100)|مضمونة (بنسبة|100)|حتم[يى]/.test(compact.text.replace(/<\/?[^>]+>/g, '')), 'compact no guarantee');

console.log('\n2c. Confidence tiers');
const { confidenceTier } = require('../src/lib/formatter');
assert(confidenceTier(95).tier === 'ELITE', '95 is ELITE');
assert(confidenceTier(90).tier === 'ELITE', '90 is ELITE');
assert(confidenceTier(85).tier === 'STRONG', '85 is STRONG');
assert(confidenceTier(80).tier === 'STRONG', '80 is STRONG');
assert(confidenceTier(75).tier === 'GOOD', '75 is GOOD');
assert(confidenceTier(70).tier === 'GOOD', '70 is GOOD');
assert(confidenceTier(65).tier === 'LOW', '65 is LOW');

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

console.log('\n3b. DB — planned-prediction helpers');
const plannedId = 'planned_' + Date.now();
db.upsertMatch({
  id: plannedId, provider: 'test', league: 'La Liga', league_code: 'PD',
  utc_date: new Date(Date.now() + 12 * 3600000).toISOString(), status: 'TIMED',
  home_name: 'Real Madrid', away_name: 'Barcelona',
  score_home: null, score_away: null,
  fetched_at: new Date().toISOString(),
  kickoff_ts: Math.floor(Date.now() / 1000) + 12 * 3600,
});
db.upsertPlannedPrediction({
  match_id: plannedId,
  scheduled_at_ts: Math.floor(Date.now() / 1000) + 9 * 3600, // kickoff − 3h
  published_at: new Date().toISOString(),
  kickoff_ts: Math.floor(Date.now() / 1000) + 12 * 3600,
  league: 'La Liga', home_name: 'Real Madrid', away_name: 'Barcelona',
  conf: 85, p_home: 0.65, p_draw: 0.2, p_away: 0.15,
  xg_home: 2.0, xg_away: 1.1, btts_yes: 0.6, over_2_5: 0.7, under_2_5: 0.3,
  pred_1x2: '1', correct_score: '2-1', correct_score_prob: 0.14,
  best_bet_key: 'O25', best_bet_label: 'أكثر من 2.5 هدف', best_bet_prob: 0.7,
  arabic_text: 'planned', english_text: null, sources_json: { test: true },
  accuracy_score: 90, data_quality: 80,
});
const pp = db.getPredictionByMatch(plannedId);
assert(pp && pp.status === 'planned', 'planned prediction has status=planned');
assert(pp && pp.scheduled_at_ts > 0, 'scheduled_at_ts set');
const due = db.listPlannedDueSoon({ withinSeconds: 24 * 3600, limit: 10 });
assert(due.some(x => x.match_id === plannedId), 'listPlannedDueSoon finds the planned row');
db.markPredictionPublished(plannedId, 12345);
const pp2 = db.getPredictionByMatch(plannedId);
assert(pp2.status === 'published', 'markPredictionPublished updates status');
assert(pp2.channel_message_id === 12345, 'markPredictionPublished updates message_id');

console.log('\n4. Result tracker (with synthetic data)');
db.upsertMatch({
  ...got, status: 'FINISHED', score_home: 2, score_away: 1,
});
const results = require('../src/lib/results');
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

console.log('\n5b. Daily summary stats');
const tz = require('../src/lib/tz');
const dayStart = tz.todayStartEpoch();
const dayEnd = dayStart + 86400;
const sumStats = db.dailySummaryStats(dayStart, dayEnd);
assert(sumStats.total >= 0, 'dailySummaryStats returns total (may be 0 for test rows)');

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

console.log('\n8. Win+loss follow-up replies');
config.safety.dryRun = false;
const wid = 'celebrate_' + Date.now();
db.upsertMatch({
  id: wid, provider: 'test', league: 'Premier League', league_code: 'PL',
  utc_date: new Date(Date.now() - 7200000).toISOString(), status: 'FINISHED',
  home_name: 'HomeX', away_name: 'AwayY', score_home: 3, score_away: 1,
  fetched_at: new Date().toISOString(), kickoff_ts: Math.floor(Date.now() / 1000) - 7200,
});
db.savePrediction({
  match_id: wid, channel_message_id: 777, published_at: new Date().toISOString(),
  kickoff_ts: Math.floor(Date.now() / 1000) - 7200,
  league: 'Premier League', home_name: 'HomeX', away_name: 'AwayY',
  conf: 80, p_home: 0.7, p_draw: 0.2, p_away: 0.1,
  xg_home: 2.2, xg_away: 0.9, btts_yes: 0.7, over_2_5: 0.75, under_2_5: 0.25,
  pred_1x2: '1', best_bet_key: 'O25', best_bet_label: 'أكثر من 2.5 هدف', best_bet_prob: 0.75,
  correct_score: '2-1', correct_score_prob: 0.14, arabic_text: 'sample',
  sources_json: { provider: 'test' }, accuracy_score: 85, data_quality: 80,
});
// A LOSING prediction should now get a loss follow-up reply
const lid = 'noloss_' + Date.now();
db.upsertMatch({
  id: lid, provider: 'test', league: 'Premier League', league_code: 'PL',
  utc_date: new Date(Date.now() - 7200000).toISOString(), status: 'FINISHED',
  home_name: 'HomeA', away_name: 'AwayB', score_home: 0, score_away: 0,
  fetched_at: new Date().toISOString(), kickoff_ts: Math.floor(Date.now() / 1000) - 7200,
});
db.savePrediction({
  match_id: lid, channel_message_id: 778, published_at: new Date().toISOString(),
  kickoff_ts: Math.floor(Date.now() / 1000) - 7200,
  league: 'Premier League', home_name: 'HomeA', away_name: 'AwayB',
  conf: 80, p_home: 0.7, p_draw: 0.2, p_away: 0.1,
  xg_home: 2.2, xg_away: 0.9, btts_yes: 0.7, over_2_5: 0.75, under_2_5: 0.25,
  pred_1x2: '1', best_bet_key: 'O25', best_bet_label: 'أكثر من 2.5 هدف', best_bet_prob: 0.75,
  correct_score: '2-1', correct_score_prob: 0.14, arabic_text: 'sample',
  sources_json: { provider: 'test' }, accuracy_score: 85, data_quality: 80,
});
const sent = [];
const fakeSender = async (chatId, text, opts) => {
  sent.push({ chatId, text, opts });
  return { message_id: 888 };
};
(async () => {
  const r1 = await results.trackMissing({ sender: fakeSender, skipRefresh: true });
  assert(r1.recorded === 2, 'both results recorded, got ' + r1.recorded);
  // New behaviour: ONLY wins get a follow-up reply; losses are silent
  assert(sent.length === 1, 'only one follow-up reply (win), got ' + sent.length);

  // Win reply
  assert(sent[0].opts && sent[0].opts.replyToMessageId === 777, 'win reply targets winning prediction');
  assert(sent[0].text.includes('أكثر من 2.5 هدف'), 'win reply mentions the best bet');
  assert(/🔥|💰|🎯|✅/.test(sent[0].text), 'win reply has celebration emoji');

  // Loss is silent — but still recorded for stats
  assert(!sent.some(x => x.opts && x.opts.replyToMessageId === 778), 'no loss reply is posted');

  const wrow = db.db().prepare('SELECT outcome_best_correct FROM results WHERE match_id=?').get(wid);
  assert(wrow && wrow.outcome_best_correct === 1, 'win result stored as correct');
  const lrow = db.db().prepare('SELECT outcome_best_correct FROM results WHERE match_id=?').get(lid);
  assert(lrow && lrow.outcome_best_correct === 0, 'loss result stored as incorrect');

  // Verify result_state on predictions
  const wp = db.getPredictionByMatch(wid);
  const lp = db.getPredictionByMatch(lid);
  assert(wp && wp.result_state === 'correct', 'winning prediction marked result_state=correct');
  assert(lp && lp.result_state === null, 'losing prediction has no result_state (no reply sent)');

  const r2 = await results.trackMissing({ sender: fakeSender, skipRefresh: true });
  assert(r2.recorded === 0 && r2.celebrated === 0 && r2.followed === 0, 'no duplicate replies on second run');

  console.log('\n9. Phrases library');
  const { pick } = require('../src/lib/phrases');
  const m1 = pick('MORNING_GREETINGS', 0);
  const m2 = pick('MORNING_GREETINGS', 1);
  assert(typeof m1 === 'string' && m1.length > 5, 'morning greeting 0 is a string');
  assert(m1 !== m2 || m1.length > 5, 'morning greetings rotate (or at least work)');
  const w1 = pick('WIN_REPLIES', 0);
  const w2 = pick('LOSS_REPLIES', 0);
  assert(w1 !== w2, 'win and loss replies differ');

  console.log('\n10. Timezone helpers');
  assert(typeof tz.localDateString() === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(tz.localDateString()), 'localDateString is YYYY-MM-DD');
  assert(typeof tz.localTimeString() === 'string' && /^\d{2}:\d{2}$/.test(tz.localTimeString()), 'localTimeString is HH:MM');
  const t = tz.todayStartEpoch();
  assert(typeof t === 'number' && t > 1700000000, 'todayStartEpoch is reasonable');

  console.log('\n11. Daily pipeline (fake sender)');
  const daily = require('../src/lib/daily');
  config.safety.dryRun = false;
  const sent2 = [];
  const fk = async (chatId, text) => { sent2.push({ chatId, text }); return { message_id: 900 + sent2.length }; };

  // Seed a due prediction (publish time already passed) so publishDue posts it
  const dueId = 'due_' + Date.now();
  db.upsertMatch({
    id: dueId, provider: 'test', league: 'Premier League', league_code: 'PL',
    utc_date: new Date(Date.now() - 10 * 3600000).toISOString(), status: 'TIMED',
    home_name: 'DueA', away_name: 'DueB', score_home: null, score_away: null,
    fetched_at: new Date().toISOString(), kickoff_ts: Math.floor(Date.now() / 1000) - 10 * 3600,
  });
  db.upsertPlannedPrediction({
    match_id: dueId, scheduled_at_ts: Math.floor(Date.now() / 1000) - 500,
    published_at: new Date().toISOString(), kickoff_ts: Math.floor(Date.now() / 1000) - 10 * 3600,
    league: 'Premier League', home_name: 'DueA', away_name: 'DueB',
    conf: 80, p_home: 0.5, p_draw: 0.3, p_away: 0.2,
    xg_home: 1.6, xg_away: 1.1, btts_yes: 0.6, over_2_5: 0.6, under_2_5: 0.4,
    pred_1x2: 'X', best_bet_key: 'O25', best_bet_label: 'أكثر من 2.5 هدف', best_bet_prob: 0.7,
    correct_score: '1-1', correct_score_prob: 0.12, arabic_text: '',
    sources_json: { test: true }, accuracy_score: 85, data_quality: 70,
  });
  const pub = await daily.publishDue({ sender: fk });
  assert(pub.published >= 1, 'publishDue posts due predictions');
  assert(sent2.length >= 1, 'due prediction sent');
  const pm = sent2[0];
  assert(pm.text.includes('الموعد'), 'published post has a time line');
  assert(pm.text.includes('أكثر من 2.5 هدف'), 'published post shows best market');
  const pub2 = await daily.publishDue({ sender: fk });
  assert(pub2.published === 0, 'publishDue does not repost the same prediction');

  const gr = await daily.greetingIfNeeded({ sender: fk, force: true });
  assert(gr.sent === true, 'forced morning greeting sent');
  assert(sent2.some(x => /صباح|مرحباً|يوم/.test(x.text)), 'greeting is Arabic morning text');

  const sm = await daily.dailySummary({ sender: fk, force: true });
  assert(sm.sent === true, 'forced daily summary sent');
  const smMsg = sent2.find(x => x.text.includes('نسبة النجاح'));
  assert(smMsg && /✅/.test(smMsg.text), 'summary reports win count');
  assert(smMsg && /❌/.test(smMsg.text), 'summary reports loss count');

  console.log(failed === 0 ? '\n✅ All smoke checks passed.' : `\n❌ ${failed} check(s) failed.`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('  ✗ follow-up crashed: ' + e.message); process.exit(1); });
