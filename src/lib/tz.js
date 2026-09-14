'use strict';

// Timezone helpers — default Africa/Algiers.
// All epoch math is TZ-agnostic; these are only needed for:
//   • Displaying local times in Arabic
//   • Deciding "is it morning?" / "is it evening?" boundaries
//   • Computing kickoff − PREDICT_MINUTES_BEFORE in wall-clock terms

const config = require('./config');

const DEFAULT_TZ = 'Africa/Algiers';

function tz() {
  return config.tz || DEFAULT_TZ;
}

// Returns { year, month, day, hour, minute } in the configured timezone.
function localParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) {
    if (type === 'year') p.year = parseInt(value, 10);
    else if (type === 'month') p.month = parseInt(value, 10);
    else if (type === 'day') p.day = parseInt(value, 10);
    else if (type === 'hour') p.hour = parseInt(value, 10);
    else if (type === 'minute') p.minute = parseInt(value, 10);
    else if (type === 'second') p.second = parseInt(value, 10);
  }
  return p;
}

// "YYYY-MM-DD" in local timezone
function localDateString(date = new Date()) {
  const p = localParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

// "HH:MM" in local timezone
function localTimeString(date = new Date()) {
  const p = localParts(date);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

// Today's midnight UTC epoch (NOT local) — used for DB queries.
function todayStartEpoch() {
  const p = localParts();
  // Build a Date from local parts interpreted as UTC — gives us a stable
  // epoch that corresponds to "today at midnight in local tz" as if it were UTC.
  return Math.floor(Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0) / 1000);
}

// Tomorrow's midnight UTC epoch.
function tomorrowStartEpoch() {
  return todayStartEpoch() + 86400;
}

// Epoch for "days ahead" in wall-clock local time (e.g. 2 days ahead).
function futureEpoch(daysAhead) {
  return todayStartEpoch() + daysAhead * 86400;
}

// Returns true if the current local time is between `fromHH:MM` and `toHH:MM`
// (inclusive of from, exclusive of to). Handles day wrap if to < from.
function inTimeWindow(fromHHMM, toHHMM) {
  const p = localParts();
  const now = p.hour * 60 + p.minute;
  const [fh, fm] = fromHHMM.split(':').map(Number);
  const [th, tm] = toHHMM.split(':').map(Number);
  const from = fh * 60 + fm;
  const to = th * 60 + tm;
  if (from <= to) {
    return now >= from && now < to;
  }
  // wraps midnight
  return now >= from || now < to;
}

// Does the current local date match a YYYY-MM-DD string?
function isToday(dateStr) {
  return dateStr === localDateString();
}

// Does the current local date match yesterday?
function isYesterday(dateStr) {
  const d = new Date(Date.now() - 86400000);
  return dateStr === localDateString(d);
}

// Seconds from now until `epoch`. Negative if in the past.
function secondsUntil(epoch) {
  return epoch - Math.floor(Date.now() / 1000);
}

// Given a kickoff UTC epoch and hours-before, returns the epoch when the
// prediction should be published.
function publishAtEpoch(kickoffEpoch, hoursBefore) {
  return kickoffEpoch - hoursBefore * 3600;
}

module.exports = {
  tz,
  localParts,
  localDateString,
  localTimeString,
  todayStartEpoch,
  tomorrowStartEpoch,
  futureEpoch,
  inTimeWindow,
  isToday,
  isYesterday,
  secondsUntil,
  publishAtEpoch,
  DEFAULT_TZ,
};
