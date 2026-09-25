'use strict';

// Read-only, bounded view of the broker evidence already collected by the
// execution observer. Missing historical orders and unknown costs stay unknown.
function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function money(value) { return Math.round(value * 1e6) / 1e6; }

function normalizeClosedHistory(data, observations) {
  if (!Array.isArray(data)) return { valid: false, reason: 'HISTORY_RESPONSE_NOT_ARRAY', matches: {} };
  const known = new Map((observations || []).filter((row) => row?.side === 'BUY' &&
    row.confirmation?.proof === 'BROKER_POSITION_ID_VISIBLE_IN_REAL_PNL')
    .map((row) => [String(row.confirmation.positionId), row]));
  const matches = {};
  const ambiguous = new Set();
  for (const trade of data) {
    if (!trade || typeof trade !== 'object') continue;
    const rawId = trade.positionId;
    const key = rawId === null || rawId === undefined || rawId === '' ? '' : String(rawId);
    const buy = known.get(key);
    if (!buy || ambiguous.has(key)) continue;
    const instrumentId = numberOrNull(trade.instrumentId);
    const netProfit = numberOrNull(trade.netProfit);
    const fees = numberOrNull(trade.fees);
    const orderId = trade.orderId === null || trade.orderId === undefined ? null : String(trade.orderId);
    const expectedOrderId = buy.brokerResponse?.orderId;
    if (!Number.isSafeInteger(instrumentId) || instrumentId !== Number(buy.executionInstrumentId) ||
        netProfit === null || !Number.isFinite(Date.parse(trade.closeTimestamp)) ||
        (expectedOrderId && orderId && String(expectedOrderId) !== orderId)) continue;
    if (matches[key]) { delete matches[key]; ambiguous.add(key); continue; }
    matches[key] = {
      positionId: key, instrumentId, orderId, netProfitUsdVirtual: money(netProfit),
      feesUsdVirtual: fees !== null ? money(fees) : null,
      closeTimestamp: trade.closeTimestamp,
      provenance: 'ETORO_REAL_TRADE_HISTORY_EXACT_POSITION_INSTRUMENT'
    };
  }
  return { valid: true, matches, ambiguousPositionIds: [...ambiguous],
    ambiguousPositions: ambiguous.size, unmatchedHistoryRows: data.length - Object.keys(matches).length };
}

