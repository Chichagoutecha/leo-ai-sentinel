'use strict';
// Pure analysis. No network, broker client, mutation of policy, or synthetic lots.
const { randomUUID } = require('node:crypto');
const numeric = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
const identifier = v => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? String(v) : typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v) ? v : null;
const instrument = v => Number.isSafeInteger(v) && v > 0 ? v : null;
const symbol = v => typeof v === 'string' && /^[A-Z0-9][A-Z0-9.:-]{0,31}$/.test(v) ? v : null;
const time = v => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
const round = v => Math.round(v * 1e6) / 1e6;
const total = values => round([...values].sort((a, b) => a - b).reduce((a, b) => a + b, 0));
const ordered = map => Object.fromEntries([...map].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([key, values]) => [key, total(values)]));
const add = (map, key, value) => map.set(String(key), [...(map.get(String(key)) || []), value]);
function alias(row, names, parse) {
  const values = names.filter(k => row?.[k] !== undefined && row[k] !== null).map(k => parse(row[k]));
  return !values.length || values.some(v => v === null) || values.some(v => v !== values[0]) ? null : values[0];
}
const positionId = p => alias(p, ['positionId', 'positionID', 'PositionId', 'PositionID'], identifier);
const instrumentId = p => alias(p, ['instrumentId', 'instrumentID', 'InstrumentId', 'InstrumentID'], v => instrument(typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v));
const orderId = p => alias(p, ['orderId', 'orderID', 'OrderId', 'OrderID'], identifier);
function registryLabel(id, universe = []) {
  const rows = universe.filter(r => r.instrumentId === id);
  const symbols = [...new Set(rows.map(r => symbol(r.symbol)).filter(Boolean))];
  return { asset: symbols.length === 1 ? symbols[0] : `INSTRUMENT:${id}`, category: rows.length === 1 ? rows[0].category : 'UNCLASSIFIED', registryStatus: symbols.length === 1 ? 'MATCH' : symbols.length > 1 ? 'CONTRADICTORY' : 'UNKNOWN' };
}
function groupAssetValues(rows) { const values = new Map(); for (const row of rows) if (row.estimatedValueUsd !== null) add(values, row.asset, row.estimatedValueUsd); return ordered(values); }
function groupValues(rows) {
  const map = new Map();
  for (const row of rows) if (row.instrumentId !== null && row.estimatedValueUsd !== null) add(map, row.instrumentId, row.estimatedValueUsd);
  return ordered(map);
}
function normalizeOwnedPortfolio(response, { universe = [], now = Date.now(), maxAgeMs = 300000 } = {}) {
  const raw = response?.data?.clientPortfolio;
  const problems = [], candidates = [], mirrors = [];
  const fetched = time(response?.fetchedAt);
  const fresh = fetched !== null && now >= fetched && now - fetched <= maxAgeMs;
  if (!response?.ok || response.accountEnvironment !== 'REAL' || !raw || typeof raw !== 'object') problems.push('REAL_PORTFOLIO_NOT_VERIFIED');
  if (!fresh) problems.push('PORTFOLIO_STALE_OR_UNDATED');
  const client = raw || {};
  if (client.paperMode === true) problems.push('PAPER_PORTFOLIO_NOT_REAL_EVIDENCE');
  if (!Array.isArray(client.positions)) problems.push('DIRECT_POSITIONS_UNAVAILABLE');
  if (!Array.isArray(client.mirrors)) problems.push('NATIVE_COPY_STRUCTURE_UNAVAILABLE');
  if (client.subPortfolios !== undefined && (!Array.isArray(client.subPortfolios) || client.subPortfolios.length) || client.socialTrades !== undefined && (!Array.isArray(client.socialTrades) || client.socialTrades.length)) problems.push('UNSUPPORTED_ACCOUNT_CONTAINER_PRESENT');
  function collect(p, nestedMirror = null) {
    const id = positionId(p), inst = instrumentId(p);
    const amount = alias(p, ['amount', 'Amount', 'invested', 'Invested'], numeric);
    const pnlCandidates = [numeric(p?.unrealizedPnL?.pnL), ...['profit', 'Profit', 'netProfit', 'NetProfit'].filter(k => p?.[k] !== undefined).map(k => numeric(p[k]))].filter(v => v !== null);
    const pnl = pnlCandidates.length && pnlCandidates.every(v => v === pnlCandidates[0]) ? pnlCandidates[0] : null;
    const mirrorFields = ['mirrorId', 'mirrorID'].filter(k => p?.[k] !== undefined && p[k] !== null);
    const mirrorValue = mirrorFields.length ? alias(p, mirrorFields, v => v === 0 || v === '0' ? '0' : identifier(v)) : null;
    const declaredDirect = mirrorFields.length > 0 && mirrorValue === '0';
    const declaredCopy = mirrorValue && mirrorValue !== '0' ? mirrorValue : null;
    let mirror = nestedMirror || declaredCopy;
    const identityConflict = mirrorFields.length > 0 && mirrorValue === null || nestedMirror && (declaredDirect || declaredCopy && declaredCopy !== nestedMirror);
    let value = amount !== null && amount >= 0 && pnl !== null ? amount + pnl : null;
    const reasons = [];
    if (!id) reasons.push('POSITION_ID_UNKNOWN_OR_CONFLICTING');
    if (!inst) reasons.push('INSTRUMENT_ID_UNKNOWN_OR_CONFLICTING');
    if (identityConflict) reasons.push('MIRROR_IDENTITY_CONFLICT');
    if (p?.currency !== undefined && p.currency !== 'USD' || p?.valuationCurrency !== undefined && p.valuationCurrency !== 'USD') { value = null; reasons.push('VALUATION_CURRENCY_UNSUPPORTED_OR_UNVERIFIED'); }
    if (value === null || value < 0) { value = null; reasons.push('ACCOUNT_VALUE_UNKNOWN_OR_CONFLICTING'); }
    const leverage = numeric(p?.leverage), isBuy = typeof p?.isBuy === 'boolean' ? p.isBuy : null;
    const settlementType = ['CFD', 'Underlying'].includes(p?.settlementType) ? p.settlementType : null;
    const label = registryLabel(inst, universe);
    const row = { positionId: id, instrumentId: inst, ...label, ownership: mirror ? 'NATIVE_COPY' : 'DIRECT', mirrorId: mirror,
      investedAmountUsd: amount, pnlUsd: pnl, pnlBasis: numeric(p?.unrealizedPnL?.pnL) !== null ? 'DOCUMENTED_UNREALIZED_PNL' : 'LEGACY_PROFIT_ESTIMATE',
      estimatedValueUsd: value, units: alias(p, ['units', 'Units', 'amountInUnits', 'AmountInUnits'], numeric),
      leverage, isBuy, settlementType, currency: 'USD', ownershipBasis: nestedMirror ? 'MIRROR_CHILD_CONTAINER' : declaredCopy ? 'MIRROR_ID_REFERENCE' : 'ROOT_POSITION_CONTAINER', reasons, explicitDirect: declaredDirect,
      riskReconstructed: leverage === 1 && isBuy === true && settlementType === 'Underlying', source: nestedMirror ? 'mirrors.positions' : 'positions' };
    candidates.push(row);
  }
  for (const p of (Array.isArray(client.positions) ? client.positions : []).slice(0, 1000)) collect(p);
  if (client.positions?.length > 1000) problems.push('POSITION_LIMIT_REACHED');
  for (const wrapper of (Array.isArray(client.mirrors) ? client.mirrors : []).slice(0, 100)) {
    const id = alias(wrapper, ['mirrorId', 'mirrorID'], identifier);
    if (!id) problems.push('MIRROR_ID_UNKNOWN_OR_CONFLICTING');
    if (!Array.isArray(wrapper?.positions)) problems.push('MIRROR_POSITIONS_UNAVAILABLE');
    const available = numeric(wrapper?.availableAmount), closed = numeric(wrapper?.closedPositionsNetProfit);
    mirrors.push({ mirrorId: id, parentTraderId: null, parentIdentityStatus: 'UNVERIFIED', positionsAvailable: Array.isArray(wrapper?.positions), positionIds: Array.isArray(wrapper?.positions) ? wrapper.positions.map(positionId).sort() : null, idleAllocationUsd: available !== null && closed !== null ? round(available - closed) : null });
    for (const p of (Array.isArray(wrapper?.positions) ? wrapper.positions : []).slice(0, 1000)) collect(p, id || 'UNKNOWN_MIRROR');
    if (wrapper?.positions?.length > 1000) problems.push('MIRROR_POSITION_LIMIT_REACHED');
  }
  if (client.mirrors?.length > 100) problems.push('MIRROR_LIMIT_REACHED');
  const groups = new Map(), invalid = [];
  for (const row of candidates) {
    if (!row.positionId || !row.instrumentId || row.reasons.includes('MIRROR_IDENTITY_CONFLICT')) { invalid.push({ positionId: row.positionId, instrumentId: row.instrumentId, estimatedValueUsd: row.estimatedValueUsd, reasons: row.reasons }); continue; }
    if (!groups.has(row.positionId)) groups.set(row.positionId, []);
    groups.get(row.positionId).push(row);
  }
  const rows = [];
  for (const [id, versions] of groups) {
    const compare = r => JSON.stringify([r.instrumentId, r.investedAmountUsd, r.pnlUsd, r.estimatedValueUsd, r.units, r.isBuy, r.leverage, r.settlementType]);
    const copies = [...new Set(versions.map(r => r.mirrorId).filter(Boolean))];
    if (new Set(versions.map(compare)).size !== 1 || copies.length > 1 || copies.length && versions.some(r => r.explicitDirect)) {
      invalid.push({ positionId: id, instrumentIds: [...new Set(versions.map(r => r.instrumentId))].sort((a, b) => a - b), reasons: ['CONFLICTING_POSITION_REPRESENTATIONS'] }); continue;
    }
    const row = versions.find(r => r.mirrorId) || versions[0];
    rows.push({ ...row, representationsDeduplicated: versions.length, sourcePaths: [...new Set(versions.map(r => r.source))].sort() });
  }
  rows.sort((a, b) => a.positionId.localeCompare(b.positionId));
  const copyGroups = new Map();
  for (const mirror of mirrors) {
    if (!mirror.mirrorId) continue;
    if (!copyGroups.has(mirror.mirrorId)) copyGroups.set(mirror.mirrorId, []);
    copyGroups.get(mirror.mirrorId).push(mirror);
  }
  const copyContainers = [];
  for (const [id, versions] of copyGroups) {
    if (new Set(versions.map(r => JSON.stringify(r))).size > 1) problems.push('CONFLICTING_MIRROR_WRAPPERS');
    copyContainers.push({ ...versions[0], representationsDeduplicated: versions.length });
  }
  if (rows.some(r => r.mirrorId && !copyGroups.has(r.mirrorId))) problems.push('NATIVE_COPY_CONTAINER_NOT_PRESENT');
  if (rows.some(r => r.pnlBasis !== 'DOCUMENTED_UNREALIZED_PNL')) problems.push('LEGACY_VALUATION_ESTIMATE_UNVERIFIED');
  if (invalid.length || rows.some(r => r.reasons.length)) problems.push('UNKNOWN_OR_CONFLICTING_POSITIONS');
  const direct = rows.filter(r => r.ownership === 'DIRECT'), copied = rows.filter(r => r.ownership === 'NATIVE_COPY');
  const coverage = !problems.length && rows.every(r => r.estimatedValueUsd !== null) ? 'COMPLETE' : fresh ? 'INCOMPLETE' : 'STALE';
  const values = groupValues(rows);
  return { source: 'https://public-api.etoro.com/api/v1/trading/info/real/pnl', fetchedAt: response?.fetchedAt || null, environment: response?.accountEnvironment === 'REAL' ? 'REAL' : 'UNKNOWN',
    sourceEffectiveAt: null, collectionFreshness: fresh ? 'FRESH_READ_SOURCE_ASOF_UNVERIFIED' : 'STALE_OR_UNDATED', valuationBasis: 'ESTIMATED_ACCOUNT_CAPITAL_VALUE_USD_NOT_GROSS_NET_OR_FX_EXPOSURE', valuationScope: 'DOCUMENTED_USD_PORTION_ONLY', accountScope: 'CURRENT_API_TOKEN_PRINCIPAL_NOT_OWNER_ACCOUNT_PROOF', copierReplication: { status: 'UNAVAILABLE', reason: 'NO_SEPARATE_COPIER_ACCOUNT_EVIDENCE' }, currency: 'USD', fresh, coverage,
    rows, direct: { positions: direct, knownValuesByInstrument: groupValues(direct), knownValuesByAsset: groupAssetValues(direct) }, nativeCopies: { positions: copied, containers: copyContainers, knownValuesByInstrument: groupValues(copied), knownValuesByAsset: groupAssetValues(copied), absent: !Array.isArray(client.mirrors) ? null : client.mirrors.length === 0 && copied.length === 0 },
    knownValuesByInstrument: values, combinedValuesByInstrument: coverage === 'COMPLETE' ? values : null,
    unknownPositions: invalid, problems: [...new Set(problems)].sort(),
    unreconstructedRisk: rows.filter(r => !r.riskReconstructed).map(r => ({ positionId: r.positionId, instrumentId: r.instrumentId, leverage: r.leverage, isBuy: r.isBuy, settlementType: r.settlementType, reason: 'DERIVATIVE_SHORT_LEVERAGE_OR_PRODUCT_METADATA_UNRECONSTRUCTED' })),
    creditUsd: numeric(client.credit), ordersForCloseIgnored: Array.isArray(client.ordersForClose) ? client.ordersForClose.length : null };
}
const TERMINAL = new Set(['POSITION_CONFIRMED', 'ORDER_REJECTED', 'ORDER_NO_EFFECT', 'CONFIRMED', 'REJECTED', 'ORDER_PARTIALLY_FILLED_TERMINAL', 'ORDER_CANCELED', 'ORDER_EXPIRED']);
function pendingExposure(client = {}, intents = [], now = Date.now(), account = {}) {
  client = client && typeof client === 'object' ? client : {};
  const candidates = [], issues = [];
  for (const name of ['ordersForOpen', 'orders']) {
    if (!Array.isArray(client[name])) { issues.push(name + '_UNAVAILABLE'); continue; }
    for (const raw of client[name].slice(0, 1000)) candidates.push({ key: orderId(raw), instrumentId: instrumentId(raw), amountUsd: numeric(raw.amount), isBuy: typeof raw.isBuy === 'boolean' ? raw.isBuy : null,
      leverage: numeric(raw.leverage), currency: raw.currency ?? 'USD', source: name, intentIds: [] });
    if (client[name].length > 1000) issues.push('ORDER_LIMIT_REACHED');
  }
  const groups = new Map(), orders = [];
  for (const row of candidates) { if (!row.key) { issues.push('ORDER_ID_UNKNOWN'); orders.push({ ...row, impactKnown: false }); continue; } if (!groups.has(row.key)) groups.set(row.key, []); groups.get(row.key).push(row); }
  for (const [key, rows] of groups) {
    const compare = r => JSON.stringify([r.instrumentId, r.amountUsd, r.isBuy, r.leverage, r.currency]);
    const conflicting = new Set(rows.map(compare)).size !== 1;
    if (conflicting) issues.push('CONFLICTING_ORDER_REPRESENTATIONS');
    orders.push({ ...rows[0], key, sourcePaths: [...new Set(rows.map(r => r.source))].sort(), impactKnown: !conflicting && rows[0].instrumentId !== null && rows[0].amountUsd !== null && rows[0].amountUsd > 0 && rows[0].isBuy === true && rows[0].leverage === 1 && rows[0].currency === 'USD' });
  }
  const intentGroups = new Map();
  for (const raw of intents.slice(0, 1000)) {
    const key = identifier(raw?.id);
    if (key && intentGroups.has(key)) {
      const prior = intentGroups.get(key);
      if (JSON.stringify([prior.type, prior.status, prior.amount, prior.brokerResponse?.orderId, prior.orderId]) !== JSON.stringify([raw.type, raw.status, raw.amount, raw.brokerResponse?.orderId, raw.orderId])) issues.push('CONFLICTING_INTENT_ID');
      continue;
    }
    if (key) intentGroups.set(key, raw);
    if (!raw || typeof raw !== 'object') { issues.push('INVALID_INTENT'); continue; }
    const id = identifier(raw.id), broker = identifier(raw.response?.orderId ?? raw.brokerResponse?.orderId ?? raw.orderId);
    if (TERMINAL.has(raw.status)) {
      const residual = broker ? orders.find(o => o.key === broker) : null;
      if (residual) { residual.impactKnown = false; issues.push('TERMINAL_ORDER_STILL_REPORTED_PENDING'); }
      continue;
    }
    const found = broker ? orders.find(o => o.key === broker) : null;
    if (found) {
      found.intentIds.push(id);
      const p = raw.orderProgress, checked = time(p?.checkedAt);
      const accountMatch = p?.accountContext && Object.keys(p.accountContext).length > 0 && Object.entries(p.accountContext).every(([key, value]) => account[key] === value);
      const partialBound = p?.verifiedForIntent === true && p.orderId === broker && raw.positionProof?.matched === true && accountMatch && checked !== null && now >= checked && now - checked <= 300000 && numeric(p.remainingRequestedAmount) !== null;
      if (raw.type === 'BUY' && (p?.executedUnits > 0 || p?.lastVerified?.executedUnits > 0) && !partialBound) { found.impactKnown = false; issues.push('PARTIAL_FINALITY_UNVERIFIED'); }
      else if (raw.type === 'BUY' && partialBound) {
        if (found.instrumentId !== p.instrumentId || ![raw.amount, p.remainingRequestedAmount].some(v => Math.abs(v - found.amountUsd) < 0.000001)) {
          found.impactKnown = false; issues.push('PARTIAL_ORDER_AMOUNT_CONTRADICTION');
        } else { found.amountUsd = p.remainingRequestedAmount; found.quantityBasis = 'UNEXECUTED_PRINCIPAL_ONLY'; found.additionalCashDeductionUsd = 0; }
      } else if (numeric(raw.amount) !== null && raw.type === 'BUY' && raw.amount !== found.amountUsd || raw.type === 'SELL' && found.isBuy === true) { found.impactKnown = false; issues.push('INTENT_BROKER_ORDER_CONFLICT'); }
    } else orders.push({ key: null, intentIds: id ? [id] : [], source: 'LOCAL_INTENT', status: typeof raw.status === 'string' && /^[A-Z_]{1,60}$/.test(raw.status) ? raw.status : 'UNKNOWN', instrumentId: null,
      analysisAsset: symbol(raw.asset), amountUsd: numeric(raw.amount), impactKnown: false, reason: 'EXECUTION_INSTRUMENT_OR_ORDER_CORRELATION_UNVERIFIED' });
  }
  if (intents.length > 1000) issues.push('INTENT_LIMIT_REACHED');
  orders.sort((a, b) => String(a.key || a.intentIds[0] || '').localeCompare(String(b.key || b.intentIds[0] || '')));
  const map = new Map(); for (const order of orders) if (order.impactKnown) add(map, order.instrumentId, order.amountUsd);
  const complete = !issues.length && orders.every(r => r.impactKnown);
  return { status: complete ? 'COMPLETE_KNOWN_BUY_UPPER_BOUND' : 'INCOMPLETE', quantityBasis: 'PER_ORDER_REPORTED_UPPER_BOUND_OR_VERIFIED_UNEXECUTED_PRINCIPAL', knownBuyUpperBoundByInstrument: ordered(map), allBuyUpperBoundByInstrument: complete ? ordered(map) : null,
    orders, issues: [...new Set(issues)].sort(), caveat: 'PENDING_IS_NOT_HELD; uncertain fills/SELLs never reduce held exposure; no assumption that every pending order fills.' };
}
function trustedTaxonomy(records, id, now) {
  const rows = records.filter(r => r.instrumentId === id);
  if (rows.length !== 1) return null;
  const r = rows[0], asOf = time(r.asOf);
  if (r.sourceVerified !== true || r.complete !== true || !['OFFICIAL_ETORO_API', 'OFFICIAL_ISSUER'].includes(r.sourceType) || typeof r.sourceUrl !== 'string' || !r.sourceUrl.startsWith('https://') || asOf === null || now < asOf || now - asOf > 7 * 86400000) return null;
  return r;
}
function dimensionExposure(owned, taxonomy, now) {
  return Object.fromEntries(['sector', 'issuer', 'geography', 'currency'].map(d => {
    const values = new Map(), unknown = [], sources = [];
    for (const row of owned.rows) {
      const meta = trustedTaxonomy(taxonomy, row.instrumentId, now), label = meta?.[d];
      if (['ETF', 'SMART_PORTFOLIO', 'UNCLASSIFIED'].includes(row.category) || typeof label !== 'string' || !label.trim() || label.length > 100 || row.estimatedValueUsd === null) unknown.push({ positionId: row.positionId, instrumentId: row.instrumentId, valueUsd: row.estimatedValueUsd, reason: row.estimatedValueUsd === null ? 'POSITION_VALUE_UNAVAILABLE' : 'BASKET_OR_VERIFIED_CLASSIFICATION_UNAVAILABLE' });
      else { add(values, label, row.estimatedValueUsd); sources.push({ instrumentId: row.instrumentId, asOf: meta.asOf, sourceUrl: meta.sourceUrl }); }
    }
    const known = ordered(values), complete = unknown.length === 0 && owned.coverage === 'COMPLETE' && owned.unreconstructedRisk.length === 0;
    return [d, { status: !values.size ? 'UNAVAILABLE' : complete ? 'COMPLETE' : 'INCOMPLETE', knownValueSubtotalsUsd: known, combinedValuesUsd: complete ? known : null, unknown, sources, unreconstructedRisk: owned.unreconstructedRisk.length > 0,
      definition: d === 'currency' ? 'ECONOMIC_CURRENCY_FROM_VERIFIED_METADATA_NOT_USD_VALUATION_CURRENCY' : 'VERIFIED_CLASSIFICATION_ONLY' }];
  }));
}
function observedConcentrations(observerView = {}, owned, { now = Date.now(), maxAgeMs = 1800000 } = {}) {
  const map = new Map(), traders = [];
  const duplicateTraderIds = new Set((observerView.traders || []).filter((t, i, all) => all.findIndex(r => r.realCID === t.realCID) !== i).map(t => t.realCID));
  for (const trader of observerView.traders || []) {
    const snapshot = trader.snapshot, timestamp = time(snapshot?.collectedAt);
    const fresh = instrument(trader.realCID) !== null && !duplicateTraderIds.has(trader.realCID) && snapshot?.identity?.realCID === trader.realCID && instrument(snapshot?.identity?.gcid) !== null && ['AVAILABLE', 'PARTIAL'].includes(snapshot?.portfolio?.status) && timestamp !== null && now >= timestamp && now - timestamp <= maxAgeMs && !['STALE', 'PRIVATE', 'UNAVAILABLE'].includes(trader.status) && !trader.historicalSnapshot;
    const positions = fresh && Array.isArray(snapshot?.portfolio?.positions) ? snapshot.portfolio.positions : [];
    traders.push({ traderId: trader.realCID, status: fresh ? 'PARTIAL_KNOWN_PRESENCE_ONLY' : 'UNAVAILABLE_OR_STALE', collectedAt: snapshot?.collectedAt || null, portfolioUsedAsOwnedExposure: false, nativeCopyRelationship: 'UNVERIFIED' });
    const seen = new Set();
    for (const row of positions) {
      const id = instrument(row.instrumentId); if (!id || seen.has(id)) continue; seen.add(id);
      if (!map.has(id)) map.set(id, []);
      map.get(id).push({ traderId: trader.realCID, collectedAt: snapshot.collectedAt, observationId: trader.observationId || null, source: snapshot.sources?.portfolio || null, scope: 'OBSERVED_ONLY_NOT_OWNED', weightAggregation: 'NOT_COMPARABLE_OR_SUMMED' });
    }
  }
  return { traders, instruments: [...map].sort(([a], [b]) => a - b).map(([id, refs]) => ({ instrumentId: id, observedTraderIds: refs.map(r => r.traderId).sort((a, b) => a - b), observedTraderCount: refs.length,
    sourceRefs: refs, knownOwnedValueUsd: owned.knownValuesByInstrument[id] ?? null,
    independence: 'NOT_ESTABLISHED; SHARED_HOLDINGS_ARE_NOT_INDEPENDENT_SIGNALS' })),
    valueAddedToOurPortfolioUsd: null, caveat: 'No observed portfolio value or weight is added to owned exposures; absent holdings do not establish diversification.' };
}
function buildTraderExposureView({ portfolioResponse, observerView, intents = [], proposals = [], universe = [], taxonomy = [], now = Date.now() } = {}) {
  const owned = normalizeOwnedPortfolio(portfolioResponse, { universe, now });
  return { readOnly: true, executionAttempted: false, generatedAt: new Date(now).toISOString(), owned,
    pending: pendingExposure(portfolioResponse?.data?.clientPortfolio, intents, now, require('./etoro-order-finality').contextFromPortfolio(portfolioResponse)),
    observedOnly: observedConcentrations(observerView, owned, { now }), dimensions: dimensionExposure(owned, taxonomy, now),
    proposalsNotExecuted: proposals.slice(-50).map(r => traceView(r, intents)),
    lotModel: 'EXACT_BROKER_POSITION_IDS_ONLY_NO_SYNTHETIC_INDEPENDENT_LOTS' };
}

