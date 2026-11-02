'use strict';
// Shared deterministic virtual fill accounting. No broker or network capability.
const finite = v => typeof v === 'number' && Number.isFinite(v);
function virtualFill(paper, decision, quote, { now, orderId, feePct, slippageBps, tradable = false, allowReinforcement = false } = {}) {
  const skip = reason => ({ paper, result: { ok: false, skipped: true, simulated: true, executionAttempted: false, reason } });
  if (!paper || !finite(now) || !finite(feePct) || feePct < 0 || !finite(slippageBps) || slippageBps < 0 || slippageBps >= 10000) return skip('INVALID_SIMULATION_CONFIGURATION');
  if (!tradable) return skip('QUOTE_NOT_TRADABLE');
  const side = decision?.side, asset = decision?.asset;
  if (!['BUY', 'SELL'].includes(side) || typeof asset !== 'string' || !/^[A-Z0-9.:-]{1,32}$/.test(asset)) return skip('INVALID_VIRTUAL_DECISION');
  const reference = side === 'BUY' ? quote?.ask ?? quote?.mid : quote?.bid ?? quote?.mid;
  if (!finite(reference) || reference <= 0) return skip('MISSING_SIMULATION_PRICE');
  const price = reference * (1 + (side === 'BUY' ? 1 : -1) * slippageBps / 10000);
  const next = structuredClone(paper), position = next.positions?.[asset];
  if (!finite(next.cash) || next.cash < 0 || position && (!finite(position.units) || position.units <= 0 || !finite(position.costBasis) || position.costBasis < 0)) return skip('INVALID_VIRTUAL_LEDGER_VALUES');
  next.positions ||= {}; next.orders ||= []; next.closedTrades ||= [];
  const time = new Date(now).toISOString();
  let order;
  if (side === 'BUY') {
    if (position && !allowReinforcement) return skip('VIRTUAL_POSITION_ALREADY_OPEN');
    const amount = decision.amount;
    if (!finite(amount) || amount <= 0) return skip('INVALID_VIRTUAL_AMOUNT');
    const fee = amount * feePct / 100, totalCost = amount + fee, units = amount / price;
    if (!finite(next.cash) || next.cash < totalCost) return skip('INSUFFICIENT_VIRTUAL_CASH');
    const oldUnits = position?.units || 0, oldCost = position?.costBasis || 0;
    next.cash -= totalCost; next.feesPaid = (next.feesPaid || 0) + fee;
    const slippageCost = Math.max(0, (price - reference) * units);
    next.slippageCost = (next.slippageCost || 0) + slippageCost;
    const averageEntryPrice = oldUnits === 0 ? price : finite(position.averageEntryPrice) ? (oldUnits * position.averageEntryPrice + units * price) / (oldUnits + units) : null;
    next.positions[asset] = { asset, units: oldUnits + units, averageEntryPrice, costBasis: oldCost + totalCost,
      grossNotional: !position ? amount : finite(position.grossNotional) ? position.grossNotional + amount : null, currentPrice: price, currentValue: (oldUnits + units) * price,
      unrealizedPnl: (oldUnits + units) * price - oldCost - totalCost, peakPrice: Math.max(position?.peakPrice || 0, price), origin: 'paper-order', openedAt: position?.openedAt || time };
    order = { id: orderId, time, type: side, asset, amount, expectedPrice: reference, price, units, fee, slippageBps, slippageCost };
  } else {
    if (!position || !finite(position.units) || position.units <= 0) return skip('NO_VIRTUAL_POSITION');
    const units = decision.units ?? position.units;
    if (!finite(units) || units <= 0 || units > position.units) return skip('INVALID_REDUCTION_UNITS');
    const fraction = units / position.units, basis = position.costBasis * fraction;
    const gross = units * price, fee = gross * feePct / 100, proceeds = gross - fee, pnl = proceeds - basis;
    const slippageCost = Math.max(0, (reference - price) * units);
    next.cash += proceeds; next.realizedPnl = (next.realizedPnl || 0) + pnl;
    next.feesPaid = (next.feesPaid || 0) + fee; next.slippageCost = (next.slippageCost || 0) + slippageCost;
    const fullyClosed = units === position.units;
    if (fullyClosed) delete next.positions[asset];
    else Object.assign(next.positions[asset], { units: position.units - units, costBasis: position.costBasis - basis,
      grossNotional: finite(position.grossNotional) ? position.grossNotional * (1 - fraction) : null, currentPrice: price,
      currentValue: (position.units - units) * price, unrealizedPnl: (position.units - units) * price - position.costBasis + basis });
    order = { id: orderId, time, type: side, asset, amount: gross, proceeds, expectedPrice: reference, price, units, fee, pnl, slippageBps, slippageCost, fullyClosed };
    next.closedTrades.unshift({ id: orderId, asset, openedAt: position.openedAt, closedAt: time, entryPrice: position.averageEntryPrice,
      exitPrice: price, costBasis: basis, proceeds, pnl, returnPct: basis > 0 ? pnl / basis * 100 : null, totalFees: fee, feeCoverage: 'EXIT_FEE_ONLY_ENTRY_FEE_IN_COST_BASIS', slippageCost,
      fullyClosed, scope: fullyClosed ? 'VIRTUAL_POSITION_CLOSED' : 'VIRTUAL_POSITION_REDUCTION_NOT_INDEPENDENT_BROKER_LOT' });
  }
  next.orders.unshift(order);
  return { paper: next, result: { ok: true, status: 200, simulated: true, executionAttempted: false, mode: 'PAPER', ...order } };
}
module.exports = { virtualFill };
