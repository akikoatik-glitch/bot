'use strict';

// Storage layer — uses the built-in `node:sqlite` (Node 22.5+) so we don't
// require native build tools.
//
// API is shaped to match what the rest of the bot expects:
//   • db()                  — returns the underlying DatabaseSync handle
//   • upsertMatch(m)        — INSERT OR REPLACE/INTO ... ON CONFLICT
//   • getMatch(id)          — single row
//   • listMatches({...})    — array
//   • savePrediction(p)     — INSERT or UPDATE by match_id
//   • getPredictionByMatch / listPredictions / setPredictionMessageId
//     / deletePredictionByMatch
//   • recordResult / listPredictionsMissingResult
//   • accuracyStats({days}) / logError / recentErrors / stateGet / stateSet
//     / countPredictionsToday

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');
const log = require('./logger');
const tz = require('./tz');

if (!fs.existsSync(config.paths.dataDir)) {
  fs.mkdirSync(config.paths.dataDir, { recursive: true });
}
const DB_PATH = path.join(config.paths.dataDir, 'bot.sqlite');
const SCHEMA_VERSION = 1;

let _db = null;

function db() {
  if (_db) return _db;
  _db = new DatabaseSync(DB_PATH);
  // Pragmas — best-effort; ignore failures on platforms that don't support some.
  try { _db.exec('PRAGMA journal_mode = WAL'); } catch (_) {}
  try { _db.exec('PRAGMA foreign_keys = ON'); } catch (_) {}
  migrate(_db);
  return _db;
}

