'use strict';

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rounded(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function normalizeTime(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : null;
}

/**
 * Modified Dietz is an approximate flow-adjusted return. It is reported only
 * when the caller can attest that the flow ledger and valuation window are
 * complete; unknown external flows must never be silently treated as zero.
 */
function calculateModifiedDietz({ snapshots = [], cashFlows = [], historyComplete = false } = {}) {
  if (!historyComplete) return { status: 'UNAVAILABLE', reason: 'CASH_FLOW_HISTORY_INCOMPLETE', returnPct: null };
  const rawPoints = Array.isArray(snapshots) ? snapshots : [];
  if (rawPoints.some((point) => normalizeTime(point?.time) === null || finite(point?.equity) === null)) {
    return { status: 'UNAVAILABLE', reason: 'INVALID_VALUATION_POINT', returnPct: null };
  }
  const points = rawPoints
    .map((point) => ({ time: normalizeTime(point?.time), equity: finite(point?.equity), point }))
    .sort((a, b) => a.time - b.time);
  if (points.length < 2) return { status: 'UNAVAILABLE', reason: 'INSUFFICIENT_VALUATION_POINTS', returnPct: null };
  const first = points[0];
  const last = points[points.length - 1];
  const duration = last.time - first.time;
  if (duration <= 0) return { status: 'UNAVAILABLE', reason: 'NON_POSITIVE_MEASUREMENT_WINDOW', returnPct: null };
  if (first.point?.valuationComplete !== true || last.point?.valuationComplete !== true) {
    return { status: 'UNAVAILABLE', reason: 'ENDPOINT_VALUATION_INCOMPLETE', returnPct: null };
  }
  const flows = [];
  for (const flow of Array.isArray(cashFlows) ? cashFlows : []) {
    const time = normalizeTime(flow?.time);
    const amount = finite(flow?.signedAmount);
    if (time === null || amount === null) return { status: 'UNAVAILABLE', reason: 'INVALID_CASH_FLOW', returnPct: null };
    if (time < first.time || time > last.time) return { status: 'UNAVAILABLE', reason: 'CASH_FLOW_OUTSIDE_VALUATION_WINDOW', returnPct: null };
    if (flow?.valuationComplete !== true) return { status: 'UNAVAILABLE', reason: 'CASH_FLOW_VALUATION_INCOMPLETE', returnPct: null };
    flows.push({ time, amount });
  }
  const netFlows = flows.reduce((sum, flow) => sum + flow.amount, 0);
  const weightedFlows = flows.reduce((sum, flow) => sum + flow.amount * ((last.time - flow.time) / duration), 0);
  const denominator = first.equity + weightedFlows;
  if (!(denominator > 0)) return { status: 'UNAVAILABLE', reason: 'NON_POSITIVE_DIETZ_DENOMINATOR', returnPct: null };
  const ratio = (last.equity - first.equity - netFlows) / denominator;
  return {
    status: 'APPROXIMATE', method: 'MODIFIED_DIETZ', returnPct: rounded(ratio * 100, 6),
    startTime: new Date(first.time).toISOString(), endTime: new Date(last.time).toISOString(),
    startEquity: rounded(first.equity), endEquity: rounded(last.equity),
    netExternalFlows: rounded(netFlows), flowCount: flows.length,
    note: 'Approximation ajustée des flux; elle ne prouve pas une performance future.'
  };
}

function calculateFlowAdjustedDailyRisk({ snapshots = [], cashFlows = [], historyComplete = false,
  snapshotHistoryComplete = false, performanceBaseline = null } = {}) {
  if (!historyComplete) return { status: 'UNAVAILABLE', reason: 'CASH_FLOW_HISTORY_INCOMPLETE', maxDrawdownPct: null, annualizedVolatilityPct: null };
  if (!snapshotHistoryComplete) return { status: 'UNAVAILABLE', reason: 'SNAPSHOT_HISTORY_INCOMPLETE', maxDrawdownPct: null, annualizedVolatilityPct: null };
  const rawSnapshots = Array.isArray(snapshots) ? snapshots : [];
  if (rawSnapshots.some((point) => normalizeTime(point?.time) === null || finite(point?.equity) === null)) {
    return { status: 'UNAVAILABLE', reason: 'INVALID_VALUATION_POINT', maxDrawdownPct: null, annualizedVolatilityPct: null };
  }
  const all = rawSnapshots
    .map((point) => ({ time: normalizeTime(point?.time), equity: finite(point?.equity), point }))
    .sort((a, b) => a.time - b.time);
  const baselineTime = normalizeTime(performanceBaseline?.time);
  const baselineEquity = finite(performanceBaseline?.equity);
  if (baselineTime === null || baselineEquity === null || performanceBaseline?.valuationComplete !== true) {
    return { status: 'UNAVAILABLE', reason: 'BASELINE_VALUATION_INCOMPLETE', maxDrawdownPct: null, annualizedVolatilityPct: null };
  }
  const daily = new Map();
  for (const value of all) daily.set(new Date(value.time).toISOString().slice(0, 10), value);
  if ([...daily.values()].some(({ point }) => point.valuationComplete !== true)) {
    return { status: 'UNAVAILABLE', reason: 'INCOMPLETE_DAILY_VALUATION', maxDrawdownPct: null, annualizedVolatilityPct: null };
  }
  const points = [{ time: baselineTime, equity: baselineEquity }];
  for (const value of [...daily.values()].sort((a, b) => a.time - b.time)) {
    if (new Date(value.time).toISOString().slice(0, 10) <= new Date(baselineTime).toISOString().slice(0, 10)) continue;
    if (value.time > points[points.length - 1].time) points.push({ time: value.time, equity: value.equity });
  }
  if (points.length < 3) return { status: 'UNAVAILABLE', reason: 'INSUFFICIENT_DAILY_OBSERVATIONS', maxDrawdownPct: null, annualizedVolatilityPct: null, observations: points.length };
  const flows = [];
  for (const flow of Array.isArray(cashFlows) ? cashFlows : []) {
    const time = normalizeTime(flow?.time);
    const amount = finite(flow?.signedAmount);
    if (time === null || amount === null) return { status: 'UNAVAILABLE', reason: 'INVALID_CASH_FLOW', maxDrawdownPct: null, annualizedVolatilityPct: null };
    if (time <= points[0].time || time > points[points.length - 1].time) {
      return { status: 'UNAVAILABLE', reason: 'CASH_FLOW_OUTSIDE_VALUATION_WINDOW', maxDrawdownPct: null, annualizedVolatilityPct: null };
    }
    if (flow?.valuationComplete !== true) return { status: 'UNAVAILABLE', reason: 'CASH_FLOW_VALUATION_INCOMPLETE', maxDrawdownPct: null, annualizedVolatilityPct: null };
    flows.push({ time, amount });
  }
  const returns = [];
  const index = [1];
  for (let i = 1; i < points.length; i += 1) {
    const start = points[i - 1];
    const end = points[i];
    const duration = end.time - start.time;
    if (duration <= 0 || start.equity <= 0) return { status: 'UNAVAILABLE', reason: 'INVALID_DAILY_INTERVAL', maxDrawdownPct: null, annualizedVolatilityPct: null };
    const intervalFlows = flows.filter((flow) => flow.time > start.time && flow.time <= end.time);
    const netFlows = intervalFlows.reduce((sum, flow) => sum + flow.amount, 0);
    const weightedFlows = intervalFlows.reduce((sum, flow) => sum + flow.amount * ((end.time - flow.time) / duration), 0);
    const denominator = start.equity + weightedFlows;
    if (!(denominator > 0)) return { status: 'UNAVAILABLE', reason: 'NON_POSITIVE_DAILY_DENOMINATOR', maxDrawdownPct: null, annualizedVolatilityPct: null };
    const dailyReturn = (end.equity - start.equity - netFlows) / denominator;
    returns.push(dailyReturn);
    index.push(index[index.length - 1] * (1 + dailyReturn));
  }
  let peak = index[0];
  let maxDrawdown = 0;
  for (const value of index) {
    peak = Math.max(peak, value);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - value) / peak);
  }
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.length > 1 ? returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1) : null;
  return {
    status: returns.length >= 2 ? 'APPROXIMATE' : 'INSUFFICIENT_HISTORY',
    method: 'DAILY_MODIFIED_DIETZ_LINKING',
    maxDrawdownPct: returns.length >= 1 ? rounded(maxDrawdown * 100, 6) : null,
    annualizedVolatilityPct: returns.length >= 2 && variance !== null ? rounded(Math.sqrt(variance) * Math.sqrt(252) * 100, 6) : null,
    observations: points.length,
    returnIntervals: returns.length,
    note: 'Risque estimé à partir des valorisations quotidiennes observées et des flux enregistrés.'
  };
}

