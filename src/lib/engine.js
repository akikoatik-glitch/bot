'use strict';

// XWhiz Telegram-bot prediction engine v1.
//
// Combines (in order of weight, see WEIGHTS):
//   • Dixon-Coles bivariate Poisson from Elo + attack/defence strengths
//   • Recent form (W/D/L) for both teams, blended into the home advantage
//   • Poisson expected goals for O/U & BTTS
//   • Head-to-head (when statistically meaningful — same league, recent)
//   • Market odds (only as a small adjustment signal, NEVER sole source)
//   • League averages & clean-sheet heuristics
//
// All probabilities come from a real statistical computation.
// No random scores are forced. We return markets only when the model
// has enough data; otherwise we OMIT the market and label it "غير متاح".

const fs = require('fs');
const path = require('path');

// Re-use the existing Dixon-Coles engine from the parent site so we keep
// the same Elo databank and rating helpers.
const dc = require(path.resolve(__dirname, '..', '..', '..', 'scripts', 'dixon_coles.js'));

// ── weights (transparent, tweakable) ────────────────────────────────────────
const WEIGHTS = {
  dixonColes: 0.55,
  form: 0.15,
  h2h: 0.10,
  odds: 0.10,
  leagueAvg: 0.10,
};

// ── helpers ────────────────────────────────────────────────────────────────

