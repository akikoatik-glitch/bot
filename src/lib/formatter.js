'use strict';

// Arabic Telegram post formatter.
//
// Two formats:
//   1. formatCompactPrediction()  — the daily channel post. Short, human-like,
//      shows ONLY the single strongest market (never a wall of numbers).
//      Arabic-only, configurable TZ (default Africa/Algiers), no guarantee
//      claims, no English filler.
//   2. formatPrediction()         — the full deep-dive used by admin /publish.
//
// HTML parse mode (default). We use <b>…</b> for bold.

const config = require('./config');
const tz = require('./tz');
const { pick } = require('./phrases');

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
function toArDigits(n) {
  return String(n).replace(/[0-9]/g, c => AR_DIGITS[parseInt(c, 10)]);
}

function pct(p) {
  if (p == null || !isFinite(p)) return '—';
  return toArDigits(Math.round(p)) + '٪';
}

function pad2(n) { return String(n).padStart(2, '0'); }

function fmtTimeUTC(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
}

function fmtLocal(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit', timeZone: config.tz });
  } catch (e) { return fmtTimeUTC(iso); }
}

// Human-readable label for the timezone in Arabic.
function tzLabel() {
  const t = config.tz || 'Africa/Algiers';
  const known = {
    'Africa/Algiers': 'بتوقيت الجزائر',
    'Europe/Paris': 'بتوقيت باريس',
    'Europe/Berlin': 'بتوقيت برلين',
    'Asia/Riyadh': 'بتوقيت الرياض',
    'Africa/Cairo': 'بتوقيت القاهرة',
  };
  return known[t] || 'بالتوقيت المحلي';
}

// Confidence tiering — configurable via CONF_ELITE / CONF_STRONG / CONF_GOOD.
function confidenceTier(conf) {
  const c = config.daily || {};
  const good = c.confGood != null ? c.confGood : 70;
  const strong = c.confStrong != null ? c.confStrong : 80;
  const elite = c.confElite != null ? c.confElite : 90;
  if (conf >= elite) return { tier: 'ELITE', emoji: '🔥🔥🔥', label: 'ثقة إحصائية عالية جداً' };
  if (conf >= strong) return { tier: 'STRONG', emoji: '🔥🔥', label: 'ثقة إحصائية عالية' };
  if (conf >= good) return { tier: 'GOOD', emoji: '🔥', label: 'ثقة إحصائية جيدة' };
  return { tier: 'LOW', emoji: '🟠', label: 'ثقة إحصائية' };
}

// Legacy labels kept for the full deep-dive format.
function confidenceLabel(conf) {
  if (conf >= 78) return 'ثقة جيدة';
  if (conf >= 68) return 'ثقة متوسطة';
  if (conf >= 55) return 'ثقة منخفضة';
  return 'ثقة ضعيفة';
}

function confidenceEmoji(conf) {
  if (conf >= 78) return '🟢';
  if (conf >= 68) return '🟡';
  if (conf >= 55) return '🟠';
  return '🔴';
}

function rangeAr(low, high) {
  return `${toArDigits(low)}–${toArDigits(high)}`;
}

function affiliateSection(aff) {
  if (!aff || !aff.link) return '';
  const lines = [];
  lines.push('');
  lines.push(`🎁 <b>مكافأة ترحيبية:</b> سجّل في Melbet مع الرمز <b>${escapeHtml(aff.code || '')}</b> — <a href="${escapeHtml(aff.link)}">اضغط هنا للتسجيل</a>`);
  lines.push('🔞 +18 | العب بمسؤولية');
  return lines.join('\n');
}

// Split long score probabilities into a readable short line.
function shortScoreLine(result) {
  const cs = (result.correct_score || '0-0').replace('-', ' - ');
  return `🎯 النتيجة المتوقعة: <b>${toArDigits(cs)}</b> (${pct(result.correct_score_prob)})`;
}

/**
 * Compact daily post. Shows ONE main prediction (the best market).
 *
 * opts = {
 *   home, away, league, kickoff_iso,
 *   result: engine.predictMatch(...) object,
 *   affiliate: {link, code},
 *   seed: number (phrase rotation),
 * }
 */
