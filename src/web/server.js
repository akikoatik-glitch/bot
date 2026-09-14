'use strict';

// Minimal HTTP admin dashboard (Express).
// Provides JSON endpoints for inspection, plus a simple HTML dashboard.

const express = require('express');
const path = require('path');
const config = require('../lib/config');
const db = require('../lib/db');
const log = require('../lib/logger');
const { publishCycle } = require('../publish');
const { trackMissing } = require('../lib/results');

function start() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Static dashboard
  app.use('/admin', express.static(path.join(__dirname, 'public')));
  app.use('/predict', express.static(path.join(config.paths.publicDir, 'predictions')));

  // ── JSON API ──────────────────────────────────────────────────────────────

  app.get('/healthz', (_, res) => res.json({ ok: true, ts: new Date().toISOString() }));

  app.get('/api/status', (_, res) => {
    const acc = db.accuracyStats({ days: 30 });
    res.json({
      bot: {
        paused: config.scheduler.pause,
        min_confidence: config.scheduler.minConfidence,
        max_per_cycle: config.scheduler.maxPredictionsPerCycle,
        publish_interval_minutes: config.scheduler.publishIntervalMinutes,
        api_football: !!config.apiFootball.key,
        football_data: !!config.footballData.key,
        channel_id: config.telegram.channelId,
        admins: config.telegram.adminIds.length,
        last_publish: db.stateGet('last_publish'),
        last_publish_status: db.stateGet('last_publish_status'),
        last_publish_id: db.stateGet('last_publish_id'),
        predictions_today: db.countPredictionsToday(),
        dry_run: config.safety.dryRun,
      },
      accuracy_30d: acc,
      recent_errors: db.recentErrors(10),
    });
  });

  app.get('/api/predictions', (req, res) => {
    const limit = Math.min(200, parseInt(req.query.limit || '50', 10));
    const league = req.query.league || null;
    const only_missing = req.query.only_missing === '1';
    const ps = db.listPredictions({ limit, league, onlyMissingResult: only_missing });
    res.json({ count: ps.length, predictions: ps });
  });

  app.get('/api/upcoming', (req, res) => {
    const limit = Math.min(200, parseInt(req.query.limit || '50', 10));
    const ts = Math.floor(Date.now() / 1000);
    const ms = db.listMatches({ fromTs: ts, statuses: ['TIMED', 'SCHEDULED'], limit });
    res.json({ count: ms.length, matches: ms });
  });

  app.get('/api/accuracy', (req, res) => {
    const days = parseInt(req.query.days || '30', 10);
    res.json(db.accuracyStats({ days }));
  });

  // ── Actions ───────────────────────────────────────────────────────────────

  app.post('/api/pause', (_, res) => { config.scheduler.pause = true; res.json({ ok: true, paused: true }); });
  app.post('/api/resume', (_, res) => { config.scheduler.pause = false; res.json({ ok: true, paused: false }); });
  app.post('/api/set_min', (req, res) => {
    const v = parseInt(req.body && req.body.value, 10);
    if (!isFinite(v)) return res.status(400).json({ error: 'invalid' });
    config.scheduler.minConfidence = v;
    db.stateSet('min_confidence', String(v));
    res.json({ ok: true, min_confidence: v });
  });
  app.post('/api/set_max', (req, res) => {
    const v = parseInt(req.body && req.body.value, 10);
    if (!isFinite(v)) return res.status(400).json({ error: 'invalid' });
    config.scheduler.maxPredictionsPerCycle = v;
    db.stateSet('max_per_cycle', String(v));
    res.json({ ok: true, max_per_cycle: v });
  });
  app.post('/api/set_interval', (req, res) => {
    const v = parseInt(req.body && req.body.value, 10);
    if (!isFinite(v) || v < 15) return res.status(400).json({ error: 'invalid' });
    config.scheduler.publishIntervalMinutes = v;
    db.stateSet('interval_minutes', String(v));
    res.json({ ok: true, interval: v });
  });
  app.post('/api/trigger', async (_, res) => {
    try {
      const r = await publishCycle();
      res.json({ ok: true, ...r });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.post('/api/track_results', async (_, res) => {
    try { const r = await trackMissing(); res.json({ ok: true, ...r }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.delete('/api/prediction/:matchId', (req, res) => {
    const id = req.params.matchId;
    const p = db.getPredictionByMatch(id);
    if (!p) return res.status(404).json({ error: 'not found' });
    db.deletePredictionByMatch(id);
    res.json({ ok: true });
  });

  app.listen(config.web.port, config.web.host, () => {
    log.info('web.listening', { host: config.web.host, port: config.web.port });
  });
}

module.exports = { start };
