'use strict';

// Cron-style scheduler.
// One task runs every PUBLISH_INTERVAL_MINUTES (publishes a new batch).
// One task runs every 30 minutes (refreshes recent scores).
// One task runs every 6 hours (performs a heavier refresh).

const cron = require('node-cron');
const config = require('./lib/config');
const log = require('./lib/logger');
const { publishCycle, refreshRecentResults } = require('./publish');
const results = require('./lib/results');

let _tasks = [];

function stop() {
  for (const t of _tasks) t.stop();
  _tasks = [];
}

function start() {
  stop();
  if (!config.scheduler.enabled) {
    log.warn('scheduler.disabled');
    return;
  }
  const intervalMin = Math.max(15, config.scheduler.publishIntervalMinutes);
  const expr = `*/${intervalMin} * * * *`; // every N minutes
  log.info('scheduler.start', { expr, intervalMin });
  const t1 = cron.schedule(expr, async () => {
    try {
      const r = await publishCycle();
      log.info('scheduler.tick.publish', r);
    } catch (e) {
      log.error('scheduler.tick.publish.error', { err: e.message });
    }
  });
  const t2 = cron.schedule('*/30 * * * *', async () => {
    try {
      await refreshRecentResults();
      await results.trackMissing();
    } catch (e) {
      log.error('scheduler.tick.refresh.error', { err: e.message });
    }
  });
  const t3 = cron.schedule('0 */6 * * *', async () => {
    // hourly housekeeping; no-op for now but reserved for deep refreshes
    try { await refreshRecentResults(); } catch (_) {}
  });
  _tasks = [t1, t2, t3];
}

module.exports = { start, stop };
