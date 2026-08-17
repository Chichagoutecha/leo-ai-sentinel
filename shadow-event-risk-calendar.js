'use strict';

/** LEO-AI SENTINEL — Stage 13 Event Risk Calendar (Shadow only). */
const VERSION = 'v10.24.1-event-risk-calendar';
const WINDOWS = Object.freeze({
  EARNINGS: { preMin: 1440, postMin: 240, severity: 'BLOCK_NEW_BUY' },
  FOMC: { preMin: 360, postMin: 180, severity: 'BLOCK_NEW_BUY' },
  CPI: { preMin: 180, postMin: 120, severity: 'REDUCE_SIZE' },
  JOBS: { preMin: 180, postMin: 120, severity: 'REDUCE_SIZE' },
  FDA: { preMin: 2880, postMin: 1440, severity: 'BLOCK_NEW_BUY' },
  REGULATORY: { preMin: 1440, postMin: 720, severity: 'BLOCK_NEW_BUY' },
  DIVIDEND: { preMin: 60, postMin: 60, severity: 'ADVISORY' },
  OTHER: { preMin: 120, postMin: 120, severity: 'ADVISORY' }
});
const RANK = { CLEAR: 0, ADVISORY: 1, REDUCE_SIZE: 2, BLOCK_NEW_BUY: 3 };
let state = { evaluations: 0, invalidEvents: 0, duplicatesRemoved: 0, last: null };

function sanitize(s, max = 200) { return String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); }
function iso(v) { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; }
function normType(v) { const t = String(v || 'OTHER').toUpperCase(); return WINDOWS[t] ? t : 'OTHER'; }
function keyOf(e) { return `${normType(e.type)}|${String(e.symbol || 'MARKET').toUpperCase()}|${iso(e.startAt) || 'INVALID'}|${sanitize(e.sourceGroup || e.source || 'UNKNOWN',80)}`; }

function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const startAt = iso(raw.startAt);
  if (!startAt) return null;
  const type = normType(raw.type);
  const symbol = String(raw.symbol || 'MARKET').trim().toUpperCase();
  const confidence = Number(raw.confidence ?? 0.5);
  const sourceGroup = sanitize(raw.sourceGroup || raw.source || 'UNKNOWN', 80);
  return {
    id: sanitize(raw.id || keyOf(raw), 220), type, symbol, startAt,
    endAt: iso(raw.endAt), confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
    importance: sanitize(raw.importance || 'MEDIUM', 20).toUpperCase(),
    sourceClass: sanitize(raw.sourceClass || 'UNKNOWN', 40).toUpperCase(),
    sourceGroup,
    title: sanitize(raw.title || '', 180),
    injectionRejected: /ignore previous|system prompt|developer message|execute|api key|secret/i.test(String(raw.title || '') + ' ' + String(raw.summary || ''))
  };
}

function dedupeEvents(events = []) {
  const map = new Map(); let removed = 0;
  for (const raw of events) {
    const e = normalizeEvent(raw); if (!e) continue;
    const key = keyOf(e);
    if (!map.has(key) || (map.get(key).confidence < e.confidence)) map.set(key, e); else removed += 1;
  }
  return { events: [...map.values()], removed };
}

function evaluateEventRisk(events = [], context = {}) {
  const now = new Date(context.now || Date.now());
  const symbol = String(context.symbol || 'MARKET').toUpperCase();
  const d = dedupeEvents(events); state.duplicatesRemoved += d.removed;
  let severity = 'CLEAR'; const active = [];
  for (const e of d.events) {
    if (e.injectionRejected) continue;
    if (!(e.symbol === 'MARKET' || e.symbol === symbol)) continue;
    const w = WINDOWS[e.type] || WINDOWS.OTHER;
    const startMs = Date.parse(e.startAt);
    const activeStart = startMs - w.preMin * 60000;
    const activeEnd = (e.endAt ? Date.parse(e.endAt) : startMs) + w.postMin * 60000;
    if (now.getTime() >= activeStart && now.getTime() <= activeEnd) {
      const effective = e.confidence < 0.5 && w.severity === 'BLOCK_NEW_BUY' ? 'REDUCE_SIZE' : w.severity;
      active.push({ ...e, effectiveSeverity: effective, window: w });
      if (RANK[effective] > RANK[severity]) severity = effective;
    }
  }
  state.evaluations += 1;
  const result = {
    version: VERSION, at: now.toISOString(), symbol, severity,
    blockNewBuy: severity === 'BLOCK_NEW_BUY',
    sizeMultiplier: severity === 'BLOCK_NEW_BUY' ? 0 : severity === 'REDUCE_SIZE' ? 0.5 : 1,
    activeEvents: active.sort((a,b) => Date.parse(a.startAt) - Date.parse(b.startAt)),
    safety: { shadowOnly: true, canTrade: false, canSell: false, canAuthorizeLive: false, networkClientPresent: false, openAiCalls: 0 }
  };
  state.last = result; return result;
}
function getState() { return { version: VERSION, stats: { ...state }, safety: { shadowOnly: true, canTrade: false, canAuthorizeLive: false, networkClientPresent: false } }; }
global.__LEO_EVENT_RISK_STATE__ = getState;
global.__LEO_EVENT_RISK_EVALUATE__ = evaluateEventRisk;
module.exports = { VERSION, WINDOWS, normalizeEvent, dedupeEvents, evaluateEventRisk, getState };
