#!/usr/bin/env node
'use strict';

// One-shot analysis run (no Telegram publish, no scheduler).
// Prints all eligible predictions for inspection / debugging.

const log = require('../lib/logger');
const config = require('../lib/config');
const db = require('../lib/db');
const { publishCycle } = require('../publish');

(async () => {
  log.info('cli.analyze.start');
  config.scheduler.pause = true; // never auto-publish from this script
  config.safety.dryRun = true;
  const r = await publishCycle();
  log.info('cli.analyze.done', r);
  process.exit(0);
})();