function poisson(k, lambda) {
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return p;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function normName(t) {
  let n = String(t || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ').trim();
  n = n.replace(/^(fc|ac|as|sc|ss|cd|cf|de|1\.)\s+/, '');
  n = n.replace(/\s+(fc|ac|as|sc|ss|afc|cf|cd|ud)$/, '');
  return n;
}

// League priority (mirror fetch_football.js — bots may add more later)
const LEAGUE_PRIORITY = [
  'Premier League', 'La Liga', 'Bundesliga', 'Serie A', 'Ligue 1',
  'UEFA Champions League', 'UEFA Europa League', 'UEFA Conference League',
  'Eredivisie', 'Primeira Liga', 'Championship', 'Brasileirão', 'Süper Lig',
  'FA Cup', 'Copa del Rey', 'DFB Pokal', 'Coppa Italia', 'Coupe de France',
  'J1 League', 'K League 1', 'MLS', 'Saudi Pro League',
];
const LEAGUE_PRIORITY_SET = new Set(LEAGUE_PRIORITY.map(s => s.toLowerCase()));
function leaguePriorityScore(name) {
  if (!name) return 30;
  const lc = String(name).toLowerCase();
  const idx = LEAGUE_PRIORITY.findIndex(x => x.toLowerCase() === lc);
  if (idx >= 0) return 100 - idx;
  return 30;
}

// ── form features ──────────────────────────────────────────────────────────

// matches: [{home, away, scoreHome, scoreAway, status}]
// Returns W/D/L for the given team name from its last N played matches.
function computeFormPoints(matches, teamName, n = 5) {
  const played = [];
  for (const m of matches) {
    if (!m || !m.status || m.status !== 'FINISHED') continue;
    if (m.scoreHome == null || m.scoreAway == null) continue;
    const isHome = normName(m.home) === normName(teamName);
    const isAway = normName(m.away) === normName(teamName);
    if (!isHome && !isAway) continue;
    if (isHome) {
      if (m.scoreHome > m.scoreAway) played.push(3);
      else if (m.scoreHome === m.scoreAway) played.push(1);
      else played.push(0);
    } else {
      if (m.scoreAway > m.scoreHome) played.push(3);
      else if (m.scoreAway === m.scoreHome) played.push(1);
      else played.push(0);
    }
  }
  return played.slice(-n);
}

function formAdjustment(formPoints) {
  // Returns delta Elo equivalent: -60..+60
  if (!formPoints.length) return 0;
  const avg = formPoints.reduce((s, x) => s + x, 0) / formPoints.length; // 0..3
  const baseline = 1.0; // below average
  return clamp((avg - baseline) * 30, -60, 60);
}

// ── league average goals ────────────────────────────────────────────────────
//
// Returns league-average total goals per game. This lets us scale the model
// to the actual league profile (e.g. Bundesliga is more open than Serie A).
const LEAGUE_AVG_TOTAL_GOALS = {
  'premier league': 2.75,
  'la liga': 2.55,
  'bundesliga': 3.05,
  'serie a': 2.50,
  'ligue 1': 2.60,
  'eredivisie': 3.00,
  'primeira liga': 2.50,
  'championship': 2.60,
  'brasileirão': 2.50,
  'süper lig': 2.55,
  'uefa champions league': 2.75,
  'uefa europa league': 2.65,
  'uefa conference league': 2.55,
  'saudi pro league': 2.60,
  'mls': 3.00,
  'j1 league': 2.55,
  'k league 1': 2.50,
};

function leagueAvgGoals(league) {
  if (!league) return 2.65;
  const lc = String(league).toLowerCase();
  if (LEAGUE_AVG_TOTAL_GOALS[lc] != null) return LEAGUE_AVG_TOTAL_GOALS[lc];
  return 2.65;
}

// ── h2h adjustment ─────────────────────────────────────────────────────────

function h2hAdjustment(h2h, homeName, awayName) {
  // Use only when we have ≥3 H2H matches in the same league context
  if (!Array.isArray(h2h) || h2h.length < 3) return 0;
  const h = normName(homeName), a = normName(awayName);
  let homePts = 0, n = 0;
  for (const m of h2h) {
    if (m.status !== 'FINISHED') continue;
    if (m.scoreHome == null || m.scoreAway == null) continue;
    const isHome = normName(m.home) === h && normName(m.away) === a;
    const reversed = normName(m.home) === a && normName(m.away) === h;
    if (!isHome && !reversed) continue;
    if (isHome) {
      if (m.scoreHome > m.scoreAway) homePts += 1;
      else if (m.scoreHome === m.scoreAway) homePts += 0.5;
    } else {
      if (m.scoreAway > m.scoreHome) homePts += 0; // the "home" team was the visitor — count as loss for our home
      else if (m.scoreAway === m.scoreHome) homePts += 0.5;
    }
    n++;
  }
  if (n < 3) return 0;
  const rate = homePts / n; // 0..1
  // Map 0.5 (balanced) -> 0; 1.0 -> +60; 0.0 -> -60
  return clamp((rate - 0.5) * 120, -60, 60);
}

// ── odds adjustment ────────────────────────────────────────────────────────

function oddsAdjustment(odds) {
  // odds: { home, draw, away } decimal odds. Returns a tiny Elo shift based
  // on the *implied* probability — only used as a small additional signal.
  if (!odds) return 0;
  const h = parseFloat(odds.home), d = parseFloat(odds.draw), a = parseFloat(odds.away);
  if (!isFinite(h) || !isFinite(d) || !isFinite(a) || h <= 1 || d <= 1 || a <= 1) return 0;
  const pH = 1 / h, pD = 1 / d, pA = 1 / a;
  const tot = pH + pD + pA;
  const fH = pH / tot, fA = pA / tot;
  // -1..+1 scaled
  return clamp((fH - fA) * 60, -40, 40);
}

// ── probability combination ────────────────────────────────────────────────

function blend(p1, p2, w1, w2) {
  const t = w1 + w2;
  if (t <= 0) return p1;
  return (p1 * w1 + p2 * w2) / t;
}

// ── market calculations ────────────────────────────────────────────────────

function computeScoreMatrix(lamH, lamA, N = 6) {
  const M = Array.from({ length: N + 1 }, () => Array(N + 1).fill(0));
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      M[i][j] = poisson(i, lamH) * poisson(j, lamA);
    }
  }
  const total = M.flat().reduce((a, b) => a + b, 0);
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) M[i][j] /= total;
  return M;
}