function formatCompactPrediction(opts) {
  const { home, away, league, kickoff_iso, result } = opts;
  if (!result) return { text: '', hasGuarantee: false };
  const aff = opts.affiliate || {
    link: config.affiliate.melbetLink,
    code: config.affiliate.promoCode,
  };
  const seed = opts.seed || 0;
  const bb = result.best_bet || {};
  // The tier must reflect the probability of the market we are actually
  // publishing (best_bet.prob), not the 1X2-only conf.
  const conf = (bb.prob != null && isFinite(bb.prob)) ? bb.prob : result.conf;
  const tier = confidenceTier(conf);

  const time = `${fmtLocal(kickoff_iso)} ${tzLabel()}`;
  const header = pick('PREDICTION_HEADERS', seed);
  const intro = pick('PREDICTION_INTROS', seed);

  const lines = [];
  lines.push(`⚽ <b>${header}</b>`);
  lines.push('');
  lines.push(`🏆 <b>الدوري:</b> ${escapeHtml(league || 'غير محدد')}`);
  lines.push(`⚔️ <b>المباراة:</b> ${escapeHtml(home)} 🆚 ${escapeHtml(away)}`);
  lines.push(`🕐 <b>الموعد:</b> ${time}`);
  lines.push('');
  lines.push(`📊 ${intro}`);
  if (bb.label != null && isFinite(bb.prob)) {
    lines.push(`✅ <b>${escapeHtml(bb.label)}</b> — ${pct(bb.prob)} ${tier.emoji}`);
  } else {
    lines.push(`✅ ${escapeHtml(home)} أو التعادل (خيار النموذج) ${tier.emoji}`);
  }
  lines.push('');
  lines.push(`<i>المستوى: ${tier.label} — الاحتمال حسب النموذج الرياضي</i>`);
  lines.push(`📈 الأهداف المتوقعة: ${toArDigits(result.xg.home)} | ${toArDigits(result.xg.away)}`);
  lines.push(shortScoreLine(result));
  lines.push('');
  const disclaimers = ['توقعات إحصائية وليست نتيجة مضمونة، ننصحكم بالمراهنة بمسؤولية.',
    'هذه قراءة رياضية للاحتمالات، والقرار النهائي يعود إليكم.',
    'النموذج يعطي الاحتمال الأرجح وليس ضماناً للنتيجة، العب بوعي.'];
  lines.push(`📌 <i>${disclaimers[Math.abs(seed) % disclaimers.length]}</i>`);
  const affTxt = affiliateSection(aff);
  if (affTxt) lines.push(affTxt);

  return { text: lines.join('\n'), hasGuarantee: false };
}

/**
 * Full deep-dive post (admin /publish). Every market with honest disclaimers.
 *
 * opts = { home, away, league, kickoff_iso, result, affiliate }
 */
