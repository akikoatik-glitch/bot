'use strict';

// End-to-end pipeline test (DRY_RUN, no Telegram, no network).
//
//   • Pre-seeds the DB with upcoming matches and recent results.
//   • Stubs the aggregator so it returns the seeded matches.
//   • Runs publishCycle() with DRY_RUN=true.
//   • Verifies the pipeline runs end-to-end and writes predictions.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xwhiz-e2e-'));
process.env.TELEGRAM_BOT_TOKEN = 'TEST_TOKEN';

const config = require('../src/lib/config');
config.paths.dataDir = tmp;
config.paths.logDir = path.join(tmp, 'logs');
config.telegram.botToken = 'TEST_TOKEN';
config.telegram.channelId = '@test';
config.telegram.adminIds = [1];
config.safety.dryRun = false; // we want to test DB persistence path
config.scheduler.pause = false;
config.scheduler.minConfidence = 50;
config.scheduler.maxPredictionsPerCycle = 5;
config.scheduler.hoursAheadMin = 0;
config.scheduler.hoursAheadMax = 48;
config.scheduler.publishIntervalMinutes = 90;
config.apiFootball.key = '';
config.footballData.key = '';

const db = require('../src/lib/db');
db.db();

// Pre-seed matches in the DB
const now = Math.floor(Date.now() / 1000);
const upcoming = [
  { id: 'e2e_1', league: 'Premier League', home_name: 'Arsenal', away_name: 'Chelsea', utc_date: new Date((now + 2 * 3600) * 1000).toISOString(), status: 'TIMED' },
  { id: 'e2e_2', league: 'La Liga', home_name: 'Real Madrid', away_name: 'Barcelona', utc_date: new Date((now + 5 * 3600) * 1000).toISOString(), status: 'TIMED' },
  { id: 'e2e_3', league: 'Bundesliga', home_name: 'Bayern Munich', away_name: 'Borussia Dortmund', utc_date: new Date((now + 24 * 3600) * 1000).toISOString(), status: 'TIMED' },
  { id: 'e2e_4', league: 'Serie A', home_name: 'Inter', away_name: 'AC Milan', utc_date: new Date((now + 30 * 3600) * 1000).toISOString(), status: 'TIMED' },
];
for (const m of upcoming) {
  db.upsertMatch({
    id: m.id, provider: 'test', league: m.league, league_code: null,
    utc_date: m.utc_date, status: m.status,
    home_name: m.home_name, away_name: m.away_name,
    score_home: null, score_away: null,
    fetched_at: new Date().toISOString(),
    kickoff_ts: Math.floor(new Date(m.utc_date).getTime() / 1000),
  });
}

// Stub the aggregator: make fetchDay return the pre-seeded matches.
const agg = require('../src/sources/aggregator');
const stubMatches = upcoming.map(m => ({
  ...m,
  provider: 'test',
  league_code: null,
  home_id: null, away_id: null,
  home_crest: null, away_crest: null,
  score_home: null, score_away: null,
  kickoff_ts: Math.floor(new Date(m.utc_date).getTime() / 1000),
}));
agg.fetchDay = async () => stubMatches;
agg.fetchRange = async () => stubMatches;

// Stub collectRecentMatches inside publish.js to return the pre-seeded DB matches.
const recent = [
  { id: 'r1', league: 'Premier League', home_name: 'Arsenal', away_name: 'Spurs', utc_date: new Date((now - 86400) * 1000).toISOString(), status: 'FINISHED', score_home: 2, score_away: 0, kickoff_ts: now - 86400 },
  { id: 'r2', league: 'Premier League', home_name: 'Liverpool', away_name: 'Arsenal', utc_date: new Date((now - 2 * 86400) * 1000).toISOString(), status: 'FINISHED', score_home: 1, score_away: 1, kickoff_ts: now - 2 * 86400 },
  { id: 'r3', league: 'Premier League', home_name: 'Arsenal', away_name: 'Man City', utc_date: new Date((now - 3 * 86400) * 1000).toISOString(), status: 'FINISHED', score_home: 3, score_away: 1, kickoff_ts: now - 3 * 86400 },
];
global.__XWHIZ_STUB_RECENT__ = recent;
// Stub fetchFormForTeam and the other helpers via publish module
const publish = require('../src/publish');
publish.gatherContextForMatch = async (match) => ({
  standingsOk: true,
  recentResults: recent,
  homeForm: [3, 3, 1],
  awayForm: [0, 3, 1],
  h2h: [],
  odds: null,
});

// Stub Telegram so sendMessage is a no-op (records call but doesn't try to reach Telegram).
const tg = require('../src/lib/telegram');
tg.sendMessage = async (chatId, text) => {
  return { message_id: Math.floor(Math.random() * 1e9), chat: { id: chatId }, text };
};
tg.call = async () => ({ ok: true, result: {} });
tg.getMe = async () => ({ id: 1, username: 'testbot' });
tg.getUpdates = async () => [];

// collectRecentMatches is private to publish.js — we re-implement it as a stub
// via the module's own internals. We re-stub by replacing fetchDay is enough for
// upcoming; for recent, we let the source aggregators return [] since standingsOk=true
// will still produce reasonable predictions.

(async () => {
  let result;
  try {
    result = await publish.publishCycle();
  } catch (e) {
    console.error('publishCycle threw:', e.stack || e.message);
    process.exit(1);
  }
  console.log('\nPublish cycle result:', result);
  const ps = db.listPredictions({ limit: 20 });
  console.log('\nPredictions stored:', ps.length);
  for (const p of ps) {
    console.log(`  • ${p.home_name} 🆚 ${p.away_name} (${p.league}) — conf ${p.conf}, pred ${p.pred_1x2}, CS ${p.correct_score}`);
  }
  if (ps.length < 1) {
    console.error('\n❌ No predictions generated');
    process.exit(1);
  }

  // Verify the arabic text contains the required sections
  const txt = ps[0].arabic_text;
  const required = ['توقع النتيجة', 'الأهداف', 'النتيجة المتوقعة', 'مستوى الثقة', 'ليست نتيجة مضمونة'];
  for (const s of required) {
    if (!txt.includes(s)) { console.error('Missing section:', s); process.exit(1); }
  }

  console.log('\n✅ End-to-end pipeline OK —', ps.length, 'predictions written.');
  process.exit(0);
})();
