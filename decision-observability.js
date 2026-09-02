'use strict';

/**
 * LEO-AI SENTINEL — Decision observability.
 *
 * Enriches only the compact SCAN AUTO RESULT log with the latest sanitized
 * decision diagnostics produced by ai-decision-context-v2. It does not change
 * the decision, risk result, sizing, broker request, scheduler callback, or order.
 */

const VERSION = 'v10.22.15.0-decision-observability';
const ENABLED = process.env.DECISION_OBSERVABILITY_ENABLED !== 'false';
const AUTO_INSTALL = process.env.DECISION_OBSERVABILITY_AUTO_INSTALL !== 'false';
const MAX_DIAGNOSTIC_AGE_MS = Math.max(30000, Math.min(10 * 60 * 1000, Number(process.env.DECISION_OBSERVABILITY_MAX_AGE_MS || 180000)));
const SENSITIVE_RE = /(secret|password|authorization|cookie|x-api-key|x-user-key|apikey|api_key|userkey|user_key|token|referenceid|request_id|requestid)/i;

let installed = false;
let lastEnrichedAt = null;
let enrichedCount = 0;

function isObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function safeJsonParse(value) { try { return JSON.parse(value); } catch { return null; } }
function safeJson(value) { try { return JSON.stringify(value); } catch { return null; } }

function sanitize(value, depth = 0) {
  if (depth > 8 || value === undefined) return undefined;
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…[truncated]`;
    return value;
  }
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => sanitize(item, depth + 1)).filter((item) => item !== undefined);
  if (!isObject(value)) return String(value);
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_RE.test(key)) continue;
    const sanitized = sanitize(child, depth + 1);
    if (sanitized !== undefined) out[key] = sanitized;
  }
  return out;
}

function diagnosticAgeMs(diagnostics, nowMs = Date.now()) {
  const stamp = diagnostics?.completedAt || diagnostics?.generatedAt;
  const time = Date.parse(stamp || '');
  return Number.isFinite(time) ? Math.max(0, nowMs - time) : Infinity;
}

function enrichScanResult(result, diagnostics, nowMs = Date.now()) {
  if (!ENABLED || !isObject(result) || result.event !== 'SCAN_COMPLETED') return result;
  if (!isObject(diagnostics)) return result;
  const ageMs = diagnosticAgeMs(diagnostics, nowMs);
  if (!Number.isFinite(ageMs) || ageMs > MAX_DIAGNOSTIC_AGE_MS) return result;
  const source = String(diagnostics.source || '');
  if (source && result.source && source !== result.source) return result;

  return {
    ...result,
    decision_diagnostics: {
      ...sanitize(diagnostics),
      age_ms_at_scan_result: Math.round(ageMs),
      observability_version: VERSION,
      governance: {
        ...(sanitize(diagnostics.governance || {})),
        logOnly: true,
        decisionModified: false,
        riskModified: false,
        sizingModified: false,
        orderModified: false,
        schedulerModified: false
      }
    }
  };
}

function install() {
  if (!AUTO_INSTALL || !ENABLED || installed) return { installed, enabled: ENABLED, version: VERSION };
  const originalLog = console.log.bind(console);
  console.log = (...args) => {
    try {
      if (args[0] === 'SCAN AUTO RESULT:' && typeof args[1] === 'string') {
        const parsed = safeJsonParse(args[1]);
        const diagnostics = typeof global.__LEO_DECISION_DIAGNOSTICS__ === 'function'
          ? global.__LEO_DECISION_DIAGNOSTICS__()
          : null;
        const enriched = enrichScanResult(parsed, diagnostics, Date.now());
        if (enriched !== parsed) {
          const text = safeJson(enriched);
          if (text) {
            enrichedCount += 1;
            lastEnrichedAt = new Date().toISOString();
            return originalLog(args[0], text, ...args.slice(2));
          }
        }
      }
    } catch {}
    return originalLog(...args);
  };
  installed = true;
  originalLog(`[LEO_DECISION_OBSERVABILITY] ${JSON.stringify({
    component: 'LEO_DECISION_OBSERVABILITY',
    version: VERSION,
    event: 'STARTED',
    at: new Date().toISOString(),
    enabled: ENABLED,
    maxDiagnosticAgeMs: MAX_DIAGNOSTIC_AGE_MS,
    logOnly: true,
    decisionModified: false,
    riskModified: false,
    sizingModified: false,
    orderModified: false,
    schedulerModified: false,
    secretsLogged: false
  })}`);
  return { installed: true, enabled: true, version: VERSION };
}

const autoInstalled = install();

global.__LEO_DECISION_OBSERVABILITY_STATE__ = () => ({
  version: VERSION,
  enabled: ENABLED,
  installed,
  enrichedCount,
  lastEnrichedAt,
  maxDiagnosticAgeMs: MAX_DIAGNOSTIC_AGE_MS,
  governance: {
    logOnly: true,
    decisionModified: false,
    riskModified: false,
    sizingModified: false,
    orderModified: false,
    schedulerModified: false
  }
});

module.exports = {
  VERSION,
  sanitize,
  diagnosticAgeMs,
  enrichScanResult,
  install,
  autoInstalled
};
