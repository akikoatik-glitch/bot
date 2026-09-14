'use strict';

// Scheduler.
//   • Every 5 minutes  — daily.tick(): plan day → morning greeting → publish
//                        anything due → evening summary (guarded, cheap).
//   • Every 15 minutes — refresh recent scores + follow up on match results
//                        (win/loss replies).
//   • Every 6 hours    — heavier refresh (housekeeping).

const cron = require('node-cron');
const config = require('./lib/config');
const log = require('./lib/logger');
const daily = require('./lib/daily');
const { refreshRecentResults } = require('./publish');

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
  log.info('scheduler.start', {
    tz: config.tz,
    greeting: config.daily.greetingTime,
    summary: config.daily.summaryTime,
    hoursBefore: config.daily.predictHoursBefore,
    confGood: config.daily.confGood,
  });

  const t1 = cron.schedule('*/5 * * * *', async () => {
    try {
      const r = await daily.tick();
      log.info('scheduler.tick.daily', r);
    } catch (e) {
      log.error('scheduler.tick.daily.error', { err: e.message });
    }
  });

  const t2 = cron.schedule('*/15 * * * *', async () => {
    try {
      await refreshRecentResults();
      const r = await daily.trackResults();
      log.info('scheduler.tick.results', r);
    } catch (e) {
      log.error('scheduler.tick.results.error', { err: e.message });
    }
  });

  const t3 = cron.schedule('0 */6 * * *', async () => {
    try { await refreshRecentResults(); } catch (_) {}
  });

  _tasks = [t1, t2, t3];
}

module.exports = { start, stop };