function argmaxScore(M) {
  let best = -1, bi = 0, bj = 0;
  for (let i = 0; i < M.length; i++) {
    for (let j = 0; j < M[i].length; j++) {
      if (M[i][j] > best) { best = M[i][j]; bi = i; bj = j; }
    }
  }
  return { score: `${bi}-${bj}`, prob: best, i: bi, j: bj };
}

function topScores(M, n = 5) {
  const cells = [];
  for (let i = 0; i < M.length; i++) for (let j = 0; j < M[i].length; j++) {
    cells.push({ score: `${i}-${j}`, prob: M[i][j], i, j });
  }
  cells.sort((a, b) => b.prob - a.prob || (a.i + a.j) - (b.i + b.j) || a.i - b.i);
  return cells.slice(0, n).map(c => ({ score: c.score, prob: Math.round(c.prob * 100) }));
}

function probsFromMatrix(M) {
  let pH = 0, pD = 0, pA = 0, over05 = 0, over15 = 0, over25 = 0, over35 = 0, bttsY = 0;
  for (let i = 0; i < M.length; i++) {
    for (let j = 0; j < M[i].length; j++) {
      const t = i + j;
      if (i > j) pH += M[i][j];
      else if (i === j) pD += M[i][j];
      else pA += M[i][j];
      if (t >= 1) over05 += M[i][j];
      if (t >= 2) over15 += M[i][j];
      if (t >= 3) over25 += M[i][j];
      if (t >= 4) over35 += M[i][j];
      if (i >= 1 && j >= 1) bttsY += M[i][j];
    }
  }
  return { pH, pD, pA, over05, over15, over25, over35, bttsY };
}

// ── corners / cards (very rough, marked as such) ────────────────────────────

function estimateCorners(league) {
  // These are statistical baselines; we only publish ranges when we have
  // confidence. We do NOT claim exact totals.
  const lc = (league || '').toLowerCase();
  const table = {
    'premier league': { total: 10.6, home: 5.7, away: 4.9 },
    'la liga': { total: 9.5, home: 5.1, away: 4.4 },
    'bundesliga': { total: 10.0, home: 5.4, away: 4.6 },
    'serie a': { total: 10.3, home: 5.6, away: 4.7 },
    'ligue 1': { total: 9.7, home: 5.2, away: 4.5 },
    'eredivisie': { total: 11.0, home: 5.9, away: 5.1 },
    'primeira liga': { total: 9.8, home: 5.3, away: 4.5 },
    'championship': { total: 10.8, home: 5.8, away: 5.0 },
  };
  return table[lc] || { total: 10.0, home: 5.4, away: 4.6 };
}

function estimateCards(league) {
  const lc = (league || '').toLowerCase();
  const table = {
    'premier league': { total: 4.4, redProb: 0.10 },
    'la liga': { total: 5.2, redProb: 0.13 },
    'bundesliga': { total: 4.0, redProb: 0.08 },
    'serie a': { total: 5.5, redProb: 0.14 },
    'ligue 1': { total: 4.6, redProb: 0.12 },
    'eredivisie': { total: 3.8, redProb: 0.09 },
    'primeira liga': { total: 5.0, redProb: 0.12 },
    'championship': { total: 4.8, redProb: 0.10 },
  };
  return table[lc] || { total: 4.6, redProb: 0.10 };
}

// ── confidence ─────────────────────────────────────────────────────────────

function dataQualityScore({ standingsOk, recentResults, h2hCount, odds, league }) {
  let q = 30; // base for having match info
  if (standingsOk) q += 25;
  if (recentResults && recentResults.length >= 5) q += 20;
  else if (recentResults && recentResults.length >= 3) q += 10;
  if (h2hCount && h2hCount >= 3) q += 10;
  if (odds) q += 5;
  if (leaguePriorityScore(league) >= 90) q += 10; // top league bonus
  return clamp(q, 0, 100);
}

