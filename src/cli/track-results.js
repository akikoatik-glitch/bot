#!/usr/bin/env node
'use strict';

// One-shot result tracking run.

const log = require('../lib/logger');
const results = require('../lib/results');

(async () => {
  const r = await results.trackMissing();
  log.info('cli.track.done', r);
  process.exit(0);
})();
