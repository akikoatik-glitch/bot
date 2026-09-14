'use strict';

// FREE FALLBACKS (zero-key):
//   • SportScore (https://sportscore.com) — daily fixtures for many leagues
//   • WorldCup26.ir — covers England + Spain
//   • openfootball/football.json — public-domain season JSON, all top-5 leagues
//
// These are the SECONDARY sources used when API-Football is not available.

const { httpGet } = require('./http');

// ── SportScore ─────────────────────────────────────────────────────────────

const SS_BASE = 'https://sportscore.com/api/widget/matches';

async function fetchSportScoreMatches(sport = 'football', limit = 120) {
  const url = `${SS_BASE}/?sport=${sport}&limit=${limit}`;
  try {
    const data = await httpGet(url, { cacheBucket: 'fixtures_today', cacheKey: `ss:m:${sport}:${limit}` });
    if (!data || !data.matches) return [];
    return data.matches.map(m => {
      const stMap = { 'finished': 'FINISHED', 'alive': 'IN_PLAY', 'ns': 'TIMED',
        'postponed': 'POSTPONED', 'cancelled': 'CANCELED' };
      return {
        id: m.url ? 'ss_' + m.url.replace(/\/$/, '').split('/').pop() : null,
        provider: 'sportscore',
        league: m.competition || '',
        league_code: null,
        utc_date: m.time || new Date().toISOString(),
        status: stMap[m.status] || 'TIMED',
        home_name: m.home || '',
        away_name: m.away || '',
        home_id: null, away_id: null,
        home_crest: m.home_logo || null, away_crest: m.away_logo || null,
        score_home: m.status === 'finished' ? (parseInt(m.home_score) || null) : null,
        score_away: m.status === 'finished' ? (parseInt(m.away_score) || null) : null,
        raw: { ss: m },
      };
    }).filter(Boolean);
  } catch (e) { return []; }
}

// ── WorldCup26 ─────────────────────────────────────────────────────────────

const WC26_BASE = 'https://worldcup26.ir/get/soccer';
const WC26_SLUGS = {
  'eng.1': 'Premier League',
  'eng.2': 'Championship',
  'esp.1': 'La Liga',
};

async function fetchWorldCup26Fixtures(slug, leagueName, from, to) {
  const url = `${WC26_BASE}/${slug}/fixtures?from=${from}&to=${to}`;
  try {
    const data = await httpGet(url, { cacheBucket: 'fixtures_today', cacheKey: `wc26:fx:${slug}:${from}:${to}` });
    if (!data || !data.events) return [];
    const out = [];
    for (const ev of data.events) {
      const c = ev.competitions && ev.competitions[0];
      if (!c) continue;
      const hm = (c.competitors || []).find(x => x.homeAway === 'home');
      const aw = (c.competitors || []).find(x => x.homeAway === 'away');
      if (!hm || !aw) continue;
      const homeName = (hm.team && hm.team.name) || '';
      const awayName = (aw.team && aw.team.name) || '';
      if (!homeName || !awayName) continue;
      const short = (c.status && c.status.type && c.status.type.shortDetail) || '';
      const stMap = { 'FT': 'FINISHED', 'AET': 'FINISHED', 'PEN': 'FINISHED',
        'HT': 'IN_PLAY', '1H': 'IN_PLAY', '2H': 'IN_PLAY', 'ET': 'IN_PLAY',
        'Scheduled': 'TIMED', 'Postponed': 'POSTPONED', 'Cancelled': 'CANCELED',
        'Delayed': 'POSTPONED' };
      let st = stMap[short] || 'TIMED';
      if (/^[0-9]+'$/.test(short) || short === 'Halftime') st = 'IN_PLAY';
      let sh = null, sa = null;
      if (st === 'FINISHED') {
        sh = parseInt(hm.score); sa = parseInt(aw.score);
        if (isNaN(sh) || isNaN(sa)) { sh = null; sa = null; }
      }
      out.push({
        id: 'wc26_' + String(ev.id),
        provider: 'worldcup26',
        league: leagueName,
        league_code: slug,
        utc_date: ev.date || new Date().toISOString(),
        status: st,
        home_name: homeName,
        away_name: awayName,
        home_id: hm.team && hm.team.id ? String(hm.team.id) : null,
        away_id: aw.team && aw.team.id ? String(aw.team.id) : null,
        home_crest: (hm.team && hm.team.logo) || null,
        away_crest: (aw.team && aw.team.logo) || null,
        score_home: sh,
        score_away: sa,
        raw: { wc26: ev },
      });
    }
    return out;
  } catch (e) { return []; }
}

async function fetchWorldCup26Standings(slug) {
  try {
    const data = await httpGet(`${WC26_BASE}/${slug}/standings`, { cacheBucket: 'standings', cacheKey: `wc26:std:${slug}` });
    return data;
  } catch (e) { return null; }
}

// ── openfootball/football.json ─────────────────────────────────────────────

const FOOTBALL_JSON_BASE = 'https://raw.githubusercontent.com/openfootball/football.json/master/2026-27';
const FOOTBALL_JSON_LEAGUES = [
  { slug: 'en.1', name: 'Premier League', code: 'PL' },
  { slug: 'es.1', name: 'La Liga', code: 'PD' },
  { slug: 'de.1', name: 'Bundesliga', code: 'BL1' },
  { slug: 'it.1', name: 'Serie A', code: 'SA' },
  { slug: 'fr.1', name: 'Ligue 1', code: 'FL1' },
  { slug: 'en.2', name: 'Championship', code: 'ELC' },
  { slug: 'nl.1', name: 'Eredivisie', code: 'DED' },
  { slug: 'pt.1', name: 'Primeira Liga', code: 'PPL' },
];

async function fetchFootballJsonLeague(slug, name, code) {
  const url = `${FOOTBALL_JSON_BASE}/${slug}.json`;
  try {
    const data = await httpGet(url, { cacheBucket: 'fixtures_upcoming', cacheKey: `fj:${slug}` });
    if (!data || !data.matches) return [];
    const out = [];
    for (const m of data.matches) {
      const home = m.team1 || '', away = m.team2 || '';
      if (!home || !away) continue;
      const ft = m.score && m.score.ft;
      const status = (Array.isArray(ft) && ft.length === 2) ? 'FINISHED' : 'TIMED';
      let sh = null, sa = null;
      if (status === 'FINISHED') {
        sh = parseInt(ft[0], 10); sa = parseInt(ft[1], 10);
        if (isNaN(sh) || isNaN(sa)) { sh = null; sa = null; }
      }
      out.push({
        id: 'fj_' + `${slug}:${m.date}:${home}:${away}`,
        provider: 'football.json',
        league: name,
        league_code: code,
        utc_date: `${m.date}T15:00:00Z`,
        status,
        home_name: home.replace(/\s*FC$/, ''),
        away_name: away.replace(/\s*FC$/, ''),
        home_id: null, away_id: null,
        home_crest: null, away_crest: null,
        score_home: sh,
        score_away: sa,
        raw: { fj: m },
      });
    }
    return out;
  } catch (e) { return []; }
}

async function fetchFootballJsonAll() {
  const results = await Promise.all(
    FOOTBALL_JSON_LEAGUES.map(l => fetchFootballJsonLeague(l.slug, l.name, l.code))
  );
  return results.flat();
}

module.exports = {
  fetchSportScoreMatches,
  fetchWorldCup26Fixtures, fetchWorldCup26Standings,
  fetchFootballJsonAll, fetchFootballJsonLeague,
  FOOTBALL_JSON_LEAGUES, WC26_SLUGS,
};
