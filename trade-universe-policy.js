'use strict';

const LIVE_BUY_CONFIRMATION = 'I_UNDERSTAND_LIVE_BUY_ORDERS';

function resolveTradingMode(env = {}) {
  const raw = String(env.TRADING_MODE || '').trim().toUpperCase();
  const aliases = { OBSERVE: 'OFF', PAPER: 'SHADOW' };
  const requested = raw ? (aliases[raw] || raw) : 'SHADOW';
  const valid = new Set(['OFF', 'SHADOW', 'DEMO', 'LIVE']);
  const mode = valid.has(requested) ? requested : 'OFF';
  return {
    mode,
    internalMode: ({ OFF: 'OBSERVE', SHADOW: 'PAPER', DEMO: 'DEMO', LIVE: 'LIVE' })[mode],
    explicit: Boolean(raw),
    invalid: Boolean(raw && !valid.has(requested)),
    legacyAutoTradeIgnored: env.AUTO_TRADE === 'true' && env.ALLOW_LEGACY_AUTO_TRADE === 'true' && !raw
  };
}

function liveBuyReady(env = {}) {
  return String(env.TRADING_MODE || '').trim().toUpperCase() === 'LIVE' &&
    env.LIVE_EXECUTION_ARMED === 'true' &&
    env.LIVE_BUY_CONFIRMATION === LIVE_BUY_CONFIRMATION;
}

function demoBuyReady(env = {}) {
  return String(env.TRADING_MODE || '').trim().toUpperCase() === 'DEMO' &&
    env.DEMO_EXECUTION_ARMED === 'true' &&
    String(env.ETORO_ACCOUNT_ENV || '').trim().toUpperCase() === 'DEMO';
}

function liveBuyMaxOrderUsd(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 10;
  return Math.min(10, Math.max(1, parsed));
}

function classifyAsset(asset, rule = {}) {
  const symbol = String(asset || '').trim().toUpperCase();
  const category = String(rule.category || '').trim().toUpperCase();
  if (category === 'SMART_PORTFOLIO' || category === 'SMART_PORTFOLIO_COMPONENT') return 'SMART_PORTFOLIO';
  if (category.startsWith('ETF_') || ['GOLD', 'BONDS_LONG', 'BONDS_SHORT', 'HEALTHCARE', 'DEFENSIVE_CONSUMER', 'ENERGY'].includes(category)) return 'ETF';
  if (category.includes('CRYPTO') || ['BTC', 'ETH', 'SOL'].includes(symbol)) return 'CRYPTO';
  return 'STOCK';
}

function buildUniverse(watchlist = {}, rules = {}, extraCandidates = []) {
  const rows = [];
  for (const [asset, instrumentId] of Object.entries(watchlist)) {
    rows.push({ symbol: asset, instrumentId: Number(instrumentId), category: classifyAsset(asset, rules[asset]), tradable: true, source: 'CURRENT_WATCHLIST' });
  }
  const known = new Set(rows.map((row) => row.symbol));
  for (const candidate of Array.isArray(extraCandidates) ? extraCandidates : []) {
    const symbol = String(candidate?.symbol || '').trim().toUpperCase();
    if (!symbol || known.has(symbol)) continue;
    const instrumentId = Number(candidate.instrumentId);
    rows.push({
      symbol,
      instrumentId: Number.isSafeInteger(instrumentId) && instrumentId > 0 ? instrumentId : null,
      category: ['ETF', 'STOCK', 'CRYPTO', 'SMART_PORTFOLIO'].includes(String(candidate.category || '').toUpperCase())
        ? String(candidate.category).toUpperCase() : 'UNCLASSIFIED',
      tradable: false,
      status: 'ANALYSIS_ONLY_REQUIRES_EXPLICIT_TRADE_ALLOWLIST',
      source: 'CONFIGURED_ANALYSIS_CANDIDATE'
    });
    known.add(symbol);
  }
  return rows;
}

function resolveTradeAllowlist(watchlist = {}, env = {}) {
  const known = new Set(Object.keys(watchlist).map((asset) => asset.toUpperCase()));
  const configured = String(env.TRADE_ALLOWED_ASSETS || '').trim();
  const requested = configured ? configured.split(',').map((value) => value.trim().toUpperCase()).filter(Boolean) : [];
  const denied = new Set(String(env.TRADE_EXCLUDED_ASSETS || '').split(',').map((value) => value.trim().toUpperCase()).filter(Boolean));
  return [...new Set(requested)].filter((asset) => known.has(asset) && !denied.has(asset)).sort();
}

function resolveAllowedCategories(env = {}) {
  return [...new Set(String(env.TRADE_ALLOWED_CATEGORIES || '').split(',')
    .map((value) => value.trim().toUpperCase()).filter((value) => ['ETF', 'STOCK', 'CRYPTO'].includes(value)))].sort();
}

function parseExclusionReasons(env = {}) {
  try {
    const parsed = JSON.parse(String(env.TRADE_EXCLUSIONS_JSON || '{}'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).map(([asset, reason]) => [String(asset).toUpperCase(), String(reason).slice(0, 200)]));
  } catch { return {}; }
}

