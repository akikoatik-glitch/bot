'use strict';

// Telegram command handler.
// Parses /commands sent to the bot by admin users and dispatches them.
// Also handles callback_query (inline button presses).

const log = require('./lib/logger');
const config = require('./lib/config');
const db = require('./lib/db');
const tg = require('./lib/telegram');
const { formatPrediction, escapeHtml } = require('./lib/formatter');
const { publishCycle } = require('./publish');
const results = require('./lib/results');
const engine = require('./lib/engine');
const agg = require('./sources/aggregator');

function isAdmin(userId) { return tg.isAdmin(userId); }

const COMMANDS = {
  start: cmdStart,
  help: cmdHelp,
  status: cmdStatus,
  pause: cmdPause,
  resume: cmdResume,
  setmin: cmdSetMin,
  setmax: cmdSetMax,
  setinterval: cmdSetInterval,
  trigger: cmdTrigger,
  today: cmdToday,
  upcoming: cmdUpcoming,
  predictions: cmdPredictions,
  accuracy: cmdAccuracy,
  errors: cmdErrors,
  api: cmdApiStatus,
  publish: cmdPublishOne,
  cancel: cmdCancel,
  leagues: cmdLeagues,
  exclude: cmdExclude,
  include: cmdInclude,
  channels: cmdChannels,
  pin: cmdPin,
};

async function handleUpdate(u) {
  try {
    if (u.message) {
      const m = u.message;
      const userId = m.from && m.from.id;
      if (!isAdmin(userId)) {
        // Silently ignore non-admin direct messages.
        if (m.chat && m.chat.type === 'private') {
          await tg.sendMessage(m.chat.id, 'هذا البوت للأدمن فقط.', { throttle: false });
        }
        return;
      }
      const text = (m.text || '').trim();
      if (!text) return;
      if (text.startsWith('/')) {
        const [cmdRaw, ...args] = text.split(/\s+/);
        const cmd = cmdRaw.split('@')[0].slice(1).toLowerCase();
        const fn = COMMANDS[cmd];
        if (fn) {
          log.info('cmd', { cmd, userId, args });
          await fn({ chatId: m.chat.id, args, message: m });
          return;
        }
        await tg.sendMessage(m.chat.id, 'أمر غير معروف. اكتب /help.', { throttle: false });
      }
    } else if (u.callback_query) {
      const cq = u.callback_query;
      if (!isAdmin(cq.from && cq.from.id)) return;
      const data = cq.data || '';
      const [cmd, ...rest] = data.split('|');
      const fn = COMMANDS[cmd];
      if (fn) {
        try { await fn({ chatId: cq.message.chat.id, args: rest, callbackQueryId: cq.id, message: cq.message }); } catch (_) {}
      }
      try { await tg.call('answerCallbackQuery', { callback_query_id: cq.id }, { retries: 0, throttle: false }); } catch (_) {}
    }
  } catch (e) {
    log.error('handleUpdate.error', { err: e.message });
  }
}

async function cmdStart({ chatId }) {
  await tg.sendMessage(chatId,
    '👋 <b>مرحبا</b> — لوحة تحكم بوت توقعات كرة القدم.\n\n' +
    'اكتب /help لرؤية الأوامر المتاحة.', { throttle: false });
}

async function cmdHelp({ chatId }) {
  const msg = [
    '🛠️ <b>أوامر الأدمن</b>',
    '',
    '/status — حالة البوت وقواعد البيانات',
    '/today — مباريات اليوم',
    '/upcoming — المباريات القادمة',
    '/predictions — آخر التوقعات المنشورة',
    '/accuracy — إحصائيات الدقة',
    '/errors — آخر أخطاء',
    '/api — حالة المصادر',
    '',
    '<b>التحكم في النشر</b>',
    '/pause — إيقاف النشر التلقائي',
    '/resume — استئناف النشر',
    '/trigger — تشغيل دورة نشر فوراً',
    '/publish <match_id> — نشر توقع لمباراة محددة',
    '/cancel <match_id> — حذف توقع منشور',
    '',
    '<b>القواعد</b>',
    '/setmin <0-100> — الحد الأدنى للثقة',
    '/setmax <N> — أقصى عدد منشورات في كل دورة',
    '/setinterval <دقائق> — الفترة بين دورات النشر',
    '/leagues — عرض الدوريات المفعّلة',
    '/include <نص> — إضافة فلتر تضمين',
    '/exclude <نص> — إضافة فلتر استبعاد',
    '/pin <on|off> — تثبيت الرسائل في القناة',
    '',
    '<b>القناة</b>',
    '/channels — معلومات القناة وحالة النشر',
  ].join('\n');
  await tg.sendMessage(chatId, msg, { throttle: false });
}