function formatPrediction(opts) {
  const { home, away, league, kickoff_iso, result } = opts;
  if (!result) return { text: '', hasGuarantee: false };
  const aff = opts.affiliate || {
    link: config.affiliate.melbetLink,
    code: config.affiliate.promoCode,
  };

  const time = `${fmtLocal(kickoff_iso)} ${tzLabel()}`;

  const lines = [];
  lines.push('⚽ <b>توقعات المباراة</b>');
  lines.push('');
  lines.push(`🏆 <b>الدوري:</b> ${escapeHtml(league || 'غير محدد')}`);
  lines.push(`⚔️ <b>المباراة:</b> ${escapeHtml(home)} 🆚 ${escapeHtml(away)}`);
  lines.push(`🕐 <b>الموعد:</b> ${time}`);
  lines.push('');

  // 1X2
  lines.push('━━━━━━━━━━━━━━━━━━━━');
  lines.push('📊 <b>توقع النتيجة</b>');
  lines.push(`🔴 فوز ${escapeHtml(home)}: <b>${pct(result.p_home)}</b>`);
  lines.push(`🟡 التعادل: <b>${pct(result.p_draw)}</b>`);
  lines.push(`🔵 فوز ${escapeHtml(away)}: <b>${pct(result.p_away)}</b>`);
  lines.push('');

  // Best bet
  if (result.best_bet && result.best_bet.label != null && isFinite(result.best_bet.prob)) {
    const tier = confidenceTier(result.best_bet.prob);
    lines.push('━━━━━━━━━━━━━━━━━━━━');
    lines.push('⭐ <b>أفضل توقع من النموذج</b>');
    lines.push(`✅ <b>${escapeHtml(result.best_bet.label)}</b> — <b>${pct(result.best_bet.prob)}</b> ${tier.emoji}`);
    lines.push('<i>السوق الأعلى احتمالاً بفارق واضح، وليس مضموناً</i>');
    lines.push('');
  }

  // Goals
  lines.push('━━━━━━━━━━━━━━━━━━━━');
  lines.push('⚽ <b>الأهداف</b>');
  lines.push(`🔥 أكثر من ٠٫٥ هدف: <b>${pct(result.over_under.over_0_5)}</b>`);
  lines.push(`🔥 أكثر من ١٫٥ هدف: <b>${pct(result.over_under.over_1_5)}</b>`);
  lines.push(`🔥 أكثر من ٢٫٥ هدف: <b>${pct(result.over_under.over_2_5)}</b>`);
  lines.push(`🔥 أكثر من ٣٫٥ هدف: <b>${pct(result.over_under.over_3_5)}</b>`);
  lines.push(`⬇️ أقل من ٢٫٥ هدف: <b>${pct(result.over_under.under_2_5)}</b>`);
  lines.push(`⚽ كلا الفريقين يسجلان: <b>${pct(result.btts.yes)}</b>`);
  lines.push(`🚫 كلا الفريقين لا يسجلان: <b>${pct(result.btts.no)}</b>`);
  lines.push('');

  // Correct score
  lines.push('━━━━━━━━━━━━━━━━━━━━');
  lines.push('🎯 <b>النتيجة المتوقعة</b>');
  const csNum = (result.correct_score || '0-0').replace('-', ' - ');
  lines.push(`<b>${toArDigits(csNum)}</b>  <i>(احتمال ${pct(result.correct_score_prob)})</i>`);
  if (result.top_scores && result.top_scores.length > 1) {
    const top = result.top_scores.slice(0, 5).map(s => `${toArDigits(s.score.replace('-', ' - '))} (${pct(s.prob)})`).join(' • ');
    lines.push(`<i>المرشحات الأخرى: ${top}</i>`);
  }
  lines.push('');

  // xG
  lines.push('━━━━━━━━━━━━━━━━━━━━');
  lines.push('📈 <b>الأهداف المتوقعة (xG)</b>');
  lines.push(`${escapeHtml(home)}: <b>${toArDigits(result.xg.home)}</b>`);
  lines.push(`${escapeHtml(away)}: <b>${toArDigits(result.xg.away)}</b>`);
  lines.push(`المجموع: <b>${toArDigits(result.xg.total)}</b>`);
  lines.push('');

  // Corner/card league averages are only shown in the full format and are
  // explicitly flagged as general estimates — they are never auto-published
  // as best bets (see engine.buildCandidates gating).
  if (result.corners && result.corners.total != null) {
    lines.push('━━━━━━━━━━━━━━━━━━━━');
    lines.push('🚩 <b>الركنيات</b>');
    lines.push(`المتوسط العام: <b>${rangeAr(Math.round(result.corners.total - 1.5), Math.round(result.corners.total + 1.5))} ركنية</b>`);
    lines.push(`<i>تقدير مبني على معدلات الدوري — ليس توقعاً مبني على بيانات المباراة</i>`);
    lines.push('');
  }

  if (result.cards && result.cards.total != null) {
    lines.push('━━━━━━━━━━━━━━━━━━━━');
    lines.push('🟨 <b>البطاقات</b>');
    lines.push(`المتوسط العام: <b>${rangeAr(Math.round(result.cards.total - 1.5), Math.round(result.cards.total + 1.5))} بطاقات صفراء</b>`);
    lines.push(`🟥 احتمال بطاقة حمراء: <b>${pct((result.cards.redProb || 0) * 100)}</b>`);
    lines.push(`<i>تقدير مبني على معدلات الدوري — ليس توقعاً مبني على بيانات المباراة</i>`);
    lines.push('');
  }

  // Extra markets
  lines.push('━━━━━━━━━━━━━━━━━━━━');
  lines.push('🧠 <b>أسواق إضافية</b>');
  lines.push(`🛡️ شباك نظيفة ${escapeHtml(home)}: <b>${pct(result.clean_sheet.home)}</b>`);
  lines.push(`🛡️ شباك نظيفة ${escapeHtml(away)}: <b>${pct(result.clean_sheet.away)}</b>`);
  lines.push(`🥅 أول من يسجل — ${escapeHtml(home)}: <b>${pct(result.first_to_score.home)}</b>`);
  lines.push(`🥅 أول من يسجل — ${escapeHtml(away)}: <b>${pct(result.first_to_score.away)}</b>`);
  lines.push(`🎲 الفرصة المزدوجة 1X: <b>${pct(result.double_chance['1X'])}</b> • X2: <b>${pct(result.double_chance['X2'])}</b> • 12: <b>${pct(result.double_chance['12'])}</b>`);
  lines.push(`↩️ تعادل يُلغى — ${escapeHtml(home)}: <b>${pct(result.draw_no_bet.home)}</b>`);
  lines.push(`⏱️ الشوط الأول — فوز ${escapeHtml(home)}: <b>${pct(result.half_time.probs.home)}</b> • تعادل: <b>${pct(result.half_time.probs.draw)}</b> • فوز ${escapeHtml(away)}: <b>${pct(result.half_time.probs.away)}</b>`);
  lines.push('');

  // Confidence
  lines.push('━━━━━━━━━━━━━━━━━━━━');
  lines.push(`${confidenceEmoji(result.conf)} <b>مستوى الثقة:</b> ${toArDigits(result.conf)}/100 — <i>${confidenceLabel(result.conf)}</i>`);
  if (result.data_quality != null) {
    lines.push(`📊 جودة البيانات: <b>${toArDigits(result.data_quality)}</b>/100`);
  }
  lines.push('');

  // Footer
  lines.push('━━━━━━━━━━━━━━━━━━━━');
  lines.push('📌 <i>هذه توقعات إحصائية مبنية على نموذج رياضي، وليست نتيجة مضمونة. الرجاء المراهنة بمسؤولية.</i>');
  const affTxt = affiliateSection(aff);
  if (affTxt) lines.push(affTxt);

  return { text: lines.join('\n'), hasGuarantee: false };
}

// Escape HTML special characters for Telegram HTML parse mode.
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>');
}

module.exports = {
  formatPrediction,
  formatCompactPrediction,
  escapeHtml,
  toArDigits,
  confidenceLabel,
  confidenceTier,
  fmtLocal,
  tzLabel,
};