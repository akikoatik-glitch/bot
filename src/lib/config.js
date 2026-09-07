'use strict';

// Loads environment variables from .env (no external deps).
// Order: process.env > .env in cwd > .env in telegram-bot dir > .env in project root.
const fs = require('fs');
const path = require('path');

function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const k = line.slice(0, idx).trim();
    let v = line.slice(idx + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (k) out[k] = v;
  }
  return out;
}

function loadDotEnv() {
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(__dirname, '..', '..', '.env'),
    path.resolve(__dirname, '..', '.env'),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const parsed = parseEnvFile(fs.readFileSync(p, 'utf8'));
      for (const [k, v] of Object.entries(parsed)) {
        if (process.env[k] === undefined || process.env[k] === '') {
          process.env[k] = v;
        }
      }
      return p;
    } catch (_) {
      // ignore unreadable env file
    }
  }
  return null;
}

const loaded = loadDotEnv();

function required(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function optional(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === null || v === '') return fallback;
  return v;
}

function intOpt(name, fallback) {
  const v = optional(name, fallback);
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function boolOpt(name, fallback) {
  const v = optional(name, fallback);
  if (v === undefined) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function floatOpt(name, fallback) {
  const v = optional(name, fallback);
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

const config = {
  envLoadedFrom: loaded,
  telegram: {
    botToken: required('TELEGRAM_BOT_TOKEN'),
    channelId: optional('TELEGRAM_CHANNEL_ID', null), // e.g. @channelname or -100xxxxxxxxxx
    adminIds: optional('TELEGRAM_ADMIN_IDS', '')
      .split(',').map(s => s.trim()).filter(Boolean)
      .map(s => parseInt(s, 10)).filter(Number.isFinite),
    apiBase: optional('TELEGRAM_API_BASE', 'https://api.telegram.org'),
    parseMode: optional('TELEGRAM_PARSE_MODE', 'HTML'),
    disableWebPagePreview: boolOpt('TELEGRAM_DISABLE_WEB_PAGE_PREVIEW', true),
  },
  apiFootball: {
    key: optional('API_FOOTBALL_KEY', null),
    base: optional('API_FOOTBALL_BASE', 'https://v3.football.api-sports.io'),
  },
  footballData: {
    key: optional('FOOTBALL_DATA_API_KEY', null),
    base: optional('FOOTBALL_DATA_BASE', 'https://api.football-data.org/v4'),
  },
  oddsApi: {
    key: optional('ODDS_API_KEY', null),
    base: optional('ODDS_API_BASE', 'https://api.the-odds-api.com/v4'),
  },
  scheduler: {
    enabled: boolOpt('SCHEDULER_ENABLED', true),
    publishIntervalMinutes: intOpt('PUBLISH_INTERVAL_MINUTES', 90),
    minConfidence: intOpt('MIN_CONFIDENCE', 65),
    maxPredictionsPerCycle: intOpt('MAX_PREDICTIONS_PER_CYCLE', 4),
    hoursAheadMin: intOpt('HOURS_AHEAD_MIN', 1),
    hoursAheadMax: intOpt('HOURS_AHEAD_MAX', 36),
    pause: boolOpt('SCHEDULER_PAUSE', false),
  },
  leaguePolicy: {
    includeOnly: optional('LEAGUES_INCLUDE', '')
      .split(',').map(s => s.trim()).filter(Boolean),
    exclude: optional('LEAGUES_EXCLUDE', '')
      .split(',').map(s => s.trim()).filter(Boolean),
    minimumPriority: intOpt('LEAGUE_MIN_PRIORITY', 50),
  },
  paths: {
    projectRoot: path.resolve(__dirname, '..', '..'),
    dataDir: path.resolve(__dirname, '..', 'data'),
    logDir: path.resolve(__dirname, '..', 'logs'),
    publicDir: path.resolve(__dirname, '..', 'public'),
  },
  web: {
    enabled: boolOpt('WEB_ENABLED', true),
    host: optional('WEB_HOST', '0.0.0.0'),
    // Railway / Render / Fly inject PORT — it must win over WEB_PORT or the
    // platform healthcheck hits a port nothing listens on and the deploy fails.
    port: Number.isFinite(parseInt(process.env.PORT || '', 10))
      ? parseInt(process.env.PORT || '', 10)
      : intOpt('WEB_PORT', 8080),
    publicBaseUrl: optional('PUBLIC_BASE_URL', null),
  },
  safety: {
    dryRun: boolOpt('DRY_RUN', false),
    neverClaimGuarantee: boolOpt('NEVER_CLAIM_GUARANTEE', true),
  },
  affiliate: {
    melbetLink: optional('MELBET_LINK', 'https://melbet-49771.bar/en?tag=d_5217846m_2170c_&site=5217846&ad=2170&promo=KIKOS77'),
    promoCode: optional('MELBET_PROMO_CODE', 'KIKOS77'),
  },
  logs: {
    level: optional('LOG_LEVEL', 'info'),
  },
};

module.exports = config;