async function cmdStatus({ chatId }) {
  const lastPub = db.stateGet('last_publish');
  const lastPubSt = db.stateGet('last_publish_status');
  const todayCount = db.countPredictionsToday();
  const paused = config.scheduler.pause;
  const errs = db.recentErrors(5);
  const stats = db.accuracyStats({ days: 30 });
  let msg = [
    '🤖 <b>حالة البوت</b>',
    '',
    `⏸️ الإيقاف المؤقت: <b>${paused ? 'مفعّل' : 'متوقف'}</b>`,
    `📡 المصدر: <b>${config.apiFootball.key ? 'API-Football' : 'fallbacks'}</b>`,
    `🔄 آخر نشر: <b>${lastPub || 'لم يبدأ بعد'}</b>`,
    `📊 حالة آخر دورة: <b>${lastPubSt || '—'}</b>`,
    `📅 منشورات اليوم: <b>${todayCount}</b>`,
    `🎯 الحد الأدنى للثقة: <b>${config.scheduler.minConfidence}</b>`,
    `📈 أقصى عدد لكل دورة: <b>${config.scheduler.maxPredictionsPerCycle}</b>`,
    `⏱️ فترة النشر: <b>${config.scheduler.publishIntervalMinutes} دقيقة</b>`,
    '',
    '<b>إحصائيات آخر 30 يوم</b>',
    `عدد التوقعات المُقيّمة: <b>${stats.totals.predictions_recorded}</b>`,
    `دقة 1X2: <b>${stats.totals.one_x_two.pct}%</b> (${stats.totals.one_x_two.hits}/${stats.totals.one_x_two.total})`,
    `دقة كلا الفريقين يسجلان: <b>${stats.totals.btts.pct}%</b> (${stats.totals.btts.hits}/${stats.totals.btts.total})`,
    `دقة أكثر/أقل من 2.5: <b>${stats.totals.over_under.pct}%</b> (${stats.totals.over_under.hits}/${stats.totals.over_under.total})`,
    `دقة النتيجة الصحيحة: <b>${stats.totals.correct_score.pct}%</b> (${stats.totals.correct_score.hits}/${stats.totals.correct_score.total})`,
  ].join('\n');
  if (errs.length) {
    msg += '\n\n<b>آخر أخطاء</b>\n' + errs.map(e => `• ${escapeHtml(e.scope || '')} — ${escapeHtml((e.message || '').slice(0, 80))}`).join('\n');
  }
  await tg.sendMessage(chatId, msg, { throttle: false });
}

async function cmdPause({ chatId, args }) {
  config.scheduler.pause = true;
  await tg.sendMessage(chatId, '⏸️ <b>تم إيقاف النشر التلقائي.</b>\nسيستمر البوت في تتبع النتائج وحساب الإحصائيات.', { throttle: false });
}
async function cmdResume({ chatId }) {
  config.scheduler.pause = false;
  await tg.sendMessage(chatId, '▶️ <b>تم استئناف النشر التلقائي.</b>', { throttle: false });
}

async function cmdSetMin({ chatId, args }) {
  const v = parseInt(args[0], 10);
  if (!isFinite(v) || v < 0 || v > 100) return tg.sendMessage(chatId, '⚠️ قيمة غير صحيحة. اكتب رقماً بين 0 و 100.', { throttle: false });
  config.scheduler.minConfidence = v;
  db.stateSet('min_confidence', String(v));
  await tg.sendMessage(chatId, `✅ تم تعيين الحد الأدنى للثقة إلى <b>${v}</b>.`, { throttle: false });
}
async function cmdSetMax({ chatId, args }) {
  const v = parseInt(args[0], 10);
  if (!isFinite(v) || v < 1 || v > 20) return tg.sendMessage(chatId, '⚠️ قيمة غير صحيحة.', { throttle: false });
  config.scheduler.maxPredictionsPerCycle = v;
  db.stateSet('max_per_cycle', String(v));
  await tg.sendMessage(chatId, `✅ تم تعيين أقصى عدد منشورات لكل دورة إلى <b>${v}</b>.`, { throttle: false });
}
async function cmdSetInterval({ chatId, args }) {
  const v = parseInt(args[0], 10);
  if (!isFinite(v) || v < 15 || v > 240) return tg.sendMessage(chatId, '⚠️ يجب أن يكون بين 15 و 240 دقيقة.', { throttle: false });
  config.scheduler.publishIntervalMinutes = v;
  db.stateSet('interval_minutes', String(v));
  await tg.sendMessage(chatId, `✅ تم تعيين فترة النشر إلى <b>${v}</b> دقيقة. سيتم تطبيقها بعد الدورة الحالية. أعد التشغيل لتطبيقها على المجدول.`, { throttle: false });
}

