'use strict';
// Synthetic official-schema responses. This fixture never accesses credentials or network.
const { normalizeLookup } = require('./etoro-order-finality');
const TIME = '2026-11-02T12:00:00.000Z';
function progressFor(p, before, after, state = 'FILLED') {
  const buy = p.side === 'BUY', orderId = 123;
  const expected = { side: p.side, environment: 'REAL', orderId, instrumentId: p.instrumentId, requestedAmount: buy ? p.amountUsd : null,
    requestedUnits: buy ? null : p.units, positionId: p.positionId, account: buy ? { accountId: 7 } : { CID: 7 } };
  const changes = buy ? after.map(r => ({ ...r, delta: r.units - (before.find(b => String(b.positionId) === String(r.positionId))?.units || 0) })).filter(r => r.delta > 0)
    : before.filter(r => String(r.positionId) === String(p.positionId)).map(r => ({ ...r, delta: r.units - (after.find(a => String(a.positionId) === String(r.positionId))?.units || 0) })).filter(r => r.delta > 0);
  const data = buy ? { orderId, accountId: 7, action: 'open', transaction: 'buy', orderCurrency: 'usd',
    asset: { instrumentId: p.instrumentId, currency: 'USD', side: 'long', leverage: 1, settlementType: 'Underlying' },
    status: { id: state === 'FILLED' ? 3 : 2, name: state === 'FILLED' ? 'Filled' : 'Pending' }, requestedAmount: p.amountUsd, totalCosts: 0.1, frozenAmount: null,
    positionExecutions: changes.map(r => ({ positionId: Number(r.positionId), openingData: { orderId, units: r.delta, avgPrice: 10, executionTime: TIME, fees: 0.1 } })) }
    : { orderID: orderId, CID: 7, instrumentID: p.instrumentId, statusID: ({ FILLED: 3, PARTIAL: 5, REJECTED_REST: 10, REJECTED: 4 })[state],
      positions: changes.map(r => ({ positionID: Number(r.positionId), units: r.delta, rate: 10, occurred: TIME })) };
  return normalizeLookup(data, expected, Date.parse(TIME));
}
module.exports = { progressFor, TIME };