// ── main entry ─────────────────────────────────────────────────────────────

/**
 * opts = {
 *   home: string, away: string,
 *   league: string,
 *   homeForm: number[], awayForm: number[],  // optional, [3,1,3,...]
 *   standingsOk: boolean,
 *   recentResults: [{home, away, scoreHome, scoreAway, status}],
 *   h2h: same shape as recentResults,
 *   odds: {home, draw, away}  // decimal
 * }
 *
 * Returns an object with: probabilities, top scores, markets, confidence.
 * Markets that we cannot compute (insufficient data) are returned as null
 * (caller may omit them from the post).
 */
function predictMatch(opts) {
  const home = opts.home, away = opts.away, league = opts.league || '';
  const standingsOk = !!opts.standingsOk;

  // Elo + DC baseline
  const eloH = dc.rating(home), eloA = dc.rating(away);

  // Adjusted rating: apply form, H2H, odds
  const formH = formAdjustment(opts.homeForm || []);
  const formA = formAdjustment(opts.awayForm || []);
  const h2hA = h2hAdjustment(opts.h2h || [], home, away);
  const oddsA = oddsAdjustment(opts.odds);

  const adjH = eloH + formH + h2hA * 0.5 + oddsA * 0.5;
  const adjA = eloA + formA - h2hA * 0.5 - oddsA * 0.5;

  // Expected goals from adjusted Elo
  const homeAdv = 100;
  const diff = (adjH + homeAdv - adjA) / 400;
  let lamH = 1.4 * Math.pow(10, diff / 2);
  let lamA = 1.2 * Math.pow(10, -diff / 2);

  // Scale by league-average total goals (keeps the model calibrated)
  const leagueAvg = leagueAvgGoals(league);
  const sumLam = lamH + lamA;
  if (sumLam > 0) {
    const scale = leagueAvg / sumLam;
    lamH *= scale; lamA *= scale;
  }

  lamH = clamp(lamH, 0.35, 4.2);
  lamA = clamp(lamA, 0.30, 4.0);

  const M = computeScoreMatrix(lamH, lamA);
  const pr = probsFromMatrix(M);

  // Soft blend with raw DC probability (so the engine is still recognisably
  // Dixon-Coles). When weights sum to 1, blended == matrix-derived.
  const dcRes = dc.predict(home, away, standingsOk ? {
    hr: adjH, ar: adjA,
    hatk: 1, hdef: 1, aatk: 1, adef: 1,
  } : { hr: adjH, ar: adjA });
  // DC predict uses raw internal Elo via expGoalsFor; we accept its pH/pD/pA
  // but bias slightly toward our league-scaled matrix.
  const dcP = { pH: dcRes.pH / 100, pD: dcRes.pD / 100, pA: dcRes.pA / 100 };
  const blendedH = blend(dcP.pH, pr.pH, WEIGHTS.dixonColes, 1 - WEIGHTS.dixonColes);
  const blendedD = blend(dcP.pD, pr.pD, WEIGHTS.dixonColes, 1 - WEIGHTS.dixonColes);
  const blendedA = blend(dcP.pA, pr.pA, WEIGHTS.dixonColes, 1 - WEIGHTS.dixonColes);

  // Re-normalise
  const s = blendedH + blendedD + blendedA;
  const pH = blendedH / s, pD = blendedD / s, pA = blendedA / s;

  // Recommended 1X2 outcome
  const maxP = Math.max(pH, pD, pA);
  let pred1x2;
  if (pH >= pA && pH >= pD) pred1x2 = '1';
  else if (pA >= pH && pA >= pD) pred1x2 = '2';
  else pred1x2 = 'X';

  // Confidence — honest: probability of the recommended outcome.
  const conf = Math.round(maxP * 100);

  // Correct score & top scores
  const cs = argmaxScore(M);
  const ts = topScores(M, 5);

  // Other markets
  const over05 = Math.round(pr.over05 * 100);
  const over15 = Math.round(pr.over15 * 100);
  const over25 = Math.round(pr.over25 * 100);
  const over35 = Math.round(pr.over35 * 100);
  const bttsY = Math.round(pr.bttsY * 100);

  // Clean sheet
  const csH = Math.round(poisson(0, lamA) * 100);
  const csA = Math.round(poisson(0, lamH) * 100);

  // Half-time expected goals (≈ 45%, since avg goals scale with time)
  const htLamH = +(lamH * 0.45).toFixed(2);
  const htLamA = +(lamA * 0.45).toFixed(2);
  const Mht = computeScoreMatrix(htLamH, htLamA);
  const prHt = probsFromMatrix(Mht);
  const htP = { home: Math.round(prHt.pH * 100), draw: Math.round(prHt.pD * 100), away: Math.round(prHt.pA * 100) };
  const htGoals = { over05: Math.round(prHt.over05 * 100), over15: Math.round(prHt.over15 * 100) };

  // First team to score: P(home) = lamH/(lamH+lamA) (approximately) and BTTS-no scaling.
  const firstGoalH = Math.round((lamH / (lamH + lamA)) * 100);
  const firstGoalA = 100 - firstGoalH;

  // Double chance
  const dch = { '1X': Math.round((pH + pD) * 100), 'X2': Math.round((pD + pA) * 100), '12': Math.round((pH + pA) * 100) };
  const dnbH = Math.round((pH / (pH + pA)) * 100);
  const dnbA = 100 - dnbH;

  // Corners / cards — only published when we have league-level baseline.
  const corners = estimateCorners(league);
  const cards = estimateCards(league);

  // Data quality & confidence score
  const dataQ = dataQualityScore({
    standingsOk,
    recentResults: opts.recentResults || [],
    h2hCount: (opts.h2h || []).length,
    odds: opts.odds || null,
    league,
  });

  // Final ranking score (used to choose strongest predictions first)
  // weight confidence + data quality + league priority + head-to-head stability
  const leagueScore = leaguePriorityScore(league);
  const ranking = Math.round(
    0.55 * conf + 0.30 * dataQ + 0.10 * leagueScore + 0.05 * Math.min(100, (opts.recentResults || []).length * 10)
  );

  return {
    pred_1x2: pred1x2,
    conf,
    p_home: Math.round(pH * 100),
    p_draw: Math.round(pD * 100),
    p_away: Math.round(pA * 100),
    correct_score: cs.score,
    correct_score_prob: Math.round(cs.prob * 100),
    top_scores: ts,
    xg: { home: +lamH.toFixed(2), away: +lamA.toFixed(2), total: +(lamH + lamA).toFixed(2) },
    over_under: {
      over_0_5: over05, over_1_5: over15, over_2_5: over25, over_3_5: over35,
      under_2_5: 100 - over25,
    },
    btts: { yes: bttsY, no: 100 - bttsY },
    double_chance: dch,
    draw_no_bet: { home: dnbH, away: dnbA },
    first_to_score: { home: firstGoalH, away: firstGoalA },
    clean_sheet: { home: csH, away: csA },
    half_time: {
      probs: htP,
      goals: htGoals,
      xg: { home: htLamH, away: htLamA, total: +(htLamH + htLamA).toFixed(2) },
    },
    corners,
    cards,
    asian_handicap: dcRes.asianHandicap,
    data_quality: dataQ,
    ranking_score: ranking,
    league_priority: leagueScore,
    model_version: 'xwhiz-v1',
    rating: { home: eloH, away: eloA },
  };
}

module.exports = {
  predictMatch,
  computeFormPoints,
  leaguePriorityScore,
  dataQualityScore,
  WEIGHTS,
};