async function cmdTrigger({ chatId, args }) {
  await tg.sendMessage(chatId, '⏳ جاري تشغيل دورة نشر…', { throttle: false });
  const r = await publishCycle();
  await tg.sendMessage(chatId, `✅ تمت الدورة.\nمنشور: <b>${r.published}</b>\nمرشّح: <b>${r.eligible}</b>\nقادم: <b>${r.upcoming}</b>`, { throttle: false });
}

async function cmdToday({ chatId }) {
  const today = new Date().toISOString().slice(0, 10);
  const ms = await agg.fetchDay(today);
  const lines = [`📅 <b>مباريات اليوم</b> — ${today}`, ''];
  for (const m of ms.slice(0, 25)) {
    lines.push(`• ${escapeHtml(m.home_name)} 🆚 ${escapeHtml(m.away_name)} — <i>${escapeHtml(m.league || '')}</i>`);
  }
  if (!ms.length) lines.push('لا توجد مباريات.');
  await tg.sendMessage(chatId, lines.join('\n'), { throttle: false });
}

async function cmdUpcoming({ chatId }) {
  const today = new Date(); today.setUTCHours(0,0,0,0);
  const ts = Math.floor(today.getTime() / 1000);
  const ms = db.listMatches({ fromTs: ts, statuses: ['TIMED', 'SCHEDULED'], limit: 50 });
  const lines = [`📅 <b>المباريات القادمة</b>`, ''];
  for (const m of ms) {
    lines.push(`• ${escapeHtml(m.home_name)} 🆚 ${escapeHtml(m.away_name)} — <i>${escapeHtml(m.league || '')}</i> @ ${new Date(m.utc_date).toISOString().slice(0,16).replace('T',' ')} UTC`);
  }
  if (!ms.length) lines.push('لا توجد مباريات قادمة.');
  await tg.sendMessage(chatId, lines.join('\n'), { throttle: false });
}

async function cmdPredictions({ chatId, args }) {
  const limit = parseInt(args[0], 10) || 10;
  const ps = db.listPredictions({ limit });
  if (!ps.length) return tg.sendMessage(chatId, 'لا توجد توقعات بعد.', { throttle: false });
  const lines = [`📋 <b>آخر التوقعات (${ps.length})</b>`, ''];
  for (const p of ps) {
    const date = new Date(p.kickoff_ts * 1000).toISOString().slice(0, 16).replace('T', ' ');
    lines.push(`• <code>${escapeHtml(p.match_id)}</code> — ${escapeHtml(p.home_name)} 🆚 ${escapeHtml(p.away_name)} (${escapeHtml(p.league || '')}) — ثقة ${p.conf} — ${date} UTC`);
  }
  await tg.sendMessage(chatId, lines.join('\n'), { throttle: false });
}

async function cmdAccuracy({ chatId, args }) {
  const days = parseInt(args[0], 10) || 30;
  const stats = db.accuracyStats({ days });
  let msg = [
    `🎯 <b>إحصائيات الدقة — آخر ${days} يوم</b>`,
    '',
    `عدد التوقعات المُقيّمة: <b>${stats.totals.predictions_recorded}</b>`,
    `دقة 1X2: <b>${stats.totals.one_x_two.pct}%</b> (${stats.totals.one_x_two.hits}/${stats.totals.one_x_two.total})`,
    `دقة كلا الفريقين يسجلان: <b>${stats.totals.btts.pct}%</b>`,
    `دقة أكثر/أقل من 2.5: <b>${stats.totals.over_under.pct}%</b>`,
    `دقة النتيجة الصحيحة: <b>${stats.totals.correct_score.pct}%</b>`,
  ].join('\n');
  if (stats.by_league.length) {
    msg += '\n\n<b>حسب الدوري</b>\n';
    for (const r of stats.by_league.slice(0, 15)) {
      msg += `• ${escapeHtml(r.league || '—')}: <b>${r.one_x_two_pct}%</b> (${r.n})\n`;
    }
  }
  if (stats.by_confidence.length) {
    msg += '\n<b>حسب مستوى الثقة</b>\n';
    for (const r of stats.by_confidence) {
      msg += `• ثقة ${r.bucket}: <b>${r.one_x_two_pct}%</b> (${r.n})\n`;
    }
  }
  await tg.sendMessage(chatId, msg, { throttle: false });
}

