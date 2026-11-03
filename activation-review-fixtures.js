'use strict';
// Offline fixtures only: synthetic identities, evidence, permissions and broker. No HTTP or process.env.
const assert = require('node:assert/strict');
const b = require('./trader-execution-bridge');
const { progressFor } = require('./order-finality-fixtures');
const NOW = Date.parse('2026-11-02T12:00:00Z'), at = new Date(NOW).toISOString();
function buy(id = 'proposal-1') { return { proposalId: id, decisionId: `decision-${id}`, policyVersion: 'trader-context-v1', policyId: 'a'.repeat(64), createdAt: at,
  side: 'BUY', asset: 'AAPL', instrumentId: 1, amountUsd: 10, scope: 'REAL_MANAGED_STRATEGY', decision: 'ADVISORY_REVIEW_ONLY', leoConfidence: 85, referencePrice: 10, priceDriftLimitPct: 2,
  traderSources: [{ traderId: 7, observationId: 'b'.repeat(64) }] }; }
function sell(id = 'exit-1', units = 1) { const p = buy(id); delete p.amountUsd; return { ...p, side: 'SELL', positionId: '101', units, quantityMode: 'FULL_POSITION' }; }
function settings() { return { enabled: true, entriesEnabled: true, exitsEnabled: true, confirmation: 'I_UNDERSTAND_TRADER_STRATEGY_REAL_ORDERS', maxOrderUsd: 10, maxExitNotionalUsd: 100, maxCostUsd: 1 }; }
function initialized() { return b.initializeForContext(b.initialState(), { identityVerified: true, tokenBindingVerified: true, accountRef: 'fixture-account', mode: 'LIVE', executionHistoryReviewed: true }); }
function row(units = 1, id = '101') { return { asset: 'AAPL', positionId: id, instrumentId: 1, ownership: 'DIRECT', isBuy: true, leverage: 1, settlementType: 'Underlying', units }; }
function evidence(p, positions = []) { return { mode: 'LIVE', armed: true, buyArmed: true, accountRef: 'fixture-account', identityVerified: true, tokenBindingVerified: true,
  release: { status: 'APPROVED_CHRONOLOGICAL_EVALUATION', policyVersion: p.policyVersion, policyId: p.policyId, accountRef: 'fixture-account', environment: 'REAL', sampleStatus: 'SUFFICIENT', liveAccountReviewed: true, approvedAt: at, evaluationEndAt: at },
  asOf: at, portfolioComplete: true, pendingComplete: true, positions, uncertainOrPending: false,
  instrument: { asset: 'AAPL', instrumentId: 1, allowed: true }, quote: { instrumentId: 1, currency: 'USD', bid: 10, ask: 10, asOf: at },
  eligibility: { instrumentId: 1, side: p.side, allowed: true, accountRef: 'fixture-account', currency: 'USD', leverage: 1, settlementType: 'Underlying', minimumUsd: 1, maximumUsd: 100, asOf: at },
  cost: { instrumentId: 1, side: p.side, accountRef: 'fixture-account', coverage: 'COMPLETE_ESTIMATE', totalUsd: 0.1, amountUsd: p.amountUsd, units: p.units, asOf: at },
  risk: { approved: true, side: p.side, instrumentId: 1, proposalId: p.proposalId, amountUsd: p.amountUsd, positionId: p.side === 'SELL' ? String(p.positionId) : null, units: p.units, asOf: at },
  limits: { cadenceAllowed: true, dailyAllowed: true, singleWriterVerified: true },
  exposure: { coverage: 'COMPLETE', afterWithinLimits: true, proposalId: p.proposalId, amountUsd: p.amountUsd, units: p.units, asOf: at },
  sourceProof: { status: 'CURRENT_REFERENCES_VERIFIED', proposalId: p.proposalId, opposed: false, asOf: at }, cashUsd: 1000, reserveUsd: 200 }; }
function harness({ state = initialized(), positions = [], configure = settings(), mutate = () => {}, outcome = 'CONFIRMED', save = () => true } = {}) {
  let current = state, rows = structuredClone(positions), config = configure;
  const calls = [], saves = [];
  const persist = async () => { saves.push(structuredClone(current)); return save(saves.length); };
  const controller = b.createController({ getState: () => current, setState: s => { current = s; }, persist, clock: () => NOW,
    settings: () => config, evidence: p => { const e = evidence(p, rows); mutate(e); return e; },
    executeNormal: async (p, metadata) => {
      assert.ok(saves.some(s => s.operations[p.proposalId]?.status === 'RESERVED'));
      assert.equal(b.guardExecutor(current, metadata, rows, 'fixture-account', NOW), true);
      current.operations[p.proposalId].intentId = `intent-${p.proposalId}`;
      await persist(); // Simulates normal executor's durable intent boundary, before submission.
      calls.push({ side: p.side, proposalId: p.proposalId, positionId: p.positionId, units: p.units, metadata });
      if (outcome === 'NETWORK') throw Error('SECRET_ERROR_NOT_RETAINED');
      if (outcome === 'ACK') return { intentId: `intent-${p.proposalId}`, businessAcknowledged: true, confirmed: false };
      if (outcome === 'REJECTED') return { intentId: `intent-${p.proposalId}`, confirmed: false, verification_status: 'ORDER_REJECTED' };
      const beforeRows = rows.map(r => ({ positionId: r.positionId, units: r.units }));
      if (p.side === 'SELL') rows = rows.filter(r => r.positionId !== p.positionId);
      else if (rows.length) rows[0].units += 1;
      else rows = [row(outcome === 'PARTIAL' ? 0.4 : 1)];
      const result = { intentId: `intent-${p.proposalId}`, confirmed: true, data: { positionId: '101' }, verification: {
        beforeSnapshot: { instrumentId: 1, positionDetails: beforeRows }, afterSnapshot: { instrumentId: 1, positionDetails: rows.map(r => ({ positionId: r.positionId, units: r.units })) } } };
      result.orderProgress = progressFor(p, beforeRows, rows, outcome === 'PARTIAL' ? 'PARTIAL' : 'FILLED');
      if (outcome === 'AMBIGUOUS') result.verification.afterSnapshot.positionDetails.push({ positionId: '102', units: 1 });
      if (outcome === 'UNBOUND') delete result.data.positionId;
      return result;
    } });
  return { controller, calls, saves, get state() { return current; }, set state(s) { current = s; }, get positions() { return rows; }, set config(c) { config = c; }, queue(p) { current = b.enqueue(current, p); } };
}

module.exports = { NOW, buy, sell, settings, initialized, row, evidence, harness };
