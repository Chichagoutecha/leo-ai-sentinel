'use strict';

const symbolOf = row => String(row?.asset || row?.symbol || '').trim().toUpperCase();
const number = value => value === null || value === undefined || value === '' || typeof value === 'boolean' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const round = value => Math.round(value * 1e6) / 1e6;
const sorted = map => Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => [key, round(values.sort((a, b) => a - b).reduce((a, b) => a + b, 0))]));
const add = (map, key, value) => map.set(key, [...(map.get(key) || []), value]);

function analyzeExposure({ positions = [], compositions = [], now = Date.now(), maxAgeDays = 7, valuationCurrency = null, cash = null } = {}) {
  const issues = [];
  if (!valuationCurrency) issues.push({ portfolio: null, status: 'UNAVAILABLE', reason: 'VALUATION_CURRENCY_UNKNOWN' });
  const direct = new Map();
  const indirect = new Map();
  const combined = new Map();
  const rows = [];
  const groups = new Map();
  const ids = new Map();
  const dimensions = Object.fromEntries(['sector', 'issuer', 'geography', 'currency'].map(key => [key, { values: new Map(), unknown: [], status: 'UNAVAILABLE' }]));
  for (const row of Array.isArray(positions) ? positions : []) {
    const symbol = symbolOf(row);
    const key = symbol && symbol !== 'UNKNOWN' ? symbol : row?.instrumentId ? `INSTRUMENT:${row.instrumentId}` : null;
    const value = number(row?.estimatedValue ?? row?.value);
    const item = { symbol: key, positionId: row?.positionId ?? null, instrumentId: row?.instrumentId ?? null, category: row?.category || 'UNCLASSIFIED', estimatedValue: value, currency: valuationCurrency, metadata: row?.exposureMetadata || {} };
    if (!key || value === null || value < 0) { issues.push({ portfolio: key, status: 'UNAVAILABLE', reason: 'POSITION_IDENTITY_OR_VALUE_UNKNOWN' }); continue; }
    if (item.positionId !== null) {
      const id = String(item.positionId);
      if (!ids.has(id)) ids.set(id, []);
      ids.get(id).push(item);
    } else rows.push(item);
  }
  for (const [id, duplicates] of ids) {
    const signatures = new Set(duplicates.map(row => JSON.stringify(row)));
    if (signatures.size > 1) issues.push({ portfolio: null, positionId: id, status: 'INCOMPLETE', reason: 'CONFLICTING_POSITION_DUPLICATES' });
    else rows.push(duplicates[0]);
  }
  rows.sort((a, b) => a.symbol.localeCompare(b.symbol) || String(a.positionId).localeCompare(String(b.positionId)));
  for (const row of rows) add(direct, row.symbol, row.estimatedValue);
  const directValues = sorted(direct);
  for (const composition of Array.isArray(compositions) ? compositions : []) {
    const key = symbolOf(composition);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(composition);
  }
  const known = [];
  const baskets = { ETF: [], SMART_PORTFOLIO: [], UNCLASSIFIED: [] };
  const allocate = (key, value, metadata = {}) => {
    add(combined, key, value);
    for (const [dimension, output] of Object.entries(dimensions)) {
      const label = typeof metadata[dimension] === 'string' && metadata[dimension].trim() ? metadata[dimension].trim() : null;
      if (label) add(output.values, label, value);
      else output.unknown.push({ instrument: key, value });
    }
  };
  for (const key of Object.keys(directValues)) {
    const held = rows.filter(row => row.symbol === key);
    const category = held[0].category;
    const candidates = groups.get(key) || [];
    const basket = ['ETF', 'SMART_PORTFOLIO'].includes(category) || candidates.length > 0 || category === 'UNCLASSIFIED';
    if (!basket) { for (const row of held) allocate(key, row.estimatedValue, row.metadata); continue; }
    let status = 'UNAVAILABLE', reason = 'COMPOSITION_NOT_AVAILABLE', composition = candidates[0];
    if (candidates.length > 1) reason = 'DUPLICATE_OR_CONFLICTING_COMPOSITIONS';
    else if (composition) {
      const asOf = Date.parse(composition.asOf || '');
      const captured = Date.parse(composition.capturedAt || '');
      const holdings = Array.isArray(composition.holdings) ? composition.holdings : [];
      const weights = holdings.map(h => number(h.weightPct));
      const symbols = holdings.map(symbolOf);
      if (composition.sourceType !== 'OFFICIAL_ETORO_API' || !composition.sourceUrl || !composition.documentationUrl) reason = 'OFFICIAL_SOURCE_PROVENANCE_UNAVAILABLE';
      else if (!Number.isFinite(asOf) || !Number.isFinite(captured) || !Number.isFinite(now) || asOf > now || captured > now || asOf > captured || !Number.isFinite(maxAgeDays) || maxAgeDays < 0) reason = 'INVALID_COMPOSITION_DATES';
      else if (now - asOf > maxAgeDays * 86400000 || now - captured > maxAgeDays * 86400000) { status = 'STALE'; reason = 'COMPOSITION_STALE'; }
      else if (!valuationCurrency || composition.valuationCurrency !== valuationCurrency) reason = 'VALUATION_CURRENCY_UNKNOWN_OR_MISMATCH';
      else if (symbols.includes(key)) { status = 'INCOMPLETE'; reason = 'NESTED_OR_SELF_COMPOSITION_UNSUPPORTED'; }
      else if (composition.complete !== true || !holdings.length || symbols.some(s => !s) || new Set(symbols).size !== symbols.length || weights.some(w => w === null || w < 0 || w > 100) || Math.abs(weights.reduce((a, b) => a + b, 0) - 100) > 0.01) { status = 'INCOMPLETE'; reason = 'PARTIAL_INVALID_OR_DUPLICATE_HOLDINGS'; }
      else if (holdings.some(h => ['ETF', 'SMART_PORTFOLIO'].includes(h.category))) { status = 'INCOMPLETE'; reason = 'NESTED_COMPOSITION_UNSUPPORTED'; }
      else { status = 'COMPLETE'; reason = null; }
    }
    const entry = { symbol: key, status, reason, asOf: composition?.asOf || null, sourceUrl: composition?.sourceUrl || null, holdings: status === 'COMPLETE' ? [...composition.holdings].sort((a, b) => symbolOf(a).localeCompare(symbolOf(b))) : null, reportedHoldings: Array.isArray(composition?.holdings) ? composition.holdings.map(h => ({ symbol: symbolOf(h) || null, weightPct: number(h.weightPct) })).sort((a, b) => String(a.symbol).localeCompare(String(b.symbol))) : null };
    baskets[baskets[category] ? category : 'UNCLASSIFIED'].push(entry);
    if (status !== 'COMPLETE') { issues.push({ portfolio: key, status, reason }); continue; }
    known.push(key);
    for (const holding of [...composition.holdings].sort((a, b) => symbolOf(a).localeCompare(symbolOf(b)))) {
      const value = directValues[key] * Number(holding.weightPct) / 100;
      add(indirect, symbolOf(holding), value);
      allocate(symbolOf(holding), value, holding.exposureMetadata);
    }
  }
  if (!rows.length) issues.push({ portfolio: null, status: 'UNAVAILABLE', reason: 'NO_VALUED_POSITIONS' });
  for (const output of Object.values(dimensions)) {
    output.knownValues = sorted(output.values);
    delete output.values;
    output.status = !Object.keys(output.knownValues).length ? 'UNAVAILABLE' : output.unknown.length || issues.length ? 'INCOMPLETE' : 'COMPLETE';
  }
  const coverage = issues.length ? 'INCOMPLETE' : 'COMPLETE';
  return {
    readOnly: true, executionAttempted: false, valuationCurrency,
    valuationBasis: 'ESTIMATED_ACCOUNT_VALUE_NOT_GROSS_OR_NET_LEVERAGED_RISK',
    directPositions: rows, direct: directValues, baskets,
    indirect: known.length ? sorted(indirect) : null,
    combined: coverage === 'COMPLETE' ? sorted(combined) : null,
    knownCombinedSubtotal: sorted(combined), dimensions,
    overlaps: Object.keys(sorted(indirect)).filter(key => directValues[key] !== undefined).map(instrument => ({ instrument, directValue: directValues[instrument], indirectValue: sorted(indirect)[instrument] })),
    cash: { value: number(cash), currency: valuationCurrency, status: number(cash) === null ? 'UNAVAILABLE' : 'AVAILABLE' },
    knownOfficialCompositions: known.sort(), unavailable: issues, coverage,
    caveat: 'Unknown baskets and metadata remain unknown. No FX conversion, nested decomposition, CFD leverage reconstruction, or diversification inference.'
  };
}
module.exports = { analyzeExposure };