async function cmdErrors({ chatId }) {
  const errs = db.recentErrors(15);
  if (!errs.length) return tg.sendMessage(chatId, '✅ لا توجد أخطاء.', { throttle: false });
  let msg = '🚨 <b>آخر الأخطاء</b>\n\n';
  for (const e of errs) {
    msg += `• <code>${escapeHtml((e.ts || '').slice(0,19))}</code> ${escapeHtml(e.scope || '')} — ${escapeHtml((e.message || '').slice(0,120))}\n`;
  }
  await tg.sendMessage(chatId, msg, { throttle: false });
}

async function cmdApiStatus({ chatId }) {
  const af = require('../sources/api_football');
  const fd = require('../sources/football_data');
  const fbs = require('../sources/fallbacks');
  const cfg = require('./config');
  let msg = '🌐 <b>حالة المصادر</b>\n\n';
  msg += `API-Football: <b>${af.enabled() ? '✅' : '❌'}</b>${af.enabled() ? ' (مفتاح موجود)' : ' (لا يوجد مفتاح)'}\n`;
  msg += `football-data.org: <b>${fd.enabled() ? '✅' : '❌'}</b>\n`;
  msg += `Fallbacks: <b>✅</b> (SportScore / WorldCup26 / openfootball)\n`;
  msg += `Telegram: <b>${cfg.telegram.channelId ? '✅' : '❌'}</b>${cfg.telegram.channelId ? ' (' + escapeHtml(String(cfg.telegram.channelId)) + ')' : ''}\n`;
  msg += `قاعدة البيانات: <b>✅</b>\n`;
  await tg.sendMessage(chatId, msg, { throttle: false });
}

async function cmdPublishOne({ chatId, args }) {
  const matchId = args[0];
  if (!matchId) return tg.sendMessage(chatId, '⚠️ اكتب معرف المباراة.', { throttle: false });
  const m = db.getMatch(matchId);
  if (!m) return tg.sendMessage(chatId, '⚠️ لم يتم العثور على المباراة.', { throttle: false });
  if (m.status !== 'TIMED' && m.status !== 'SCHEDULED') return tg.sendMessage(chatId, '⚠️ المباراة لم تعد في حالة TIMED.', { throttle: false });
  // Build context on the fly
  const allRecent = await (require('./lib/aggregator2').collectRecentForPublish(7));
  const ctx = await (require('./publish').gatherContextForMatch(m, allRecent));
  const result = engine.predictMatch({
    home: m.home_name, away: m.away_name, league: m.league, ...ctx,
  });
  const { text } = formatPrediction({
    home: m.home_name, away: m.away_name, league: m.league,
    kickoff_iso: m.utc_date, result,
  });
  if (config.safety.dryRun) return tg.sendMessage(chatId, '🧪 <b>DRY_RUN</b> — لن أُرسل:\n\n' + text, { throttle: false });
  const msg = await tg.sendMessage(config.telegram.channelId, text);
  db.savePrediction({
    match_id: m.id, channel_message_id: msg.message_id,
    published_at: new Date().toISOString(),
    kickoff_ts: Math.floor(new Date(m.utc_date).getTime() / 1000),
    league: m.league, home_name: m.home_name, away_name: m.away_name,
    conf: result.conf,
    p_home: result.p_home / 100, p_draw: result.p_draw / 100, p_away: result.p_away / 100,
    xg_home: result.xg.home, xg_away: result.xg.away,
    btts_yes: result.btts.yes / 100, over_2_5: result.over_under.over_2_5 / 100, under_2_5: result.over_under.under_2_5 / 100,
    pred_1x2: result.pred_1x2, correct_score: result.correct_score, correct_score_prob: result.correct_score_prob / 100,
    arabic_text: text, english_text: null,
    sources_json: { manual: true }, accuracy_score: result.ranking_score, data_quality: result.data_quality,
  });
  await tg.sendMessage(chatId, '✅ تم النشر.', { throttle: false });
}

