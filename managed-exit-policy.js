'use strict';

const positive = value => Number.isFinite(value) && value > 0;
const nonnegative = value => Number.isFinite(value) && value >= 0;

function assessClose(proposal, evidence, settings, now) {
  const reasons = [];
  const entry = proposal.side === 'BUY';
  const terms = evidence?.closeTerms;
  const quote = evidence?.quote;
  const age = now - Date.parse(terms?.asOf);
  const cap = settings.maxExitNotionalUsd;
  if (!positive(cap)) reasons.push('EXIT_CAP_REVIEW_REQUIRED');
  if (quote?.tradable !== true) reasons.push('EXIT_MARKET_UNAVAILABLE');
  if (entry && (settings.exitsEnabled !== true || evidence?.limits?.exitSlotAfterEntry !== true)) {
    reasons.push('EXIT_CAPACITY_UNAVAILABLE');
  }

  // Evidence must describe a full close for this account and exact decision.
  // OPEN minimums and the partial-close eligibility flag are insufficient.
  if (!terms || !Number.isFinite(age) || age < 0 || age > 300000 ||
      terms.accountRef !== evidence.accountRef || terms.instrumentId !== proposal.instrumentId ||
      terms.proposalId !== proposal.proposalId || terms.currency !== 'USD' ||
      terms.settlementType !== 'Underlying' || terms.leverage !== 1 || terms.fullCloseAllowed !== true ||
      !nonnegative(terms.minimumUsd) || !positive(terms.maximumUsd) || terms.maximumUsd < terms.minimumUsd ||
      !nonnegative(terms.minimumUnits) || !positive(terms.maximumUnits) || terms.maximumUnits < terms.minimumUnits ||
      terms.costCoverage !== 'COMPLETE_ESTIMATE' || !nonnegative(terms.maximumCostUsd) ||
      !nonnegative(settings.maxCostUsd) || terms.maximumCostUsd > settings.maxCostUsd ||
      (entry ? terms.entryAmountUsd !== proposal.amountUsd :
        String(terms.positionId) !== String(proposal.positionId) || terms.units !== proposal.units ||
        evidence.cost?.totalUsd > terms.maximumCostUsd)) {
    reasons.push('FULL_CLOSE_TERMS_UNVERIFIED');
    return { reasons, futureAvailabilityGuaranteed: false };
  }

  const minUnits = entry ? terms.projectedMinUnits : proposal.units;
  const maxUnits = entry ? terms.projectedMaxUnits : proposal.units;
  const existingUnits = entry ? (evidence.positions || [])
    .filter(row => row.instrumentId === proposal.instrumentId)
    .reduce((sum, row) => sum + (positive(row.units) ? row.units : NaN), 0) : 0;
  if (!positive(minUnits) || !positive(maxUnits) || minUnits > maxUnits || !nonnegative(existingUnits)) {
    reasons.push('EXIT_QUANTITY_UNVERIFIED');
    return { reasons, futureAvailabilityGuaranteed: false };
  }

  // Screen downside and upside independently. The proposal's drift tolerance
  // is a scenario width, not an estimate of the maximum future price move.
  const drift = entry ? proposal.priceDriftLimitPct / 100 : 0;
  if (entry && (!positive(quote?.bid) || !positive(quote?.ask) || drift >= 1 ||
      minUnits > proposal.amountUsd / (quote.ask * (1 + drift)) ||
      maxUnits < proposal.amountUsd / (quote.bid * (1 - drift)))) {
    reasons.push('EXIT_QUANTITY_UNVERIFIED');
    return { reasons, futureAvailabilityGuaranteed: false };
  }
  const low = minUnits * quote?.bid * (1 - drift);
  const high = (maxUnits + existingUnits) * (entry ? quote?.ask : quote?.bid) * (1 + drift);
  if (!positive(low) || !positive(high) || minUnits < terms.minimumUnits ||
      maxUnits + existingUnits > terms.maximumUnits || low < terms.minimumUsd || high > terms.maximumUsd) {
    reasons.push('FULL_CLOSE_SIZE_OUTSIDE_LIMITS');
  }
  if (positive(cap) && high > cap) reasons.push('FULL_EXIT_EXCEEDS_ORDER_CAP_PARTIAL_CLOSE_UNSUPPORTED');
  return { reasons, futureAvailabilityGuaranteed: false, minimumScenarioUsd: low, maximumScenarioUsd: high };
}

function escalation(reasons) {
  return { action: 'OPERATOR_REVIEW', reasons, automaticRetry: false, alternativeLiquidation: false };
}

module.exports = { assessClose, escalation };
