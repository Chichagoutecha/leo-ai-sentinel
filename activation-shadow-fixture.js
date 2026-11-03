'use strict';
// Synthetic design-period fixture. Relaxed qualification criteria are NOT release criteria.
const START = Date.parse('2026-11-02T12:00:00Z'), DAY = 86400000, iso = n => new Date(n).toISOString();
function fixture(now = START, n = 1) {
  const observationId = n.toString(16).padStart(64, '0');
  const snapshot = { realCID: 7, identity: { realCID: 7, gcid: 8 }, collectedAt: iso(now), receivedAt: iso(now), effectiveAt: null,
    portfolio: { status: 'PARTIAL', complete: false, positions: [{ key: 'DIRECT:100', instrumentId: 1, positionId: 100, isBuy: true, leverage: 1, investmentPct: 20 }] },
    performance: { monthly: [], historyComplete: null }, sources: { portfolio: 'https://public-api.etoro.com/test-fixture' } };
  const q = { mid: 10, ask: 10, bid: 10, date: iso(now), receivedAt: iso(now), priceStatus: 'FRESH', eligibleForTrade: true, source: 'TEST_FIXTURE' };
  return { now, cycleId: `decision-${String(n).padStart(8, '0')}`, mode: 'SHADOW', universe: [{ symbol: 'AAPL', instrumentId: 1, category: 'STOCK' }, { symbol: 'SPY', instrumentId: 2, category: 'ETF' }],
    rawDecision: { decision: 'BUY', asset: 'AAPL', amount_usd: 10 }, control: { approved: true, finalDecision: { decision: 'BUY', asset: 'AAPL', amount_usd: 10 }, code: 'APPROVED' },
    template: { cash: 1000, positions: { AAPL: { asset: 'AAPL', units: 10, costBasis: 100, currentPrice: 10, currentValue: 100, averageEntryPrice: 10, openedAt: iso(START - DAY) } }, seedCoverage: { complete: true, omittedAssets: [] } },
    quotes: { AAPL: q, SPY: { ...q } }, observerView: { traders: [{ realCID: 7, observationId, status: 'PARTIAL', snapshot }] },
    observerState: { traders: { 7: { observationId, snapshot } }, observations: [{ id: observationId, realCID: 7, collectedAt: iso(now), receivedAt: iso(now) }], events: [] },
    costs: { 1: { instrumentId: 1, side: 'BUY', asOf: iso(now), amountUsd: 10, currency: 'USD', contextBinding: 'VERIFIED_SAME_ACCOUNT', coverage: 'COMPLETE_ESTIMATE', allInCostPct: 0.2, unresolvedComponents: [] } },
    eligibility: { 1: { instrumentId: 1, side: 'BUY', asOf: iso(now), technicalEligible: true, leoPolicyAllowed: true, contextBinding: 'VERIFIED_SAME_ACCOUNT', minimumUsd: 1, maximumUsd: 100, currency: 'USD', leverage: 1, orderType: 'MARKET', settlementType: 'Underlying' } },
    pendingComplete: true, constraintsEvidence: { verified: true, virtualOnly: true, currency: 'USD', lookThroughCoverage: 'COMPLETE', asOf: iso(now) },
    advisoryOverrides: { qualifyingObservations: 1, probationDays: 0.001 }, experimentOverrides: { designDays: 1, evaluationDays: 10, minimumEvaluationDays: 3, minimumDecisions: 2, minimumFullClosures: 1 },
    assumptions: { feePct: 0.1, slippageBps: 1, benchmarkAsset: 'SPY', benchmarkCurrency: 'USD' } };
}

module.exports = { START, DAY, iso, fixture };
