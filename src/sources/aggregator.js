'use strict';

// Aggregates matches from multiple sources, deduplicates by team-name+date,
// normalises league names, and applies the configured league filter.

const apiFootball = require('./api_football');
const fd = require('./football_data');
const fallback = require('./fallbacks');
const log = require('../lib/logger');
const config = require('../lib/config');

const LEAGUE_ALIASES = {
  'english premier league': 'Premier League',
  'premier league': 'Premier League',
  'spanish la liga': 'La Liga',
  'la liga': 'La Liga',
  'german bundesliga': 'Bundesliga',
  'bundesliga': 'Bundesliga',
  'italian serie a': 'Serie A',
  'serie a': 'Serie A',
  'french ligue 1': 'Ligue 1',
  'ligue 1': 'Ligue 1',
  'uefa champions league': 'UEFA Champions League',
  'uefa europa league': 'UEFA Europa League',
  'uefa conference league': 'UEFA Conference League',
  'eredivisie': 'Eredivisie',
  'primeira liga': 'Primeira Liga',
  'championship': 'Championship',
  'brasileirão': 'Brasileirão',
  'brasileirao': 'Brasileirão',
  'brazilian serie a': 'Brasileirão',
  'süper lig': 'Süper Lig',
  'super lig': 'Süper Lig',
  'saudi pro league': 'Saudi Pro League',
  'mls': 'MLS',
  'major league soccer': 'MLS',
  'j1 league': 'J1 League',
  'k league 1': 'K League 1',
};

function normLeagueName(s) {
  if (!s) return '';
  const lc = String(s).toLowerCase().trim();
  return LEAGUE_ALIASES[lc] || s.trim();
}

function normName(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/\s+/g, ' ')
    .replace(/\s+(fc|cf|afc|sc)$/i, '');
}

// Drop noisy placeholder names.
function isJunkTeam(n) {
  if (!n) return true;
  const lc = String(n).trim().toLowerCase();
  if (!lc) return true;
  if (['to be confirmed', 'tbc', 'to be decided', 'tbd', 'unknown', 'bye', 'undecided'].includes(lc)) return true;
  return /^team [a-z0-9]{6,}$/.test(lc) || /^team [a-f0-9]{8,}$/.test(lc);
}

const NOISE = ['u19', 'u20', 'u21', 'u23', 'youth', 'reserve', 'development', 'academy',
  'amateur', 'veteran', 'women', 'lady'];

function isNoiseLeague(name) {
  const lc = String(name || '').toLowerCase();
  for (const n of NOISE) if (lc.includes(n)) return true;
  return false;
}

// Priority list (mirror fetch_football.js).
const LEAGUE_PRIORITY = [
  'Premier League', 'La Liga', 'Bundesliga', 'Serie A', 'Ligue 1',
  'UEFA Champions League', 'UEFA Europa League', 'UEFA Conference League',
  'Eredivisie', 'Primeira Liga', 'Championship', 'Brasileirão', 'Süper Lig',
  'FA Cup', 'Copa del Rey', 'DFB Pokal', 'Coppa Italia', 'Coupe de France',
  'J1 League', 'K League 1', 'MLS', 'Saudi Pro League',
];
const LP_SET = new Set(LEAGUE_PRIORITY.map(s => s.toLowerCase()));
function leaguePriorityScore(name) {
  if (!name) return 0;
  const lc = String(name).toLowerCase();
  const idx = LEAGUE_PRIORITY.findIndex(x => x.toLowerCase() === lc);
  if (idx >= 0) return 100 - idx;
  if (LP_SET.has(lc)) return 90;
  return 8;
}

