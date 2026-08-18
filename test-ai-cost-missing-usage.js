'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');

test('successful response without usage is charged conservatively instead of zero',async()=>{
  const fakeFetch=async()=>new Response(JSON.stringify({
    id:'chatcmpl-no-usage',object:'chat.completion',created:1,model:'gpt-5.6-luna',
    choices:[{index:0,message:{role:'assistant',content:'{"action":"HOLD"}'},finish_reason:'stop'}]
  }),{status:200,headers:{'content-type':'application/json'}});
  const OpenAI=require('openai');
  const client=new OpenAI({apiKey:'test-key-not-secret',fetch:fakeFetch});
  const response=await client.chat.completions.create({model:'gpt-4.1-mini',temperature:.1,max_tokens:5000,messages:[{role:'user',content:'hold'}]});
  assert.equal(response.model,'gpt-5.6-luna');
  const state=await global.__LEO_AI_COST_STATE__();
  assert.equal(state.state.successfulCalls,1);
  assert.ok(state.state.monthCostUsd>0);
  assert.equal(state.lastEvent.event,'CALL_COMPLETED');
  assert.equal(state.lastEvent.usageMissing,true);
  assert.equal(state.lastEvent.costBasis,'CONSERVATIVE_RESERVED_FALLBACK');
});
