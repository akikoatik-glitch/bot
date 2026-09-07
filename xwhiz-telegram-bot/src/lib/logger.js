'use strict';

const fs = require('fs');
const path = require('path');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const cfg = require('./config');

let _level = LEVELS[cfg.logs.level] != null ? LEVELS[cfg.logs.level] : LEVELS.info;

function setLevel(level) {
  if (LEVELS[level] != null) _level = LEVELS[level];
}

function ts() {
  return new Date().toISOString();
}

function write(level, msg, meta) {
  if (LEVELS[level] > _level) return;
  const line = {
    t: ts(),
    level,
    msg,
    ...(meta && typeof meta === 'object' ? { meta } : {}),
  };
  const str = JSON.stringify(line);
  // stdout
  try { process.stdout.write(str + '\n'); } catch (_) {}
  // file (rotated daily)
  try {
    const day = ts().slice(0, 10);
    const dir = cfg.paths.logDir;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `bot-${day}.log`), str + '\n');
  } catch (_) {}
}

module.exports = {
  setLevel,
  error: (msg, meta) => write('error', msg, meta),
  warn: (msg, meta) => write('warn', msg, meta),
  info: (msg, meta) => write('info', msg, meta),
  debug: (msg, meta) => write('debug', msg, meta),
};
