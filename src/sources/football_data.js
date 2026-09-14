'use strict';

// SECONDARY source: football-data.org (free tier, key required for full access).
// Docs: https://www.football-data.org/documentation/quickstart
// Endpoints:
//   GET /matches?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD
//   GET /matches/{id}
//   GET /competitions/{code}/standings
//   GET /matches/{id}/head2head?limit=10

const { httpGet } = require('./http');
const config = require('../lib/config');

const BASE = config.footballData.base;
const KEY = config.footballData.key;
function enabled() { return !!KEY; }
function headers() { return KEY ? { 'X-Auth-Token': KEY } : {}; }

const COMP_CODES = ['PL', 'PD', 'BL1', 'SA', 'FL1', 'DED', 'PPL', 'BSA', 'ELC', 'CL', 'EC', 'SB', 'WC'];

function toInternal(m) {
  if (!m) return null;
  const stMap = {
    'SCHEDULED': 'TIMED', 'TIMED': 'TIMED', 'IN_PLAY': 'IN_PLAY', 'PAUSED': 'IN_PLAY',
    'FINISHED': 'FINISHED', 'POSTPONED': 'POSTPONED', 'CANCELLED': 'CANCELED', 'SUSPENDED': 'POSTPONED',
    'AWARDED': 'FINISHED',
  };
  const st = stMap[m.status] || 'TIMED';
  return {
    id: 'fd_' + String(m.id),
    provider: 'football-data',
    league: (m.competition && m.competition.name) || '',
    league_code: (m.competition && m.competition.code) || null,
    utc_date: m.utcDate,
    status: st,
    home_name: (m.homeTeam && m.homeTeam.name) || 'TBD',
    away_name: (m.awayTeam && m.awayTeam.name) || 'TBD',
    home_id: m.homeTeam && m.homeTeam.id ? String(m.homeTeam.id) : null,
    away_id: m.awayTeam && m.awayTeam.id ? String(m.awayTeam.id) : null,
    home_crest: (m.homeTeam && m.homeTeam.crest) || null,
    away_crest: (m.awayTeam && m.awayTeam.crest) || null,
    score_home: (m.score && m.score.fullTime && m.score.fullTime.home != null) ? m.score.fullTime.home : null,
    score_away: (m.score && m.score.fullTime && m.score.fullTime.away != null) ? m.score.fullTime.away : null,
    raw: { match: m },
  };
}

async function fetchMatches(from, to) {
  if (!enabled()) return [];
  const url = `${BASE}/matches?dateFrom=${from}&dateTo=${to}`;
  const data = await httpGet(url, { headers: headers(), cacheBucket: 'fixtures_today', cacheKey: `fd:mt:${from}:${to}` });
  return (data && data.matches ? data.matches.map(toInternal).filter(Boolean) : []);
}

async function fetchMatch(id) {
  if (!enabled()) return null;
  const url = `${BASE}/matches/${id}`;
  const data = await httpGet(url, { headers: headers(), cacheKey: `fd:m:${id}` });
  return data ? toInternal(data) : null;
}

async function fetchHeadToHead(matchId, limit = 10) {
  if (!enabled()) return [];
  try {
    const url = `${BASE}/matches/${matchId}/head2head?limit=${limit}`;
    const data = await httpGet(url, { headers: headers(), cacheKey: `fd:h2h:${matchId}` });
    if (!data || !data.head2head) return [];
    return data.head2head.map(m => ({
      home: m.homeTeam && m.homeTeam.name,
      away: m.awayTeam && m.awayTeam.name,
      scoreHome: m.score && m.score.fullTime && m.score.fullTime.home,
      scoreAway: m.score && m.score.fullTime && m.score.fullTime.away,
      status: 'FINISHED',
      utcDate: m.utcDate,
    }));
  } catch (e) { return []; }
}

async function fetchStandings(code) {
  if (!enabled()) return null;
  try {
    const url = `${BASE}/competitions/${code}/standings`;
    const data = await httpGet(url, { headers: headers(), cacheBucket: 'standings', cacheKey: `fd:std:${code}` });
    if (!data || !data.standings || !data.standings[0]) return null;
    const t = data.standings[0].table.map(r => ({
      position: r.position,
      team: r.team && r.team.name,
      teamId: r.team && r.team.id,
      crest: r.team && r.team.crest,
      played: r.playedGames,
      won: r.won, draw: r.draw, lost: r.lost,
      gf: r.goalsFor, ga: r.goalsAgainst,
      points: r.points,
      form: r.form || null,
    }));
    return { competition: data.competition && data.competition.name, code, table: t };
  } catch (e) { return null; }
}

module.exports = {
  enabled, COMP_CODES,
  fetchMatches, fetchMatch, fetchHeadToHead, fetchStandings,
};