async function cmdCancel({ chatId, args }) {
  const matchId = args[0];
  if (!matchId) return tg.sendMessage(chatId, '⚠️ اكتب معرف المباراة.', { throttle: false });
  const p = db.getPredictionByMatch(matchId);
  if (!p) return tg.sendMessage(chatId, '⚠️ لا يوجد توقع منشور لهذه المباراة.', { throttle: false });
  try {
    if (p.channel_message_id && config.telegram.channelId) {
      await tg.deleteMessage(config.telegram.channelId, p.channel_message_id);
    }
  } catch (e) { /* ignore */ }
  db.deletePredictionByMatch(matchId);
  await tg.sendMessage(chatId, '🗑️ تم حذف التوقع.', { throttle: false });
}

async function cmdLeagues({ chatId }) {
  const inc = config.leaguePolicy.includeOnly.join(', ') || 'الكل';
  const exc = config.leaguePolicy.exclude.join(', ') || 'لا يوجد';
  const minP = config.leaguePolicy.minimumPriority;
  await tg.sendMessage(chatId, [
    '⚽ <b>سياسة الدوريات</b>',
    `• تضمين: <b>${escapeHtml(inc)}</b>`,
    `• استبعاد: <b>${escapeHtml(exc)}</b>`,
    `• أولوية دنيا: <b>${minP}</b>`,
  ].join('\n'), { throttle: false });
}

async function cmdExclude({ chatId, args }) {
  const v = (args[0] || '').toLowerCase();
  if (!v) return tg.sendMessage(chatId, '⚠️ اكتب نصاً.', { throttle: false });
  if (!config.leaguePolicy.exclude.includes(v)) config.leaguePolicy.exclude.push(v);
  db.stateSet('leagues_exclude', config.leaguePolicy.exclude.join(','));
  await tg.sendMessage(chatId, `✅ تم استبعاد: <b>${escapeHtml(v)}</b>`, { throttle: false });
}
async function cmdInclude({ chatId, args }) {
  const v = (args[0] || '').toLowerCase();
  if (!v) return tg.sendMessage(chatId, '⚠️ اكتب نصاً.', { throttle: false });
  if (!config.leaguePolicy.includeOnly.includes(v)) config.leaguePolicy.includeOnly.push(v);
  db.stateSet('leagues_include', config.leaguePolicy.includeOnly.join(','));
  await tg.sendMessage(chatId, `✅ تم تضمين: <b>${escapeHtml(v)}</b>`, { throttle: false });
}

async function cmdChannels({ chatId }) {
  try {
    const ch = await tg.getChat(config.telegram.channelId);
    await tg.sendMessage(chatId, [
      '📣 <b>القناة</b>',
      `• المعرّف: <code>${escapeHtml(String(config.telegram.channelId))}</code>`,
      `• الاسم: <b>${escapeHtml(ch.title || '—')}</b>`,
      `• النوع: <b>${escapeHtml(ch.type || '—')}</b>`,
      `• الأعضاء: <b>${ch.member_count || '—'}</b>`,
    ].join('\n'), { throttle: false });
  } catch (e) {
    await tg.sendMessage(chatId, `⚠️ تعذّر الوصول إلى القناة: ${escapeHtml(e.message)}`, { throttle: false });
  }
}

let _pinEnabled = false;
async function cmdPin({ chatId, args }) {
  const v = (args[0] || '').toLowerCase();
  if (!['on', 'off'].includes(v)) return tg.sendMessage(chatId, '⚠️ اكتب on أو off.', { throttle: false });
  _pinEnabled = (v === 'on');
  await tg.sendMessage(chatId, `✅ التثبيت: <b>${v}</b>`, { throttle: false });
}

async function run() {
  let offset = null;
  // Initialise — drop pending updates so we don't process a backlog.
  try {
    const r = await tg.getUpdates({ offset: undefined, timeout: 0, allowed_updates: ['message', 'callback_query'] });
    if (Array.isArray(r) && r.length) offset = r[r.length - 1].update_id + 1;
  } catch (e) {
    log.warn('updates.init.failed', { err: e.message });
  }
  // Long poll loop
  while (true) {
    try {
      const updates = await tg.getUpdates({ offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
      for (const u of updates) {
        try { await handleUpdate(u); } catch (e) {
          log.warn('handleUpdate.failed', { err: e.message });
        }
        offset = u.update_id + 1;
      }
    } catch (e) {
      log.warn('updates.loop.failed', { err: e.message });
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

module.exports = { run, COMMANDS, handleUpdate };