function buildLedger(observations = [], snapshot = null, limit = 100, history = {}) {
  const rows = Array.isArray(observations) ? observations : [];
  const validSnapshot = snapshot?.valid === true ? snapshot : null;
  const buys = rows.filter((row) => row?.side === 'BUY' && row.confirmation?.proof === 'BROKER_POSITION_ID_VISIBLE_IN_REAL_PNL');
  const sells = rows.filter((row) => row?.side === 'SELL' && row.confirmation?.proof === 'EXACT_TARGET_POSITION_ID_REMOVED_FROM_REAL_PNL');
  const sellByPosition = new Map();
  for (const sell of sells) {
    const key = String(sell.targetPositionId || '');
    if (!sellByPosition.has(key)) sellByPosition.set(key, []);
    sellByPosition.get(key).push(sell);
  }
  const entries = buys.map((buy) => {
    const positionId = String(buy.confirmation.positionId);
    const matchingSells = sellByPosition.get(positionId) || [];
    const sell = matchingSells.length === 1 && matchingSells[0].fullCloseRequested === true &&
      Number(matchingSells[0].executionInstrumentId) === Number(buy.executionInstrumentId)
      ? matchingSells[0] : null;
    const open = validSnapshot?.positionsById?.[positionId] || null;
    const openMatches = open && Number(open.instrumentId) === Number(buy.executionInstrumentId);
    const closedTrade = history?.[positionId];
    const historyMatches = closedTrade && Number(closedTrade.instrumentId) === Number(buy.executionInstrumentId);
    const state = historyMatches ? 'BROKER_CLOSED_TRADE' : sell ? 'CLOSE_OBSERVED' : openMatches ? 'OPEN_OBSERVED' : 'OUTCOME_UNKNOWN';
    const grossUnrealized = openMatches ? numberOrNull(open.profitUsdVirtual) : null;
    // PnL on an open position does not prove realized PnL. Disappearance and
    // account-wide cash movements do not isolate proceeds or transaction fees.
    const realizedGross = numberOrNull(sell?.confirmation?.realizedPnlUsdVirtual);
    const brokerNet = historyMatches ? numberOrNull(closedTrade.netProfitUsdVirtual) : null;
    const fees = historyMatches ? numberOrNull(closedTrade.feesUsdVirtual) : null;
    const aiCost = numberOrNull(buy?.decisionTrace?.aiCostUsd);
    const fxCost = numberOrNull(sell?.confirmation?.fxFeesUsdVirtual);
    // eToro calls this field netProfit: its fees must never be subtracted again.
    // FX/account-wide expenses and AI costs are only deducted if attributed.
    const net = brokerNet !== null && fxCost !== null && aiCost !== null
      ? money(brokerNet - fxCost - aiCost) : null;
    return {
      positionId, asset: buy.asset, executionInstrumentId: buy.executionInstrumentId,
      decision: buy.decisionTrace || null,
      signalToOrder: { buyObservationId: buy.id, buyOrderId: buy.brokerResponse?.orderId || null,
        buyConfirmedAt: buy.confirmation.confirmedAt, sellObservationId: sell?.id || null,
        sellOrderId: sell?.brokerResponse?.orderId || null, sellConfirmedAt: sell?.confirmation?.confirmedAt || null },
      state, investedUsdVirtual: numberOrNull(buy.confirmation.virtualInvestedAmountUsd),
      unrealizedBrokerProfitUsdVirtual: grossUnrealized,
      realizedGrossUsdVirtual: realizedGross,
      brokerNetProfitUsdVirtual: brokerNet,
      brokerNetProfitSource: brokerNet === null ? null : closedTrade.provenance,
      brokerClosedAt: historyMatches ? closedTrade.closeTimestamp : null,
      observedBrokerFeesUsdVirtual: fees, observedFxFeesUsdVirtual: fxCost,
      attributedAiCostUsd: aiCost, realizedNetUsdVirtual: net,
      buySlippageBps: numberOrNull(buy.executionQuality?.slippageBps),
      sellSlippageBps: numberOrNull(sell?.executionQuality?.slippageBps),
      missingForNet: ['CLOSE_OBSERVED', 'BROKER_CLOSED_TRADE'].includes(state) ? [
        brokerNet === null && 'EXACT_BROKER_NET_PROFIT',
        fxCost === null && 'ATTRIBUTED_EXTERNAL_FX_COST', aiCost === null && 'ATTRIBUTED_AI_COST'
      ].filter(Boolean) : [],
      copierProfitObserved: false
    };
  });
  const linkedSellIds = new Set(entries.map((entry) => entry.signalToOrder.sellObservationId).filter(Boolean));
  const ready = entries.filter((entry) => entry.realizedNetUsdVirtual !== null);
  const safeLimit = Math.max(1, Math.min(250, Number(limit) || 100));
  return {
    mode: 'shadow', scope: 'RETAINED_EXACT_BUY_PROOFS_ONLY',
    snapshotObservedAt: validSnapshot?.observedAt || null,
    counts: { confirmedBuys: buys.length, pairedCloses: entries.filter((entry) => entry.signalToOrder.sellObservationId).length,
      historyConfirmedCloses: entries.filter((entry) => entry.state === 'BROKER_CLOSED_TRADE').length,
      unpairedConfirmedSells: sells.filter((sell) => !linkedSellIds.has(sell.id)).length,
      completeNetOutcomes: ready.length, missingDecisionTrace: buys.filter((buy) => !buy.decisionTrace).length },
    realizedNetTotalUsdVirtual: ready.length && ready.length === entries.filter((entry) =>
      ['CLOSE_OBSERVED', 'BROKER_CLOSED_TRADE'].includes(entry.state)).length
      ? money(ready.reduce((total, entry) => total + entry.realizedNetUsdVirtual, 0)) : null,
    entries: entries.slice(-safeLimit),
    caveat: 'Broker netProfit includes broker-side net result; do not subtract its fees again. External FX and AI costs require separate attribution. Cash changes and slippage are not additive fees. History may be paginated and the copier account is not observed.'
  };
}

module.exports = { buildLedger, normalizeClosedHistory };
