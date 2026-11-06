'use strict';

const advisory = require('./trader-advisory-policy');
const { digest } = require('./trader-observer');
const VERSION = 'trader-scan-inputs-v1';

// Read observations and suggest research candidates through the ordinary LEO scan.
// This module owns no execution client and cannot authorize an instrument.
async function prepare({ observer, state, observerState, universe, allowedAssets, allowedCategories, quotes, overrides, clock = Date.now }) {
  let collection = { status: 'CACHE_ONLY', requestedTraders: 0, maximumReads: 0 };
  const before = observer.view();
  const due = (before.traders || []).filter(t => {
    const last = Date.parse(t.lastAttempt?.at);
    return !Number.isFinite(last) || clock() - last >= 900000;
  }).sort((a, b) => {
    const aTime = Date.parse(a.lastAttempt?.at) || 0;
    const bTime = Date.parse(b.lastAttempt?.at) || 0;
    return aTime - bTime || a.realCID - b.realCID;
  });
  // At most five configured traders, with three GETs each. Existing observer
  // quota/cooldown remains authoritative, including interactive collectors.
  const outcomes = [];
  for (const trader of due.slice(0, 5)) {
    try {
      const result = await observer.refreshForScan(trader.realCID);
      outcomes.push(['AVAILABLE', 'PARTIAL'].includes(result.status));
    } catch { outcomes.push(false); }
  }
  if (outcomes.length) collection = { status: outcomes.every(Boolean) ? 'PARTIAL' : outcomes.some(Boolean) ? 'PARTIAL_COLLECTION' : 'UNAVAILABLE',
    requestedTraders: outcomes.length, maximumReads: outcomes.length * 3 };
  const now = clock(), view = observer.view();
  const result = advisory.evaluate({ state, observerView: view, observerState, ideas: [], overrides, now });
  const candidates = new Map(), excluded = new Map(), unsuitable = new Set();
  const allowed = new Set(allowedAssets), categories = new Set(allowedCategories);
  const reject = reason => excluded.set(reason, (excluded.get(reason) || 0) + 1);
  for (const assessment of result.report.assessments) {
    if (!assessment.usableForContext || result.state.roster[assessment.traderId]?.state !== 'SELECTED_CONTEXT_ONLY') {
      reject('SOURCE_NOT_SELECTED_OR_NOT_CURRENT');
      continue;
    }
    const trader = view.traders.find(t => t.realCID === assessment.traderId);
    const receivedAt = Date.parse(trader.snapshot.receivedAt || trader.snapshot.collectedAt);
    if (!Number.isFinite(receivedAt) || receivedAt > now) { reject('SOURCE_NOT_YET_RECEIVED'); continue; }
    const positions = trader.snapshot.portfolio.positions;
    for (const instrumentId of [...new Set(positions.map(p => p.instrumentId))]) {
      const matches = universe.filter(r => r.instrumentId === instrumentId);
      if (matches.length !== 1 || universe.some(r => r.symbol === matches[0]?.symbol && r.instrumentId !== instrumentId)) { reject('INSTRUMENT_IDENTITY_UNKNOWN_OR_AMBIGUOUS'); continue; }
      const instrument = matches[0];
      if (!allowed.has(instrument.symbol) || !categories.has(instrument.category)) { reject('INSTRUMENT_NOT_ALLOWED_BY_LEO'); continue; }
      // Opposing, unknown or leveraged holdings remain visible as exclusions.
      const rows = positions.filter(p => p.instrumentId === instrumentId);
      if (rows.some(p => p.isBuy !== true || p.leverage !== 1)) { unsuitable.add(instrumentId); reject('SOURCE_DIRECTION_OR_LEVERAGE_UNSUITABLE'); continue; }
      const quote = quotes?.[instrument.symbol], quoteAt = Date.parse(quote?.date);
      if (!Number.isFinite(quoteAt) || now < quoteAt || now - quoteAt > result.report.policy.quoteMaxAgeMs ||
          !Number.isFinite(quote?.bid) || !Number.isFinite(quote?.ask) || quote.bid <= 0 || quote.ask < quote.bid) { reject('QUOTE_MISSING_STALE_OR_INVALID'); continue; }
      let candidate = candidates.get(instrumentId);
      if (!candidate) {
        candidate = { instrumentId, asset: instrument.symbol, category: instrument.category,
          evidence: 'OBSERVED_HOLDING', transactionProven: false, effectiveAt: null,
          sourceIndependence: 'UNVERIFIED', traderSources: [] };
        candidates.set(instrumentId, candidate);
      }
      candidate.traderSources.push({ traderId: assessment.traderId, observationId: assessment.observationId, receivedAt: trader.snapshot.receivedAt || trader.snapshot.collectedAt });
    }
  }
  for (const instrumentId of unsuitable) candidates.delete(instrumentId);
  const rows = [...candidates.values()].sort((a, b) => a.instrumentId - b.instrumentId);
  // Rotate the research slot deterministically rather than favoring low IDs forever.
  const offset = rows.length ? Math.floor(now / 7200000) % rows.length : 0;
  const ordered = [...rows.slice(offset), ...rows.slice(0, offset)];
  const input = { inputVersion: VERSION, generatedAt: new Date(now).toISOString(), policyVersion: advisory.VERSION, policyId: result.state.policyId,
    status: ordered.length ? 'AVAILABLE_CONTEXT_ONLY' : 'UNAVAILABLE', collection,
    candidates: ordered.slice(0, 20), omittedCandidates: Math.max(0, ordered.length - 20),
    exclusions: [...excluded].sort(([a], [b]) => a.localeCompare(b)).map(([reason, count]) => ({ reason, count })),
    instruction: 'Evaluate observed holdings with LEO analysis, costs and exposure controls. Shared holdings do not prove independent signals. Only explicit managed-position decisions may propose exits.',
    executionAllowed: false };
  input.inputId = digest(input);
  return { state: advisory.compactState(result.state), input };
}

function prioritize(preferred, input) {
  const candidate = input?.candidates?.find(c => preferred.some(p => p.asset === c.asset && p.eligibleForTrade));
  if (!candidate) return preferred;
  const row = preferred.find(p => p.asset === candidate.asset);
  return [row, ...preferred.filter(p => p.asset !== candidate.asset)];
}

function writerVerified(proof, now) {
  return proof?.ownLease === true && Number.isFinite(proof.checkedAt) && Number.isFinite(proof.leaseRemainingMs) &&
    proof.leaseRemainingMs > 0 && now >= proof.checkedAt && now < proof.checkedAt + proof.leaseRemainingMs;
}

module.exports = { VERSION, prepare, prioritize, writerVerified };
