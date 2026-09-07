'use strict';

// Arabic Telegram post formatter.
//
// Goals:
//   • Natural, easy-to-understand Arabic (not word salad)
//   • Clean, scannable structure with emojis
//   • Honest: probability language, NEVER claim guarantees
//   • Omit markets that don't have enough data (clearly mark unavailable)
//
// HTML parse mode (default). We use <b>…</b> for bold. We never use HTML
// inside Telegram's MarkdownV2 because escaping is too easy to break.

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

function fmtLocal(iso, tz) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit', timeZone: tz || 'Asia/Riyadh' });
  } catch (e) { return fmtTimeUTC(iso); }
}

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

// Build a range string from low/high + margin. Returns Arabic.
function rangeAr(low, high) {
  return `${toArDigits(low)}–${toArDigits(high)}`;
}

/**
 * opts = {
 *   home, away, league, kickoff_iso,
 *   result: the object returned by engine.predictMatch(...)
 * }
 *
 * Returns: { text, hasGuarantee: false }
 */
function formatPrediction(opts) {
  const { home, away, league, kickoff_iso, result } = opts;
  if (!result) return { text: '', hasGuarantee: false };
  // Affiliate footer (optional). Main publish path passes it from config;
  // ad-hoc callers fall back to env vars so posts still carry the link.
  const aff = opts.affiliate || {
    link: (typeof process !== 'undefined' && process.env && process.env.MELBET_LINK) || 'https://melbet-49771.bar/en?tag=d_5217846m_2170c_&site=5217846&ad=2170&promo=KIKOS77',
    code: (typeof process !== 'undefined' && process.env && process.env.MELBET_PROMO_CODE) || 'KIKOS77',
  };

  const time = fmtLocal(kickoff_iso, 'Asia/Riyadh') + ' بتوقيت الرياض';
  const utc = fmtTimeUTC(kickoff_iso) + ' UTC';

  const lines = [];
  lines.push('⚽ <b>توقعات المباراة</b>');
  lines.push('');
  lines.push(`🏆 <b>الدوري:</b> ${escapeHtml(league || 'غير محدد')}`);
  lines.push(`⚔️ <b>المباراة:</b> ${escapeHtml(home)} 🆚 ${escapeHtml(away)}`);
  lines.push(`🕐 <b>الموعد:</b> ${time}  <i>(${utc})</i>`);
  lines.push('');

  // 1X2
  lines.push('━━━━━━━━━━━━━━━━━━━━');
  lines.push('📊 <b>توقع النتيجة</b>');
  lines.push(`🔴 فوز ${escapeHtml(home)}: <b>${pct(result.p_home)}</b>`);
  lines.push(`🟡 التعادل: <b>${pct(result.p_draw)}</b>`);
  lines.push(`🔵 فوز ${escapeHtml(away)}: <b>${pct(result.p_away)}</b>`);
  lines.push('');

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

  // Corners
  if (result.corners && result.corners.total != null) {
    lines.push('━━━━━━━━━━━━━━━━━━━━');
    lines.push('🚩 <b>الركنيات</b>');
    lines.push(`المتوقع: <b>${rangeAr(Math.round(result.corners.total - 1.5), Math.round(result.corners.total + 1.5))} ركنية</b>`);
    lines.push(`${escapeHtml(home)}: ~${toArDigits(Math.round(result.corners.home))} • ${escapeHtml(away)}: ~${toArDigits(Math.round(result.corners.away))}`);
    lines.push(`<i>تقدير مبني على معدلات الدوري — غير دقيق</i>`);
    lines.push('');
  }

  // Cards
  if (result.cards && result.cards.total != null) {
    lines.push('━━━━━━━━━━━━━━━━━━━━');
    lines.push('🟨 <b>البطاقات</b>');
    lines.push(`المتوقع: <b>${rangeAr(Math.round(result.cards.total - 1.5), Math.round(result.cards.total + 1.5))} بطاقات صفراء</b>`);
    lines.push(`🟥 احتمال بطاقة حمراء: <b>${pct((result.cards.redProb || 0) * 100)}</b>`);
    lines.push(`<i>تقدير مبني على معدلات الدوري — غير دقيق</i>`);
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

  // Footer (MANDATORY disclaimer)
  lines.push('━━━━━━━━━━━━━━━━━━━━');
  lines.push('📌 <i>هذه توقعات إحصائية مبنية على نموذج رياضي، وليست نتيجة مضمونة. الرجاء المراهنة بمسؤولية.</i>');
  if (aff && aff.link) {
    lines.push('');
    lines.push(`🎁 <b>مكافأة ترحيبية:</b> سجّل في Melbet مع الرمز <b>${escapeHtml(aff.code || '')}</b> — <a href="${escapeHtml(aff.link)}">اضغط هنا للتسجيل</a>`);
    lines.push('🔞 +18 | العب بمسؤولية');
  }
  lines.push(`<i>Model: ${escapeHtml(result.model_version || 'xwhiz-v1')}</i>`);

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

module.exports = { formatPrediction, escapeHtml, toArDigits, confidenceLabel };
