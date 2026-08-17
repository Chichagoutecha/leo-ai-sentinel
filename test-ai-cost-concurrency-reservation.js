'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');

// Run with ai-cost-optimizer + Luna compatibility preloaded and test-specific pricing env.
test('concurrent projected-cost reservations block calls that would jointly exceed monthly budget',async()=>{
  let providerCalls=0;
  const pending=[];
  const fakeFetch=async()=>{
    providerCalls++;
    await new Promise(resolve=>pending.push(resolve));
    return new Response(JSON.stringify({
      id:`chatcmpl-${providerCalls}`,object:'chat.completion',created:1,model:'gpt-5.6-luna',
      choices:[{index:0,message:{role:'assistant',content:'{"action":"HOLD"}'},finish_reason:'stop'}],
      usage:{prompt_tokens:50,completion_tokens:10,total_tokens:60,prompt_tokens_details:{cached_tokens:0}}
    }),{status:200,headers:{'content-type':'application/json'}});
  };
  const OpenAI=require('openai');
  const client=new OpenAI({apiKey:'test-key-not-secret',fetch:fakeFetch});
  const params={model:'gpt-4.1-mini',temperature:.1,max_tokens:5000,messages:[{role:'user',content:'hold'}],response_format:{type:'json_object'}};

  const calls=[0,1,2].map(()=>client.chat.completions.create(params).then(x=>({ok:true,x}),e=>({ok:false,e})));
  await new Promise(resolve=>setTimeout(resolve,25));
  // With ~0.048 projected per call and $0.10 budget, at most two provider calls may be in flight.
  assert.ok(providerCalls<=2,`providerCalls=${providerCalls}`);
  for(const resolve of pending.splice(0))resolve();
  const results=await Promise.all(calls);
  const blocked=results.filter(r=>!r.ok&&r.e?.name==='LeoAICostBudgetError');
  const success=results.filter(r=>r.ok);
  assert.ok(blocked.length>=1,JSON.stringify(results.map(r=>r.ok?'OK':r.e?.code)));
  assert.ok(success.length<=2);
  const state=await global.__LEO_AI_COST_STATE__();
  assert.equal(state.inFlightProjectedUsd,0);
  assert.ok(state.state.blockedCalls>=1);
});
