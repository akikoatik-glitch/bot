'use strict';

// PRIMARY data source when API_FOOTBALL_KEY is set.
// Docs: https://www.api-football.com/documentation-v3
// Endpoints used:
//   GET /fixtures?date=YYYY-MM-DD&timezone=UTC
//   GET /fixtures?league={id}&season={y}&next=10
//   GET /fixtures/{id}                  (live + final score)
//   GET /fixtures/{id}/statistics        (shots, possession, corners, cards)
//   GET /standings?league={id}&season={y}
//   GET /fixtures/{id}/lineups
//   GET /injuries?fixture={id}
//   GET /odds?fixture={id}
//   GET /fixtures/headtohead?h2h={teamId1}-{teamId2}

const { httpGet } = require('./http');
const config = require('../lib/config');

const BASE = config.apiFootball.base;
const KEY = config.apiFootball.key;

function enabled() { return !!KEY; }

function headers() {
  return { 'x-apisports-key': KEY };
}

function pickHomeAway(teams) {
  if (!teams) return null;
  return { home: teams.home, away: teams.away };
}

function toInternal(fx) {
  if (!fx || !fx.fixture || !fx.teams || !fx.league) return null;
  const f = fx.fixture;
  const t = fx.teams;
  const statusMap = {
    'FT': 'FINISHED', 'AET': 'FINISHED', 'PEN': 'FINISHED',
    '1H': 'IN_PLAY', '2H': 'IN_PLAY', 'HT': 'IN_PLAY', 'ET': 'IN_PLAY', 'BT': 'IN_PLAY',
    'NS': 'TIMED', 'TBD': 'TIMED', 'SUSP': 'POSTPONED', 'PST': 'POSTPONED', 'CANC': 'CANCELED',
    'AWD': 'FINISHED', 'WO': 'FINISHED', 'LIVE': 'IN_PLAY',
  };
  const st = statusMap[f.status && f.status.short] || 'TIMED';
  const ft = fx.score && fx.score.fulltime || {};
  return {
    id: 'af_' + String(f.id),
    provider: 'api-football',
    league: fx.league.name || '',
    league_code: fx.league.id ? String(fx.league.id) : null,
    utc_date: f.date,
    status: st,
    home_name: (t.home && t.name) || 'TBD',
    away_name: (t.away && t.name) || 'TBD',
    home_id: t.home && t.id ? String(t.home.id) : null,
    away_id: t.away && t.id ? String(t.away.id) : null,
    home_crest: (t.home && t.logo) || null,
    away_crest: (t.away && t.logo) || null,
    score_home: st === 'FINISHED' && ft.home != null ? ft.home : null,
    score_away: st === 'FINISHED' && ft.away != null ? ft.away : null,
    raw: { fixture: fx.fixture, league: fx.league },
  };
}

async function fetchFixturesByDate(dateStr) {
  if (!enabled()) return [];
  const url = `${BASE}/fixtures?date=${dateStr}&timezone=UTC`;
  const data = await httpGet(url, { headers: headers(), cacheBucket: 'fixtures_today', cacheKey: `af:date:${dateStr}` });
  return (data && data.response ? data.response.map(toInternal).filter(Boolean) : []);
}

async function fetchFixtureById(fixtureId) {
  if (!enabled()) return null;
  const url = `${BASE}/fixtures?id=${fixtureId}`;
  const data = await httpGet(url, { headers: headers(), cacheKey: `af:fix:${fixtureId}` });
  if (!data || !data.response || !data.response.length) return null;
  return toInternal(data.response[0]);
}

async function fetchStatistics(fixtureId) {
  if (!enabled()) return null;
  const url = `${BASE}/fixtures/statistics?fixture=${fixtureId}`;
  const data = await httpGet(url, { headers: headers(), cacheKey: `af:stats:${fixtureId}` });
  return data && data.response ? data.response : null;
}

async function fetchLineups(fixtureId) {
  if (!enabled()) return null;
  const url = `${BASE}/fixtures/lineups?fixture=${fixtureId}`;
  const data = await httpGet(url, { headers: headers(), cacheKey: `af:lineups:${fixtureId}` });
  return data && data.response ? data.response : null;
}

async function fetchInjuries(fixtureId) {
  if (!enabled()) return [];
  try {
    const url = `${BASE}/injuries?fixture=${fixtureId}`;
    const data = await httpGet(url, { headers: headers(), cacheKey: `af:inj:${fixtureId}` });
    return data && data.response ? data.response : [];
  } catch (e) { return []; }
}

async function fetchOdds(fixtureId) {
  if (!enabled()) return null;
  try {
    const url = `${BASE}/odds?fixture=${fixtureId}`;
    const data = await httpGet(url, { headers: headers(), cacheKey: `af:odds:${fixtureId}` });
    return data && data.response && data.response[0] ? data.response[0] : null;
  } catch (e) { return null; }
}

async function fetchHeadToHead(teamAId, teamBId) {
  if (!enabled()) return [];
  try {
    const url = `${BASE}/fixtures/headtohead?h2h=${teamAId}-${teamBId}`;
    const data = await httpGet(url, { headers: headers(), cacheBucket: 'h2h', cacheKey: `af:h2h:${teamAId}-${teamBId}` });
    return data && data.response ? data.response.map(toInternal).filter(Boolean) : [];
  } catch (e) { return []; }
}

async function fetchStandings(leagueId, season) {
  if (!enabled()) return null;
  try {
    const url = `${BASE}/standings?league=${leagueId}&season=${season}`;
    const data = await httpGet(url, { headers: headers(), cacheBucket: 'standings', cacheKey: `af:std:${leagueId}:${season}` });
    if (!data || !data.response || !data.response.length) return null;
    return data.response[0];
  } catch (e) { return null; }
}

module.exports = {
  enabled,
  fetchFixturesByDate, fetchFixtureById, fetchStatistics, fetchLineups,
  fetchInjuries, fetchOdds, fetchHeadToHead, fetchStandings,
};