function migrate(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      k TEXT PRIMARY KEY,
      v TEXT
    );

    CREATE TABLE IF NOT EXISTS matches (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      league TEXT,
      league_code TEXT,
      utc_date TEXT NOT NULL,
      status TEXT,
      home_name TEXT NOT NULL,
      away_name TEXT NOT NULL,
      home_id TEXT,
      away_id TEXT,
      home_crest TEXT,
      away_crest TEXT,
      score_home INTEGER,
      score_away INTEGER,
      fetched_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      raw_json TEXT,
      kickoff_ts INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_matches_kickoff ON matches(kickoff_ts);
    CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
    CREATE INDEX IF NOT EXISTS idx_matches_league ON matches(league);

    CREATE TABLE IF NOT EXISTS predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id TEXT NOT NULL UNIQUE,
      channel_message_id INTEGER,
      published_at TEXT NOT NULL,
      kickoff_ts INTEGER NOT NULL,
      league TEXT,
      home_name TEXT NOT NULL,
      away_name TEXT NOT NULL,
      conf INTEGER NOT NULL,
      p_home REAL NOT NULL,
      p_draw REAL NOT NULL,
      p_away REAL NOT NULL,
      xg_home REAL,
      xg_away REAL,
      btts_yes REAL,
      over_2_5 REAL,
      under_2_5 REAL,
      pred_1x2 TEXT,
      correct_score TEXT,
      correct_score_prob REAL,
      arabic_text TEXT NOT NULL,
      english_text TEXT,
      sources_json TEXT,
      accuracy_score REAL,
      data_quality INTEGER,
      FOREIGN KEY(match_id) REFERENCES matches(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_predictions_kickoff ON predictions(kickoff_ts);
    CREATE INDEX IF NOT EXISTS idx_predictions_published ON predictions(published_at);

    CREATE TABLE IF NOT EXISTS results (
      prediction_id INTEGER PRIMARY KEY,
      match_id TEXT NOT NULL,
      result_home INTEGER,
      result_away INTEGER,
      total_goals INTEGER,
      btts_actual INTEGER,
      over_2_5_actual INTEGER,
      correct_score_actual TEXT,
      outcome_1x2_correct INTEGER,
      outcome_btts_correct INTEGER,
      outcome_over_correct INTEGER,
      outcome_cs_correct INTEGER,
      recorded_at TEXT NOT NULL,
      FOREIGN KEY(prediction_id) REFERENCES predictions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_results_recorded ON results(recorded_at);

    CREATE TABLE IF NOT EXISTS errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      scope TEXT,
      message TEXT NOT NULL,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_errors_ts ON errors(ts);

    CREATE TABLE IF NOT EXISTS state (
      k TEXT PRIMARY KEY,
      v TEXT
    );
  `);
  // v2: best-bet columns (idempotent — safe on existing DBs).
  for (const [table, col, type] of [
    ['predictions', 'best_bet_key', 'TEXT'],
    ['predictions', 'best_bet_label', 'TEXT'],
    ['predictions', 'best_bet_prob', 'INTEGER'],
    ['results', 'outcome_best_correct', 'INTEGER'],
    ['results', 'celebration_msg_id', 'INTEGER'],
  ]) {
    try {
      const cols = d.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
      if (!cols.includes(col)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
    } catch (_) { /* best-effort */ }
  }
  // v3: daily-pipeline columns — planned/published lifecycle + result follow-up.
  for (const [table, col, type] of [
    ['predictions', 'status', 'TEXT'],
    ['predictions', 'scheduled_at_ts', 'INTEGER'],
    ['predictions', 'result_state', 'TEXT'],
    ['predictions', 'result_msg_id', 'INTEGER'],
    ['results', 'followup_msg_id', 'INTEGER'],
  ]) {
    try {
      const cols = d.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
      if (!cols.includes(col)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
    } catch (_) { /* best-effort */ }
  }
  d.prepare(`INSERT OR REPLACE INTO schema_meta(k,v) VALUES('version',?)`).run(String(SCHEMA_VERSION));
}

// ─── helpers ────────────────────────────────────────────────────────────────

function upsertMatch(m) {
  const d = db();
  const sql = `
    INSERT INTO matches (id, provider, league, league_code, utc_date, status,
      home_name, away_name, home_id, away_id, home_crest, away_crest,
      score_home, score_away, fetched_at, updated_at, raw_json, kickoff_ts)
    VALUES (@id, @provider, @league, @league_code, @utc_date, @status,
      @home_name, @away_name, @home_id, @away_id, @home_crest, @away_crest,
      @score_home, @score_away, @fetched_at, @updated_at, @raw_json, @kickoff_ts)
    ON CONFLICT(id) DO UPDATE SET
      provider=excluded.provider,
      league=excluded.league,
      league_code=excluded.league_code,
      utc_date=excluded.utc_date,
      status=excluded.status,
      home_name=excluded.home_name,
      away_name=excluded.away_name,
      home_id=excluded.home_id,
      away_id=excluded.away_id,
      home_crest=excluded.home_crest,
      away_crest=excluded.away_crest,
      score_home=excluded.score_home,
      score_away=excluded.score_away,
      updated_at=excluded.updated_at,
      raw_json=excluded.raw_json,
      kickoff_ts=excluded.kickoff_ts
  `;
  d.prepare(sql).run({
    id: m.id,
    provider: m.provider || 'unknown',
    league: m.league || null,
    league_code: m.league_code || null,
    utc_date: m.utc_date,
    status: m.status || 'TIMED',
    home_name: m.home_name,
    away_name: m.away_name,
    home_id: m.home_id || null,
    away_id: m.away_id || null,
    home_crest: m.home_crest || null,
    away_crest: m.away_crest || null,
    score_home: m.score_home != null ? m.score_home : null,
    score_away: m.score_away != null ? m.score_away : null,
    fetched_at: m.fetched_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    raw_json: m.raw_json ? JSON.stringify(m.raw_json) : null,
    kickoff_ts: m.kickoff_ts || Math.floor(new Date(m.utc_date).getTime() / 1000),
  });
}

function getMatch(id) {
  return db().prepare(`SELECT * FROM matches WHERE id=?`).get(id);
}

function listMatches({ fromTs, toTs, statuses, leagueLike, limit = 200 } = {}) {
  const conds = [];
  const args = [];
  if (fromTs != null) { conds.push('kickoff_ts >= ?'); args.push(fromTs); }
  if (toTs != null) { conds.push('kickoff_ts <= ?'); args.push(toTs); }
  if (statuses && statuses.length) {
    conds.push(`status IN (${statuses.map(() => '?').join(',')})`);
    args.push(...statuses);
  }
  if (leagueLike) { conds.push('lower(league) LIKE ?'); args.push('%' + leagueLike.toLowerCase() + '%'); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  args.push(limit);
  return db().prepare(`SELECT * FROM matches ${where} ORDER BY kickoff_ts ASC LIMIT ?`).all(...args);
}

function savePrediction(p) {
  const sql = `
    INSERT INTO predictions (match_id, channel_message_id, published_at, kickoff_ts,
      league, home_name, away_name, conf, p_home, p_draw, p_away,
      xg_home, xg_away, btts_yes, over_2_5, under_2_5,
      pred_1x2, correct_score, correct_score_prob,
      best_bet_key, best_bet_label, best_bet_prob,
      arabic_text, english_text, sources_json, accuracy_score, data_quality)
    VALUES (@match_id, @channel_message_id, @published_at, @kickoff_ts,
      @league, @home_name, @away_name, @conf, @p_home, @p_draw, @p_away,
      @xg_home, @xg_away, @btts_yes, @over_2_5, @under_2_5,
      @pred_1x2, @correct_score, @correct_score_prob,
      @best_bet_key, @best_bet_label, @best_bet_prob,
      @arabic_text, @english_text, @sources_json, @accuracy_score, @data_quality)
    ON CONFLICT(match_id) DO UPDATE SET
      channel_message_id=COALESCE(excluded.channel_message_id, predictions.channel_message_id),
      published_at=excluded.published_at,
      conf=excluded.conf,
      p_home=excluded.p_home,
      p_draw=excluded.p_draw,
      p_away=excluded.p_away,
      xg_home=excluded.xg_home,
      xg_away=excluded.xg_away,
      btts_yes=excluded.btts_yes,
      over_2_5=excluded.over_2_5,
      under_2_5=excluded.under_2_5,
      pred_1x2=excluded.pred_1x2,
      correct_score=excluded.correct_score,
      correct_score_prob=excluded.correct_score_prob,
      best_bet_key=excluded.best_bet_key,
      best_bet_label=excluded.best_bet_label,
      best_bet_prob=excluded.best_bet_prob,
      arabic_text=excluded.arabic_text,
      english_text=excluded.english_text,
      sources_json=excluded.sources_json,
      accuracy_score=excluded.accuracy_score,
      data_quality=excluded.data_quality
  `;
  const info = db().prepare(sql).run({
    match_id: p.match_id,
    channel_message_id: p.channel_message_id || null,
    published_at: p.published_at || new Date().toISOString(),
    kickoff_ts: p.kickoff_ts,
    league: p.league || null,
    home_name: p.home_name,
    away_name: p.away_name,
    conf: p.conf,
    p_home: p.p_home,
    p_draw: p.p_draw,
    p_away: p.p_away,
    xg_home: p.xg_home != null ? p.xg_home : null,
    xg_away: p.xg_away != null ? p.xg_away : null,
    btts_yes: p.btts_yes != null ? p.btts_yes : null,
    over_2_5: p.over_2_5 != null ? p.over_2_5 : null,
    under_2_5: p.under_2_5 != null ? p.under_2_5 : null,
    pred_1x2: p.pred_1x2 || null,
    correct_score: p.correct_score || null,
    correct_score_prob: p.correct_score_prob != null ? p.correct_score_prob : null,
    best_bet_key: p.best_bet_key || null,
    best_bet_label: p.best_bet_label || null,
    best_bet_prob: p.best_bet_prob != null ? p.best_bet_prob : null,
    arabic_text: p.arabic_text,
    english_text: p.english_text || null,
    sources_json: p.sources_json ? JSON.stringify(p.sources_json) : null,
    accuracy_score: p.accuracy_score != null ? p.accuracy_score : null,
    data_quality: p.data_quality != null ? p.data_quality : null,
  });
  return info.lastInsertRowid || info.changes;
}

// Last N published best-bet market keys (variety guard input).
function recentBestBetKeys(limit = 10) {
  try {
    return db().prepare(
      `SELECT best_bet_key FROM predictions WHERE best_bet_key IS NOT NULL ORDER BY id DESC LIMIT ?`
    ).all(limit).map(r => r.best_bet_key).filter(Boolean);
  } catch (_) {
    return [];
  }
}

function getPredictionByMatch(matchId) {
  return db().prepare(`SELECT * FROM predictions WHERE match_id=?`).get(matchId);
}

function listPredictions({ fromTs, toTs, league, onlyUnpublished, onlyMissingResult, limit = 100 } = {}) {
  const conds = [];
  const args = [];
  if (fromTs != null) { conds.push('p.kickoff_ts >= ?'); args.push(fromTs); }
  if (toTs != null) { conds.push('p.kickoff_ts <= ?'); args.push(toTs); }
  if (league) { conds.push('lower(p.league) LIKE ?'); args.push('%' + league.toLowerCase() + '%'); }
  if (onlyUnpublished) conds.push('p.channel_message_id IS NULL');
  if (onlyMissingResult) conds.push('NOT EXISTS (SELECT 1 FROM results r WHERE r.prediction_id = p.id)');
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  args.push(limit);
  return db().prepare(`SELECT p.* FROM predictions p ${where} ORDER BY p.kickoff_ts ASC LIMIT ?`).all(...args);
}

function setPredictionMessageId(matchId, channelMessageId) {
  db().prepare(`UPDATE predictions SET channel_message_id=? WHERE match_id=?`).run(channelMessageId, matchId);
}

// Marks a result as celebrated (win-reply sent) so we never reply twice.
function markCelebrated(predictionId, messageId) {
  try {
    db().prepare(`UPDATE results SET celebration_msg_id=? WHERE prediction_id=?`).run(messageId, predictionId);
  } catch (_) { /* best-effort */ }
}

// Marks a LOSS follow-up as sent so we never reply twice.
function markFollowupSent(predictionId, messageId) {
  try {
    db().prepare(`UPDATE results SET followup_msg_id=? WHERE prediction_id=?`).run(messageId, predictionId);
  } catch (_) { /* best-effort */ }
}

function deletePredictionByMatch(matchId) {
  db().prepare(`DELETE FROM predictions WHERE match_id=?`).run(matchId);
}

function recordResult(r) {
  const sql = `
    INSERT INTO results (prediction_id, match_id, result_home, result_away, total_goals,
      btts_actual, over_2_5_actual, correct_score_actual,
      outcome_1x2_correct, outcome_btts_correct, outcome_over_correct, outcome_cs_correct,
      outcome_best_correct,
      recorded_at)
    VALUES (@prediction_id, @match_id, @result_home, @result_away, @total_goals,
      @btts_actual, @over_2_5_actual, @correct_score_actual,
      @outcome_1x2_correct, @outcome_btts_correct, @outcome_over_correct, @outcome_cs_correct,
      @outcome_best_correct,
      @recorded_at)
    ON CONFLICT(prediction_id) DO UPDATE SET
      result_home=excluded.result_home,
      result_away=excluded.result_away,
      total_goals=excluded.total_goals,
      btts_actual=excluded.btts_actual,
      over_2_5_actual=excluded.over_2_5_actual,
      correct_score_actual=excluded.correct_score_actual,
      outcome_1x2_correct=excluded.outcome_1x2_correct,
      outcome_btts_correct=excluded.outcome_btts_correct,
      outcome_over_correct=excluded.outcome_over_correct,
      outcome_cs_correct=excluded.outcome_cs_correct,
      outcome_best_correct=excluded.outcome_best_correct,
      recorded_at=excluded.recorded_at
  `;
  db().prepare(sql).run({
    prediction_id: r.prediction_id,
    match_id: r.match_id,
    result_home: r.result_home != null ? r.result_home : null,
    result_away: r.result_away != null ? r.result_away : null,
    total_goals: r.total_goals != null ? r.total_goals : null,
    btts_actual: r.btts_actual != null ? r.btts_actual : null,
    over_2_5_actual: r.over_2_5_actual != null ? r.over_2_5_actual : null,
    correct_score_actual: r.correct_score_actual || null,
    outcome_1x2_correct: r.outcome_1x2_correct != null ? r.outcome_1x2_correct : null,
    outcome_btts_correct: r.outcome_btts_correct != null ? r.outcome_btts_correct : null,
    outcome_over_correct: r.outcome_over_correct != null ? r.outcome_over_correct : null,
    outcome_cs_correct: r.outcome_cs_correct != null ? r.outcome_cs_correct : null,
    outcome_best_correct: r.outcome_best_correct != null ? r.outcome_best_correct : null,
    recorded_at: r.recorded_at || new Date().toISOString(),
  });
}

function listPredictionsMissingResult({ fromTs, toTs, limit = 200 } = {}) {
  const conds = [
    'NOT EXISTS (SELECT 1 FROM results r WHERE r.prediction_id = p.id)',
    'p.channel_message_id IS NOT NULL',
    "(p.status = 'published' OR p.status IS NULL)",
    `p.kickoff_ts < ?`,
  ];
  const args = [Math.floor(Date.now() / 1000) - 60 * 60];
  if (fromTs != null) { conds.push('p.kickoff_ts >= ?'); args.push(fromTs); }
  if (toTs != null) { conds.push('p.kickoff_ts <= ?'); args.push(toTs); }
  args.push(limit);
  return db().prepare(
    `SELECT p.*, m.status, m.score_home, m.score_away FROM predictions p
     LEFT JOIN matches m ON m.id = p.match_id
     WHERE ${conds.join(' AND ')}
     ORDER BY p.kickoff_ts ASC LIMIT ?`
  ).all(...args);
}

// ─── daily-pipeline helpers ────────────────────────────────────────────────

// Upsert a *planned* prediction (not yet sent to Telegram). Reuses
// savePrediction() for the full market data, then stamps scheduling fields.
function upsertPlannedPrediction(p) {
  savePrediction(p);
  db().prepare(`
    UPDATE predictions SET status='planned', scheduled_at_ts=?
    WHERE match_id=?
  `).run(p.scheduled_at_ts != null ? p.scheduled_at_ts : null, p.match_id);
}

// All planned predictions in a kickoff window (for greeting/preview lists).
function listPlanned({ fromScheduledTs, toScheduledTs, limit = 100 } = {}) {
  const conds = ["p.status='planned'"];
  const args = [];
  if (fromScheduledTs != null) { conds.push('p.scheduled_at_ts >= ?'); args.push(fromScheduledTs); }
  if (toScheduledTs != null) { conds.push('p.scheduled_at_ts <= ?'); args.push(toScheduledTs); }
  args.push(limit);
  return db().prepare(
    `SELECT p.* FROM predictions p
     WHERE ${conds.join(' AND ')}
     ORDER BY p.scheduled_at_ts ASC LIMIT ?`
  ).all(...args);
}

// Planned predictions whose publish time has arrived and that were never
// actually sent to the channel.
function listPlannedDueSoon({ withinSeconds = 300, limit = 20 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return db().prepare(
    `SELECT p.* FROM predictions p
     WHERE p.status='planned' AND p.channel_message_id IS NULL
       AND p.scheduled_at_ts IS NOT NULL AND p.scheduled_at_ts <= ?
     ORDER BY p.scheduled_at_ts ASC LIMIT ?`
  ).all(now + withinSeconds, limit);
}

// Mark a planned prediction as actually published on the channel.
function markPredictionPublished(matchId, messageId) {
  db().prepare(`
    UPDATE predictions SET status='published', channel_message_id=?,
      published_at=? WHERE match_id=?
  `).run(messageId, new Date().toISOString(), matchId);
}

// Human-facing result state for follow-up / summaries.
function setPredictionResultState(matchId, state) {
  db().prepare(`UPDATE predictions SET result_state=? WHERE match_id=?`).run(state, matchId);
}

// Published predictions with no result row yet (matches may still be live).
function listPublishedMissingResult({ limit = 200 } = {}) {
  return db().prepare(
    `SELECT p.* FROM predictions p
     WHERE p.status='published' AND p.channel_message_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM results r WHERE r.prediction_id = p.id)
     ORDER BY p.kickoff_ts ASC LIMIT ?`
  ).all(limit);
}

function accuracyStats({ days } = {}) {
  const since = days ? Math.floor(Date.now() / 1000) - days * 86400 : null;
  const args = [];
  let where = '';
  if (since != null) {
    where = `WHERE r.recorded_at >= datetime(?, 'unixepoch')`;
    args.push(since);
  }
  const overall = db().prepare(`
    SELECT COUNT(*) AS n,
      SUM(outcome_1x2_correct) AS h1x2,
      SUM(outcome_btts_correct) AS hbtts,
      SUM(outcome_over_correct) AS hover,
      SUM(outcome_cs_correct) AS hcs,
      SUM(outcome_best_correct) AS hbest
    FROM results r ${where}
  `).get(...args) || { n: 0, h1x2: 0, hbtts: 0, hover: 0, hcs: 0, hbest: 0 };

  const byLeague = db().prepare(`
    SELECT p.league AS league,
      COUNT(*) AS n,
      SUM(r.outcome_1x2_correct) AS h1x2,
      SUM(r.outcome_btts_correct) AS hbtts,
      SUM(r.outcome_over_correct) AS hover
    FROM results r JOIN predictions p ON p.id = r.prediction_id
    ${where ? where + ' AND' : 'WHERE'} 1=1
    GROUP BY p.league
    ORDER BY n DESC
  `).all(...args);

  const byConf = db().prepare(`
    SELECT
      CASE
        WHEN p.conf >= 80 THEN '80-100'
        WHEN p.conf >= 70 THEN '70-79'
        WHEN p.conf >= 60 THEN '60-69'
        ELSE '0-59'
      END AS bucket,
      COUNT(*) AS n,
      SUM(r.outcome_1x2_correct) AS h1x2
    FROM results r JOIN predictions p ON p.id = r.prediction_id
    ${where ? where + ' AND' : 'WHERE'} 1=1
    GROUP BY bucket
    ORDER BY bucket DESC
  `).all(...args);

  function pct(num, den) {
    if (!den) return 0;
    return Math.round((num / den) * 1000) / 10;
  }

  return {
    totals: {
      predictions_recorded: overall.n || 0,
      one_x_two: { hits: overall.h1x2 || 0, total: overall.n || 0, pct: pct(overall.h1x2, overall.n) },
      btts: { hits: overall.hbtts || 0, total: overall.n || 0, pct: pct(overall.hbtts, overall.n) },
      over_under: { hits: overall.hover || 0, total: overall.n || 0, pct: pct(overall.hover, overall.n) },
      correct_score: { hits: overall.hcs || 0, total: overall.n || 0, pct: pct(overall.hcs, overall.n) },
      best_bet: { hits: overall.hbest || 0, total: overall.n || 0, pct: pct(overall.hbest, overall.n) },
    },
    by_league: byLeague.map(r => ({
      league: r.league, n: r.n,
      one_x_two_pct: pct(r.h1x2, r.n),
      btts_pct: pct(r.hbtts, r.n),
      over_pct: pct(r.hover, r.n),
    })),
    by_confidence: byConf.map(r => ({
      bucket: r.bucket, n: r.n,
      one_x_two_pct: pct(r.h1x2, r.n),
    })),
  };
}

function logError(scope, message, detail) {
  try {
    db().prepare(`INSERT INTO errors(ts, scope, message, detail) VALUES(?,?,?,?)`)
      .run(new Date().toISOString(), scope || null, message || '', detail ? String(detail).slice(0, 8000) : null);
  } catch (e) {
    log.error('db.logError failed', { e: e.message });
  }
}

function stateSet(k, v) {
  db().prepare(`INSERT INTO state(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(k, String(v));
}
function stateGet(k) {
  const r = db().prepare(`SELECT v FROM state WHERE k=?`).get(k);
  return r ? r.v : null;
}

function recentErrors(limit = 20) {
  return db().prepare(`SELECT * FROM errors ORDER BY id DESC LIMIT ?`).all(limit);
}

function countPredictionsToday() {
  const ts = tz.todayStartEpoch();
  return db().prepare(`SELECT COUNT(*) AS n FROM predictions WHERE published_at >= datetime(?, 'unixepoch')`).get(ts).n;
}

// Daily recap: predictions published today (local tz) with their results.
function dailySummaryStats(fromEpoch, toEpoch) {
  const d = db();
  const row = d.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN r.outcome_best_correct IS NOT NULL AND r.outcome_best_correct = 1 THEN 1 ELSE 0 END) AS best_wins,
      SUM(CASE WHEN r.outcome_best_correct IS NOT NULL AND r.outcome_best_correct = 0 THEN 1 ELSE 0 END) AS best_losses,
      SUM(CASE WHEN r.outcome_best_correct IS NULL AND p.best_bet_key IS NULL AND r.outcome_1x2_correct = 1 THEN 1 ELSE 0 END) AS legacy_wins,
      SUM(CASE WHEN r.outcome_best_correct IS NULL AND p.best_bet_key IS NULL AND r.outcome_1x2_correct = 0 THEN 1 ELSE 0 END) AS legacy_losses
    FROM predictions p
    JOIN results r ON r.prediction_id = p.id
    WHERE (p.status='published' OR p.status IS NULL)
      AND p.published_at >= datetime(?,'unixepoch')
      AND p.published_at < datetime(?,'unixepoch')
  `).get(fromEpoch, toEpoch) || { total: 0, best_wins: 0, best_losses: 0, legacy_wins: 0, legacy_losses: 0 };
  return {
    total: row.total || 0,
    wins: (row.best_wins || 0) + (row.legacy_wins || 0),
    losses: (row.best_losses || 0) + (row.legacy_losses || 0),
  };
}

// Predictions whose outcomes were decided today (for the summary when results
// arrive late). Returns rows joined with result data.
function listResultsByDay(fromEpoch, toEpoch, limit = 60) {
  return db().prepare(`
    SELECT p.match_id, p.home_name, p.away_name, p.league, p.conf,
      p.best_bet_key, p.best_bet_label, p.best_bet_prob,
      r.result_home, r.result_away, r.outcome_best_correct, r.outcome_1x2_correct
    FROM predictions p JOIN results r ON r.prediction_id = p.id
    WHERE p.kickoff_ts >= ? AND p.kickoff_ts < ?
    ORDER BY p.kickoff_ts ASC LIMIT ?
  `).all(fromEpoch, toEpoch, limit);
}

function lastSuccessful(kind) {
  return stateGet(`last_success_${kind}`);
}

module.exports = {
  db,
  upsertMatch, getMatch, listMatches,
  savePrediction, getPredictionByMatch, listPredictions, setPredictionMessageId, deletePredictionByMatch,
  recentBestBetKeys, markCelebrated, markFollowupSent,
  upsertPlannedPrediction, listPlanned, listPlannedDueSoon,
  markPredictionPublished, setPredictionResultState, listPublishedMissingResult,
  recordResult, listPredictionsMissingResult,
  accuracyStats, logError, recentErrors,
  stateGet, stateSet,
  countPredictionsToday, lastSuccessful,
  dailySummaryStats, listResultsByDay,
};