function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const m of arr) {
    if (!m || !m.home_name || !m.away_name) continue;
    if (isJunkTeam(m.home_name) || isJunkTeam(m.away_name)) continue;
    const league = normLeagueName(m.league);
    if (isNoiseLeague(league)) continue;
    const leagueClean = league;
    const dateKey = (m.utc_date || '').slice(0, 10);
    const k = `${normName(m.home_name)}|${normName(m.away_name)}|${dateKey}|${leagueClean.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ ...m, league: leagueClean, kickoff_ts: Math.floor(new Date(m.utc_date).getTime() / 1000) });
  }
  return out;
}

function sortByLeague(arr) {
  return arr.slice().sort((a, b) => leaguePriorityScore(b.league) - leaguePriorityScore(a.league));
}

function applyLeaguePolicy(matches) {
  const minP = config.leaguePolicy.minimumPriority;
  const include = config.leaguePolicy.includeOnly.map(s => s.toLowerCase());
  const exclude = config.leaguePolicy.exclude.map(s => s.toLowerCase());
  return matches.filter(m => {
    const lc = (m.league || '').toLowerCase();
    if (exclude.some(e => lc.includes(e))) return false;
    if (include.length && !include.some(i => lc.includes(i))) return false;
    if (leaguePriorityScore(m.league) < minP && include.length === 0) return false;
    return true;
  });
}

async function fetchDay(dateStr) {
  const sources = [];

  // Primary
  if (apiFootball.enabled()) {
    try {
      const ms = await apiFootball.fetchFixturesByDate(dateStr);
      sources.push(...ms);
    } catch (e) {
      log.warn('source.api_football.failed', { date: dateStr, err: e.message });
    }
  }
  // football-data.org (secondary)
  if (fd.enabled()) {
    try {
      const ms = await fd.fetchMatches(dateStr, dateStr);
      sources.push(...ms);
    } catch (e) {
      log.warn('source.fd.failed', { date: dateStr, err: e.message });
    }
  }
  // WorldCup26
  for (const [slug, name] of Object.entries(fallback.WC26_SLUGS)) {
    try {
      const ms = await fallback.fetchWorldCup26Fixtures(slug, name, dateStr.replace(/-/g, ''), dateStr.replace(/-/g, ''));
      sources.push(...ms);
    } catch (e) {
      log.warn('source.wc26.failed', { slug, err: e.message });
    }
  }
  // SportScore
  try {
    const ms = await fallback.fetchSportScoreMatches('football', 200);
    sources.push(...ms);
  } catch (e) {
    log.warn('source.sportscore.failed', { err: e.message });
  }

  const merged = dedupe(sources).filter(m => (m.utc_date || '').slice(0, 10) === dateStr);
  const filtered = applyLeaguePolicy(merged);
  return sortByLeague(filtered);
}

async function fetchRange(fromDate, toDate) {
  const sources = [];
  if (apiFootball.enabled()) {
    for (let d = new Date(fromDate); d <= new Date(toDate); d.setDate(d.getDate() + 1)) {
      try {
        const ds = d.toISOString().slice(0, 10);
        const ms = await apiFootball.fetchFixturesByDate(ds);
        sources.push(...ms);
      } catch (e) { log.warn('source.af.range.failed', { err: e.message }); }
    }
  }
  if (fd.enabled()) {
    try {
      const ms = await fd.fetchMatches(fromDate, toDate);
      sources.push(...ms);
    } catch (e) { log.warn('source.fd.range.failed', { err: e.message }); }
  }
  // football.json — whole season (free)
  try {
    const all = await fallback.fetchFootballJsonAll();
    sources.push(...all.filter(m => {
      const d = (m.utc_date || '').slice(0, 10);
      return d >= fromDate && d <= toDate;
    }));
  } catch (e) { log.warn('source.fj.range.failed', { err: e.message }); }

  const merged = dedupe(sources);
  const filtered = applyLeaguePolicy(merged);
  return sortByLeague(filtered);
}

module.exports = {
  fetchDay, fetchRange,
  dedupe, applyLeaguePolicy, sortByLeague, isJunkTeam, isNoiseLeague,
  leaguePriorityScore, normLeagueName,
};