function analyzeLookThroughExposure({ positions = [], compositions = [], now = Date.now(), maxAgeDays = 7 } = {}) {
  const direct = {};
  for (const position of Array.isArray(positions) ? positions : []) {
    const symbol = String(position?.asset || position?.symbol || '').trim().toUpperCase();
    const value = Number(position?.estimatedValue ?? position?.value ?? position?.amount);
    if (symbol && Number.isFinite(value) && value >= 0) direct[symbol] = (direct[symbol] || 0) + value;
  }
  const indirect = {};
  const usable = [];
  const unavailable = [];
  for (const composition of Array.isArray(compositions) ? compositions : []) {
    const captured = Date.parse(composition?.capturedAt || '');
    const ageDays = Number.isFinite(captured) ? (now - captured) / 86400000 : null;
    if (composition?.sourceType !== 'OFFICIAL_ETORO_API' || !Array.isArray(composition?.holdings) ||
        ageDays === null || ageDays < 0 || ageDays > maxAgeDays) {
      unavailable.push({ portfolio: composition?.symbol || null, reason: 'SOURCE_OR_COMPOSITION_UNVERIFIED_OR_STALE' });
      continue;
    }
    usable.push(composition.symbol || null);
    const portfolioValue = Number(composition.estimatedValue ?? composition.value);
    if (!Number.isFinite(portfolioValue) || portfolioValue < 0) {
      unavailable.push({ portfolio: composition.symbol || null, reason: 'PORTFOLIO_VALUE_UNKNOWN' });
      continue;
    }
    for (const holding of composition.holdings) {
      const symbol = String(holding?.symbol || '').trim().toUpperCase();
      const weight = Number(holding?.weightPct);
      if (!symbol || !Number.isFinite(weight) || weight < 0 || weight > 100) continue;
      indirect[symbol] = (indirect[symbol] || 0) + portfolioValue * weight / 100;
    }
  }
  const symbols = [...new Set([...Object.keys(direct), ...Object.keys(indirect)])].sort();
  if (!Array.isArray(compositions) || compositions.length === 0) {
    unavailable.push({ portfolio: null, reason: 'LOOK_THROUGH_COMPOSITIONS_NOT_CONFIGURED' });
  }
  return {
    direct,
    indirect,
    combined: Object.fromEntries(symbols.map((symbol) => [symbol, Math.round(((direct[symbol] || 0) + (indirect[symbol] || 0)) * 1e6) / 1e6])),
    knownOfficialCompositions: usable,
    unavailable,
    coverage: unavailable.length ? 'INCOMPLETE' : 'COMPLETE',
    caveat: unavailable.length ? 'Unknown or stale basket holdings are not counted as diversification.' : null
  };
}

function evaluateBuyPolicy({ mode, armed = false, confirmation = '', demoArmed = false,
  accountEnvironment = '', asset, category, allowedAssets = [], allowedCategories = [], amount, maxOrderUsd = 10,
  minOrderUsd = 1, quoteFresh = false, availableCash, minimumCashReserve = 0,
  currentPositionCount = 0, maxPositions = 12, duplicateOrPending = false } = {}) {
  const blockers = [];
  const normalizedMode = String(mode || '').toUpperCase();
  const symbol = String(asset || '').toUpperCase();
  if (!['DEMO', 'LIVE'].includes(normalizedMode)) blockers.push('EXECUTION_MODE_NOT_ORDER_CAPABLE');
  if (!Array.isArray(allowedAssets) || !allowedAssets.map((v) => String(v).toUpperCase()).includes(symbol)) blockers.push('ASSET_NOT_ALLOWLISTED');
  if (!['ETF', 'STOCK', 'CRYPTO'].includes(String(category || '').toUpperCase())) blockers.push('ASSET_CATEGORY_NOT_TRADEABLE');
  if (!Array.isArray(allowedCategories) || !allowedCategories.map((v) => String(v).toUpperCase()).includes(String(category || '').toUpperCase())) blockers.push('ASSET_CATEGORY_NOT_ALLOWLISTED');
  if (normalizedMode === 'LIVE' && (!armed || confirmation !== LIVE_BUY_CONFIRMATION)) blockers.push('LIVE_BUY_NOT_EXPLICITLY_ARMED');
  if (normalizedMode === 'DEMO' && (!demoArmed || String(accountEnvironment).toUpperCase() !== 'DEMO')) blockers.push('DEMO_ACCOUNT_NOT_EXPLICITLY_ARMED');
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount < minOrderUsd) blockers.push('ORDER_AMOUNT_INVALID');
  if (Number.isFinite(numericAmount) && numericAmount > liveBuyMaxOrderUsd(maxOrderUsd)) blockers.push('ORDER_AMOUNT_ABOVE_HARD_CAP');
  if (!quoteFresh) blockers.push('FRESH_QUOTE_REQUIRED');
  const cash = Number(availableCash);
  if (!Number.isFinite(cash) || cash < numericAmount + Number(minimumCashReserve || 0)) blockers.push('AVAILABLE_CASH_OR_RESERVE_INSUFFICIENT');
  if (!Number.isFinite(Number(currentPositionCount)) || Number(currentPositionCount) >= Number(maxPositions)) blockers.push('POSITION_LIMIT_REACHED_OR_UNKNOWN');
  if (duplicateOrPending) blockers.push('DUPLICATE_OR_PENDING_ORDER');
  return { allowed: blockers.length === 0, blockers, executionAttempted: false };
}

module.exports = {
  LIVE_BUY_CONFIRMATION, resolveTradingMode, liveBuyReady, demoBuyReady,
  liveBuyMaxOrderUsd, classifyAsset, buildUniverse, resolveTradeAllowlist, resolveAllowedCategories, parseExclusionReasons,
  analyzeLookThroughExposure, evaluateBuyPolicy
};
