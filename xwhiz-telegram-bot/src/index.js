'use strict';

// Entry point. Wires scheduler, telegram commands, web admin dashboard,
// and runs an initial publish cycle.

const log = require('./lib/logger');
const config = require('./lib/config');
const db = require('./lib/db');
const tg = require('./lib/telegram');
const scheduler = require('./scheduler');
const commands = require('./commands');
const web = require('./web/server');
const { publishCycle, refreshRecentResults } = require('./publish');
const seo = require('./seo/generator');

async function main() {
  log.info('bot.start', {
    env: loadedFile(),
    channel: config.telegram.channelId,
    interval: config.scheduler.publishIntervalMinutes,
    dryRun: config.safety.dryRun,
  });

  // Boot DB
  db.db();

  // Validate bot token (non-fatal if it fails on boot)
  try {
    const me = await tg.getMe();
    log.info('bot.me', { username: me.username, id: me.id });
  } catch (e) {
    log.warn('bot.me.failed', { err: e.message });
  }

  // Web dashboard
  if (config.web.enabled) {
    try { web.start(); }
    catch (e) { log.error('web.start.failed', { err: e.message }); }
  }

  // Telegram admin commands (long-poll)
  commands.run().catch(e => log.error('commands.run.failed', { err: e.message }));

  // Initial publish cycle after a brief warm-up
  setTimeout(async () => {
    try {
      log.info('bot.first_cycle.start');
      const r = await publishCycle();
      log.info('bot.first_cycle.done', r);
      try { await seo.regenerate(); } catch (e) { log.warn('seo.init.failed', { err: e.message }); }
    } catch (e) {
      log.error('bot.first_cycle.failed', { err: e.message });
    }
  }, 5000);

  // Periodic refresh
  setInterval(async () => {
    try { await refreshRecentResults(); } catch (e) { log.warn('refresh.failed', { err: e.message }); }
    try { await seo.regenerate(); } catch (e) { log.warn('seo.refresh.failed', { err: e.message }); }
  }, 30 * 60 * 1000);

  // Cron scheduler for publish cycles
  scheduler.start();

  // Graceful shutdown
  const shutdown = async (sig) => {
    log.info('bot.shutdown', { signal: sig });
    try { scheduler.stop(); } catch (_) {}
    setTimeout(() => process.exit(0), 1000);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (r) => {
    log.error('unhandledRejection', { err: String(r) });
    db.logError('unhandledRejection', String(r));
  });
  process.on('uncaughtException', (e) => {
    log.error('uncaughtException', { err: e.message, stack: e.stack });
    db.logError('uncaughtException', e.stack || e.message);
  });
}

function loadedFile() {
  return config.envLoadedFrom || 'env-vars';
}

main().catch(e => {
  log.error('boot.failed', { err: e.message, stack: e.stack });
  process.exit(1);
});
