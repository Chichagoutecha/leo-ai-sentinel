'use strict';

// Read-only, bounded view of the broker evidence already collected by the
// execution observer. Missing historical orders and unknown costs stay unknown.
function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function money(value) { return Math.round(value * 1e6) / 1e6; }

function buildLedger(observations = [], snapshot = null, limit = 100) {
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
    const state = sell ? 'CLOSE_OBSERVED' : openMatches ? 'OPEN_OBSERVED' : 'OUTCOME_UNKNOWN';
    const grossUnrealized = openMatches ? numberOrNull(open.profitUsdVirtual) : null;
    // PnL on an open position does not prove realized PnL. Disappearance and
    // account-wide cash movements do not isolate proceeds or transaction fees.
    const realizedGross = numberOrNull(sell?.confirmation?.realizedPnlUsdVirtual);
    const fees = numberOrNull(sell?.confirmation?.brokerFeesUsdVirtual);
    const aiCost = numberOrNull(buy?.decisionTrace?.aiCostUsd);
    const fxCost = numberOrNull(sell?.confirmation?.fxFeesUsdVirtual);
    const net = state === 'CLOSE_OBSERVED' && realizedGross !== null && fees !== null &&
      fxCost !== null && aiCost !== null ? money(realizedGross - fees - fxCost - aiCost) : null;
    return {
      positionId, asset: buy.asset, executionInstrumentId: buy.executionInstrumentId,
      decision: buy.decisionTrace || null,
      signalToOrder: { buyObservationId: buy.id, buyOrderId: buy.brokerResponse?.orderId || null,
        buyConfirmedAt: buy.confirmation.confirmedAt, sellObservationId: sell?.id || null,
        sellOrderId: sell?.brokerResponse?.orderId || null, sellConfirmedAt: sell?.confirmation?.confirmedAt || null },
      state, investedUsdVirtual: numberOrNull(buy.confirmation.virtualInvestedAmountUsd),
      unrealizedBrokerProfitUsdVirtual: grossUnrealized,
      realizedGrossUsdVirtual: realizedGross,
      observedBrokerFeesUsdVirtual: fees, observedFxFeesUsdVirtual: fxCost,
      attributedAiCostUsd: aiCost, realizedNetUsdVirtual: net,
      buySlippageBps: numberOrNull(buy.executionQuality?.slippageBps),
      sellSlippageBps: numberOrNull(sell?.executionQuality?.slippageBps),
      missingForNet: state === 'CLOSE_OBSERVED' ? [
        realizedGross === null && 'EXACT_REALIZED_PNL', fees === null && 'BROKER_FEES',
        fxCost === null && 'FX_FEES', aiCost === null && 'ATTRIBUTED_AI_COST'
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
    counts: { confirmedBuys: buys.length, pairedCloses: entries.filter((entry) => entry.state === 'CLOSE_OBSERVED').length,
      unpairedConfirmedSells: sells.filter((sell) => !linkedSellIds.has(sell.id)).length,
      completeNetOutcomes: ready.length, missingDecisionTrace: buys.filter((buy) => !buy.decisionTrace).length },
    realizedNetTotalUsdVirtual: ready.length && ready.length === entries.filter((entry) => entry.state === 'CLOSE_OBSERVED').length
      ? money(ready.reduce((total, entry) => total + entry.realizedNetUsdVirtual, 0)) : null,
    entries: entries.slice(-safeLimit),
    caveat: 'Broker profit for open positions is unrealized. Cash changes and slippage are not realized PnL or additive fees. Missing historical trades, copier results and unobserved costs cannot be reconstructed.'
  };
}

module.exports = { buildLedger };