function traceView(trace, intents = []) {
  const links = intents.filter(i => i?.proposalId === trace.proposalId && identifier(i.id)).map(i => ({ intentId: String(i.id), brokerOrderId: identifier(i.brokerResponse?.orderId ?? i.orderId), associationBasis: 'EXPLICIT_PROPOSAL_ID_REFERENCE_NOT_FILL_PROOF' }));
  return { proposalId: trace.proposalId, createdAt: trace.createdAt, instrumentId: trace.instrumentId, side: trace.side,
    status: 'PROPOSED_NOT_HELD', traderSources: trace.traderSources, brokerOrderLinks: links, positionLinks: [],
    linkingStatus: links.length ? 'EXPLICIT_INTENT_REFERENCES_ONLY' : 'UNLINKED_NO_EXPLICIT_PROPOSAL_REFERENCE' };
}

function validateProposal(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['instrumentId', 'side', 'currency', 'amount', 'positionId', 'units', 'quantityMode', 'traderSources'].includes(k)) || !instrument(body.instrumentId) || !['BUY', 'SELL'].includes(body.side) || body.currency !== 'USD') throw Error('INVALID_EXPOSURE_PROPOSAL');
  if (body.side === 'BUY' && (numeric(body.amount) === null || body.amount <= 0 || body.positionId !== undefined || body.units !== undefined || body.quantityMode !== undefined)) throw Error('INVALID_BUY_PROPOSAL');
  if (body.side === 'SELL' && (!identifier(body.positionId) || !['FULL_POSITION', 'UNITS'].includes(body.quantityMode) || body.amount !== undefined || body.quantityMode === 'UNITS' && (numeric(body.units) === null || body.units <= 0) || body.quantityMode === 'FULL_POSITION' && body.units !== undefined)) throw Error('INVALID_SELL_PROPOSAL');
  if (!Array.isArray(body.traderSources) || body.traderSources.length > 5) throw Error('INVALID_TRADER_SOURCES');
  for (const r of body.traderSources) if (!r || Object.keys(r).some(k => !['traderId', 'observationId', 'eventId'].includes(k)) || !instrument(r.traderId) || !/^[a-f0-9]{64}$/.test(r.observationId) || r.eventId !== undefined && !/^[a-f0-9]{64}$/.test(r.eventId)) throw Error('INVALID_TRADER_SOURCE');
  return structuredClone(body);
}
function previewProposal(body, view, { observerState, observerView = {}, now = Date.now(), proposalId: makeId = randomUUID, eligibility = null, sizingEvidence = null, policy = {} } = {}) {
  const proposal = validateProposal(body), id = proposal.instrumentId, problems = [], owned = view.owned;
  const sourceRefs = proposal.traderSources.map(ref => {
    const trader = observerView.traders?.find(r => r.realCID === ref.traderId);
    const observation = observerState?.observations?.find(r => r.id === ref.observationId && r.realCID === ref.traderId);
    const event = ref.eventId ? observerState?.events?.find(r => r.id === ref.eventId && r.traderId === ref.traderId && r.observationId === ref.observationId) : null;
    const observationTime = time(observation?.collectedAt);
    const superseded = observerState?.observations?.some(r => r.corrects === ref.observationId);
    const stale = trader && (['STALE', 'UNAVAILABLE', 'PRIVATE'].includes(trader.status) || trader.historicalSnapshot) || observationTime === null || now < observationTime || now - observationTime > 1800000;
    const eventInstrument = typeof event?.next === 'object' && event.next ? event.next.instrumentId : typeof event?.previous === 'object' && event.previous ? event.previous.instrumentId : null;
    const currentSnapshotMatches = observerState?.traders?.[ref.traderId]?.observationId === ref.observationId;
    const relevant = eventInstrument === id || currentSnapshotMatches && trader?.snapshot?.portfolio?.positions?.some(p => p.instrumentId === id && (!event || p.key === event.key));
    const matches = Boolean(trader && observation && relevant && !superseded && !observation.late && (!ref.eventId || event));
    return { ...ref, status: !matches ? 'UNVERIFIED_OR_SUPERSEDED' : stale ? 'STALE' : 'REFERENCE_FOUND_NOT_TRANSACTION_PROOF',
      availableAt: observation?.collectedAt || null, source: event?.source || trader?.snapshot?.sources?.portfolio || null, transactionProven: false };
  });
  if (sourceRefs.some(r => ['UNVERIFIED_OR_SUPERSEDED', 'STALE'].includes(r.status))) problems.push('TRADER_SOURCE_UNVERIFIED_OR_STALE');
  let delta = proposal.side === 'BUY' ? proposal.amount : null;
  if (proposal.side === 'SELL') {
    const target = owned.rows.find(p => p.positionId === String(proposal.positionId));
    if (!target || target.instrumentId !== id || target.ownership !== 'DIRECT' || target.isBuy !== true || target.estimatedValueUsd === null) problems.push('SELL_TARGET_OWNERSHIP_IDENTITY_OR_VALUE_UNVERIFIED');
    else if (proposal.quantityMode === 'FULL_POSITION') delta = -target.estimatedValueUsd;
    else if (target.units === null || target.units <= 0 || proposal.units > target.units) problems.push('SELL_UNITS_UNKNOWN_OR_EXCESS');
    else delta = -target.estimatedValueUsd * proposal.units / target.units;
  }
  const held = owned.knownValuesByInstrument[id];
  const baseline = held !== undefined ? held : owned.coverage === 'COMPLETE' ? 0 : null;
  const pending = view.pending.knownBuyUpperBoundByInstrument[id] ?? (view.pending.status === 'COMPLETE_KNOWN_BUY_UPPER_BOUND' ? 0 : null);
  const reliable = owned.coverage === 'COMPLETE' && owned.fresh && view.pending.status === 'COMPLETE_KNOWN_BUY_UPPER_BOUND' && delta !== null && baseline !== null && !problems.length;
  if (!owned.fresh || owned.coverage !== 'COMPLETE') problems.push('OWNED_COVERAGE_INCOMPLETE_OR_STALE');
  if (view.pending.status !== 'COMPLETE_KNOWN_BUY_UPPER_BOUND') problems.push('PENDING_OR_UNCERTAIN_IMPACT_INCOMPLETE');
  const trace = { proposalId: makeId(), createdAt: new Date(now).toISOString(), instrumentId: id, side: proposal.side, currency: 'USD', quantityMode: proposal.quantityMode || 'AMOUNT', amount: proposal.amount ?? null,
    positionId: proposal.side === 'SELL' ? String(proposal.positionId) : null, units: proposal.units ?? null, traderSources: sourceRefs, status: 'PROPOSED_NOT_EXECUTED', brokerOrderLinks: [], positionLinks: [],
    lotModel: 'BROKER_POSITION_REFERENCE_NOT_AN_INDEPENDENT_SYNTHETIC_LOT' };
  return { trace, readOnly: true, executionAttempted: false, status: reliable ? 'AVAILABLE_ESTIMATED_ACCOUNT_VALUE_SCENARIO' : 'INCOMPLETE', problems: [...new Set(problems)].sort(),
    marginal: { basis: 'USD_ACCOUNT_VALUE_SCENARIO_NOT_GROSS_OR_NET_RISK', instrumentId: id, beforeKnownHeldValueUsd: baseline,
      knownPendingBuyUpperBoundUsd: pending, proposedDeltaUsd: delta === null ? null : round(delta),
      afterAssumingAllKnownPendingBuysFillUsd: reliable ? round(baseline + (pending || 0) + delta) : null },
    dimensions: { status: 'UNAVAILABLE_WITHOUT_COMPLETE_VERIFIED_LOOK_THROUGH_AND_TAXONOMY', before: view.dimensions },
    sizing: calculateSizingHeadroom(view, id, sizingEvidence, policy, now), eligibility,
    caveat: 'No positions or orders are changed. Pending fills are hypothetical. Eligibility does not grant LEO authorization.' };
}