function buildPaperShadowScorecard(paper, basePerformance = {}) {
  if (!paper || typeof paper !== 'object') {
    return { status: 'NOT_INITIALIZED', virtualOnly: true, performance: null };
  }
  const snapshots = Array.isArray(paper.snapshots) ? paper.snapshots : [];
  const flows = Array.isArray(paper.cashFlows) ? paper.cashFlows : [];
  const latest = snapshots[snapshots.length - 1] || null;
  const valuationWindow = paper.performanceBaseline && latest
    ? [paper.performanceBaseline, latest]
    : snapshots;
  const flowAdjusted = calculateModifiedDietz({
    snapshots: valuationWindow,
    cashFlows: flows,
    historyComplete: paper.cashFlowHistoryComplete === true && Boolean(paper.performanceBaseline)
  });
  const adjustedRisk = calculateFlowAdjustedDailyRisk({
    snapshots,
    cashFlows: flows,
    historyComplete: paper.cashFlowHistoryComplete === true,
    snapshotHistoryComplete: paper.snapshotHistoryComplete === true,
    performanceBaseline: paper.performanceBaseline
  });
  const orders = Array.isArray(paper.orders) ? paper.orders : [];
  const turnoverNotional = orders.reduce((sum, order) => {
    const amount = finite(order?.amount ?? order?.proceeds ?? order?.notional);
    return sum + (amount === null ? 0 : Math.abs(amount));
  }, 0);
  const firstEquity = finite(snapshots[0]?.equity);
  const lastEquity = finite(latest?.equity);
  const averageEquity = firstEquity !== null && lastEquity !== null ? (firstEquity + lastEquity) / 2 : null;
  const benchmark = paper.benchmark || {};
  const benchmarkCurrent = finite(benchmark.currentPrice);
  const benchmarkStart = finite(benchmark.startPrice);
  const benchmarkCurrencyMatches = Boolean(paper.currency && benchmark.currency &&
    String(paper.currency).toUpperCase() === String(benchmark.currency).toUpperCase());
  const baselineTime = normalizeTime(paper.performanceBaseline?.time);
  const benchmarkTime = normalizeTime(benchmark.startTime);
  const benchmarkWindowMatches = baselineTime !== null && benchmarkTime !== null &&
    Math.abs(baselineTime - benchmarkTime) <= 60000;
  const benchmarkReturnPct = benchmarkCurrencyMatches && benchmarkWindowMatches &&
    benchmark.startPriceStatus === 'FRESH' && benchmark.priceStatus === 'FRESH' && benchmarkStart > 0 && benchmarkCurrent > 0
    ? rounded((benchmarkCurrent / benchmarkStart - 1) * 100, 6) : null;
  const decisions = Array.isArray(paper.decisions) ? paper.decisions : [];
  const vetoed = decisions.filter((item) => item?.status === 'VETOED').length;
  const incompleteValuations = snapshots.filter((item) => item?.valuationComplete !== true).length;
  const missingAssets = [...new Set([
    ...snapshots.flatMap((item) => item?.priceCoverage?.missingAssets || []),
    ...(paper.seedCoverage?.omittedAssets || [])
  ])].sort();
  const staleAssets = [...new Set(snapshots.flatMap((item) => item?.priceCoverage?.staleAssets || []))].sort();
  const marketClosedAssets = [...new Set(snapshots.flatMap((item) => item?.priceCoverage?.marketClosedAssets || []))].sort();
  const knownCosts = {
    estimatedFees: finite(paper.feesPaid),
    estimatedSlippage: finite(paper.slippageCost),
    feeRatePctAssumption: finite(paper.assumptions?.feePct),
    slippageBpsPerSideAssumption: finite(paper.assumptions?.slippageBpsPerSide),
    basis: 'CONFIGURED_SIMULATION_ASSUMPTIONS'
  };
  return {
    status: flowAdjusted.status === 'UNAVAILABLE' || adjustedRisk.status !== 'APPROXIMATE' || incompleteValuations > 0 || paper.snapshotHistoryComplete === false
      ? 'INCOMPLETE_COVERAGE' : 'MEASURED_VIRTUAL',
    virtualOnly: true,
    notRealReturns: true,
    currency: paper.currency || null,
    period: {
      from: paper.performanceBaseline?.time || paper.createdAt || null,
      to: latest?.time || null,
      snapshotsInRetainedWindow: snapshots.length,
      retainedSnapshotWindowFrom: snapshots[0]?.time || null,
      snapshotHistoryComplete: paper.snapshotHistoryComplete !== false
    },
    return: {
      rawTotalReturnPct: basePerformance.totalReturnPct ?? null,
      flowAdjusted,
      benchmark: {
        asset: benchmark.asset || null,
        returnPct: benchmarkReturnPct,
        returnType: 'PRICE_RETURN_ONLY',
        currency: benchmark.currency || null,
        currencySource: benchmark.currencySource || 'UNKNOWN',
        windowMatchesPortfolio: benchmarkWindowMatches,
        priceStatus: benchmark.priceStatus || 'UNKNOWN',
        status: benchmarkReturnPct === null ? 'UNAVAILABLE_STALE_OR_CURRENCY_MISMATCH' : 'AVAILABLE'
      }
    },
    risk: {
      status: adjustedRisk.status,
      method: adjustedRisk.method || null,
      maxDrawdownPct: adjustedRisk.maxDrawdownPct,
      annualizedVolatilityPct: adjustedRisk.annualizedVolatilityPct,
      observations: adjustedRisk.observations ?? null,
      reason: adjustedRisk.reason || null,
      legacyUnadjusted: {
        maxDrawdownPct: basePerformance.maxDrawdownPct ?? null,
        annualizedVolatilityPct: basePerformance.annualizedVolatilityPct ?? null,
        sharpe: basePerformance.sharpe ?? null,
        sortino: basePerformance.sortino ?? null,
        label: 'NON_AJUSTE_DES_FLUX_HISTORIQUES'
      }
    },
    activity: {
      cashFlows: {
        deposits: rounded(flows.filter((flow) => flow?.type === 'DEPOSIT').reduce((sum, flow) => sum + (finite(flow.amount) || 0), 0)),
        withdrawals: rounded(flows.filter((flow) => flow?.type === 'WITHDRAWAL').reduce((sum, flow) => sum + (finite(flow.amount) || 0), 0)),
        depositCount: flows.filter((flow) => flow?.type === 'DEPOSIT').length,
        withdrawalCount: flows.filter((flow) => flow?.type === 'WITHDRAWAL').length,
        currency: paper.currency || null,
        status: paper.cashFlowHistoryComplete === true ? 'RECORDED_LEDGER' : 'INCOMPLETE_HISTORY'
      },
      ordersInRetainedWindow: orders.length,
      turnoverNotional: rounded(turnoverNotional),
      turnoverPctOfAverageEquity: averageEquity > 0 ? rounded(turnoverNotional / averageEquity * 100, 6) : null,
      decisionsInRetainedWindow: decisions.length,
      vetoedDecisions: vetoed
    },
    costs: {
      simulated: knownCosts,
      observedBrokerFees: null,
      estimatedCosts: { fees: knownCosts.estimatedFees, slippage: knownCosts.estimatedSlippage, basis: knownCosts.basis },
      measuredBrokerCosts: null,
      unknown: ['BROKER_FEES_NOT_OBSERVED_IN_SHADOW', 'FX_COSTS', 'TAXES', 'MARKET_IMPACT', 'INFRASTRUCTURE_AND_PROVIDER_COSTS']
    },
    dataCoverage: {
      completeValuations: snapshots.length - incompleteValuations,
      incompleteValuations,
      missingPriceAssets: missingAssets,
      stalePriceAssets: staleAssets,
      marketClosedAssets,
      cashFlowHistoryComplete: paper.cashFlowHistoryComplete === true,
      snapshotHistoryComplete: paper.snapshotHistoryComplete !== false,
      seedCoverageComplete: paper.seedCoverage?.complete === true,
      benchmarkCurrencyMatches,
      status: incompleteValuations === 0 && flowAdjusted.status !== 'UNAVAILABLE' && adjustedRisk.status === 'APPROXIMATE' && paper.snapshotHistoryComplete !== false
        ? 'COMPLETE' : 'INCOMPLETE'
    },
    limitations: [
      'Simulation hypothétique; exécutions, frais et glissement peuvent différer du marché réel.',
      'Le benchmark utilise ici un rendement de prix, sans dividendes, sauf source documentée différente.',
      'Les coûts externes non observés restent inconnus; aucun indicateur ne prédit les rendements futurs.'
    ]
  };
}

module.exports = { calculateModifiedDietz, calculateFlowAdjustedDailyRisk, buildPaperShadowScorecard };
