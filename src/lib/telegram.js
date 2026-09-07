'use strict';

// Minimal Telegram Bot API client (raw fetch, no extra deps).
//
// Supports the calls we actually use:
//   • sendMessage, editMessageText, deleteMessage
//   • getUpdates (long-poll) for command parsing
//   • getMe, getChat, getChatMember
//
// Honours rate limits (1 msg/sec globally + per-chat limit), retries on 429.

const config = require('./config');
const log = require('./logger');

const BASE = `${config.telegram.apiBase}/bot${config.telegram.botToken}`;

let _lastGlobal = 0;
let _lastPerChat = new Map(); // chatId -> ts
const MIN_GLOBAL_INTERVAL = 1100;
const MIN_CHAT_INTERVAL = 1100;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function rateWait(chatId) {
  const now = Date.now();
  const sinceGlobal = now - _lastGlobal;
  if (sinceGlobal < MIN_GLOBAL_INTERVAL) await sleep(MIN_GLOBAL_INTERVAL - sinceGlobal);
  if (chatId != null) {
    const last = _lastPerChat.get(chatId) || 0;
    const since = Date.now() - last;
    if (since < MIN_CHAT_INTERVAL) await sleep(MIN_CHAT_INTERVAL - since);
  }
  _lastGlobal = Date.now();
  if (chatId != null) _lastPerChat.set(chatId, Date.now());
}

async function call(method, params, opts = {}) {
  const url = `${BASE}/${method}`;
  const maxRetries = opts.retries != null ? opts.retries : 4;
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (opts.throttle !== false) {
      await rateWait(params && params.chat_id);
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
      });
      if (res.status === 429) {
        const j = await res.json().catch(() => ({}));
        const wait = (j && j.parameters && j.parameters.retry_after) ? j.parameters.retry_after * 1000 : 1500;
        log.warn('telegram.429', { method, waitMs: wait });
        await sleep(Math.min(wait, 15000));
        continue;
      }
      if (!res.ok) {
        const txt = await res.text();
        lastErr = new Error(`Telegram ${method} ${res.status}: ${txt.slice(0, 300)}`);
        log.warn('telegram.error', { method, status: res.status, txt: txt.slice(0, 200) });
        await sleep(500 * Math.pow(2, attempt));
        continue;
      }
      const json = await res.json();
      if (!json.ok) {
        lastErr = new Error(`Telegram ${method}: ${json.description || 'unknown'}`);
        log.warn('telegram.api_error', { method, desc: json.description, code: json.error_code });
        // Don't retry permission errors etc.
        if ([400, 401, 403].includes(json.error_code)) throw lastErr;
        await sleep(500 * Math.pow(2, attempt));
        continue;
      }
      return json.result;
    } catch (e) {
      lastErr = e;
      log.warn('telegram.network', { method, err: e.message });
      await sleep(500 * Math.pow(2, attempt));
    }
  }
  throw lastErr || new Error(`Telegram ${method} failed`);
}

async function sendMessage(chatId, text, opts = {}) {
  const params = {
    chat_id: chatId,
    text,
    parse_mode: opts.parse_mode || config.telegram.parseMode,
    disable_web_page_preview: opts.disable_web_page_preview != null ? opts.disable_web_page_preview : config.telegram.disableWebPagePreview,
  };
  if (opts.reply_markup) params.reply_markup = JSON.stringify(opts.reply_markup);
  if (opts.message_thread_id != null) params.message_thread_id = opts.message_thread_id;
  return call('sendMessage', params, { throttle: opts.throttle });
}

async function editMessageText(chatId, messageId, text, opts = {}) {
  return call('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: opts.parse_mode || config.telegram.parseMode,
    disable_web_page_preview: opts.disable_web_page_preview != null ? opts.disable_web_page_preview : config.telegram.disableWebPagePreview,
  });
}

async function deleteMessage(chatId, messageId) {
  return call('deleteMessage', { chat_id: chatId, message_id: messageId });
}

async function getUpdates({ offset, timeout = 25, allowed_updates } = {}) {
  const body = { timeout, allowed_updates: allowed_updates || ['message', 'edited_message', 'callback_query'] };
  if (offset != null) body.offset = offset;
  return call('getUpdates', body, { throttle: false, retries: 1 });
}

async function getMe() { return call('getMe', {}, { retries: 1 }); }

async function getChat(chatId) { return call('getChat', { chat_id: chatId }); }

async function getChatMember(chatId, userId) { return call('getChatMember', { chat_id: chatId, user_id: userId }); }

async function sendChatAction(chatId, action = 'typing') {
  try { return call('sendChatAction', { chat_id: chatId, action }, { retries: 0, throttle: false }); }
  catch (e) { /* ignore */ }
}

function isAdmin(userId) {
  return config.telegram.adminIds.includes(userId);
}

module.exports = {
  call, sendMessage, editMessageText, deleteMessage,
  getUpdates, getMe, getChat, getChatMember, sendChatAction,
  isAdmin,
};
