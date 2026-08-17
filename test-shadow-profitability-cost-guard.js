'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {evaluateProfitability}=require('./shadow-profitability-cost-guard.js');

test('computes gross, net and source/route cost attribution',()=>{
  const r=evaluateProfitability([
    {decisionId:'1',source:'EXA',route:'LUNA',grossPnlUsd:3,spreadCostUsd:.2,slippageCostUsd:.1,aiCostUsd:.01,dataCostUsd:.02},
    {decisionId:'2',source:'QUANT',route:'QUANT_ONLY',grossPnlUsd:-1,spreadCostUsd:.1,slippageCostUsd:.05}
  ],{monthlyBudgetUsd:1});
  assert.equal(r.overall.grossPnlUsd,2);
  assert.ok(r.overall.netPnlUsd<2);
  assert.ok(r.bySource.EXA);
  assert.ok(r.byRoute.QUANT_ONLY);
  assert.equal(r.safety.canTrade,false);
});

test('flags AI budget overspend',()=>{
  const r=evaluateProfitability([{grossPnlUsd:2,aiCostUsd:1.2}],{monthlyBudgetUsd:1});
  assert.equal(r.status,'AI_BUDGET_EXCEEDED');
  assert.equal(r.budget.budgetRemainingUsd,0);
});

test('reports insufficient sample without inventing profitability',()=>{
  const r=evaluateProfitability([{grossPnlUsd:1}],{});
  assert.equal(r.status,'INSUFFICIENT_SAMPLE');
  assert.equal(r.safety.canBlockLive,false);
});