function calculateSizingHeadroom(view, id, evidence, policy, now) {
  const unavailable = { status: 'UNAVAILABLE', headroomUsd: null, policyOrderCapUsd: numeric(policy.maxOrderUsd), reason: 'COMPLETE_EQUITY_CASH_LOOK_THROUGH_AND_GROSS_RISK_NOT_ESTABLISHED' };
  const asOf = time(evidence?.asOf);
  const virtualEvidence = view.owned.scope === 'VIRTUAL_EXPERIMENT_ONLY' && evidence?.virtualOnly === true && evidence?.sourceType === 'VIRTUAL_SHADOW_LEDGER' && evidence?.sourceUrl === 'local:shadow-ledger';
  const officialEvidence = evidence?.sourceType === 'OFFICIAL_ETORO_API' && typeof evidence?.sourceUrl === 'string' && evidence.sourceUrl.startsWith('https://');
  if (view.owned.coverage !== 'COMPLETE' || view.owned.unreconstructedRisk.length || view.pending.status !== 'COMPLETE_KNOWN_BUY_UPPER_BOUND' || evidence?.verified !== true || evidence?.currency !== 'USD' || evidence?.lookThroughCoverage !== 'COMPLETE' || !(virtualEvidence || officialEvidence) || asOf === null || now < asOf || now - asOf > 300000 || numeric(evidence?.equityUsd) === null || evidence.equityUsd <= 0 || numeric(evidence?.availableCashUsd) === null || evidence.availableCashUsd < 0 || numeric(policy.maxInstrumentWeightPct) === null || policy.maxInstrumentWeightPct <= 0 || policy.maxInstrumentWeightPct > 100 || numeric(policy.maxOrderUsd) === null || policy.maxOrderUsd <= 0 || numeric(policy.minimumCashReserveUsd) === null || policy.minimumCashReserveUsd < 0) return unavailable;
  const held = view.owned.knownValuesByInstrument[id] || 0;
  const reserved = view.pending.knownBuyUpperBoundByInstrument[id] || 0;
  return { status: 'AVAILABLE_CONCENTRATION_AND_CASH_UPPER_BOUND_ONLY',
    headroomUsd: round(Math.max(0, Math.min(policy.maxOrderUsd, evidence.equityUsd * policy.maxInstrumentWeightPct / 100 - held - reserved, evidence.availableCashUsd - policy.minimumCashReserveUsd))),
    reason: 'NOT_AN_ORDER_PERMISSION; COSTS_MINIMUMS_AND_FINAL_RISK_VETO_STILL_REQUIRED' };
}

module.exports = { normalizeOwnedPortfolio, pendingExposure, dimensionExposure, observedConcentrations, buildTraderExposureView, validateProposal, previewProposal, calculateSizingHeadroom };
