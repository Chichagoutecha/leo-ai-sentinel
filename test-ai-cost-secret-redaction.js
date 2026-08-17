'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');

process.env.OPENAI_API_KEY='sk-super-secret-openai-key-123456789';
process.env.ETORO_API_KEY='etoro-super-secret-key-123456789';
const {redactSecrets,safeError}=require('./ai-cost-optimizer');

test('known and key-like secrets are redacted from optimizer error messages',()=>{
  const raw='authorization: Bearer sk-super-secret-openai-key-123456789 api_key=etoro-super-secret-key-123456789 token=abcdefghi123456';
  const redacted=redactSecrets(raw);
  assert.equal(redacted.includes('sk-super-secret-openai-key-123456789'),false);
  assert.equal(redacted.includes('etoro-super-secret-key-123456789'),false);
  assert.equal(redacted.includes('abcdefghi123456'),false);
  assert.ok(redacted.includes('[REDACTED]'));
});

test('safeError does not expose configured secrets',()=>{
  const error=new Error(`provider rejected ${process.env.OPENAI_API_KEY} and ${process.env.ETORO_API_KEY}`);
  error.code=`bad-token=${process.env.OPENAI_API_KEY}`;
  const safe=safeError(error);
  const text=JSON.stringify(safe);
  assert.equal(text.includes(process.env.OPENAI_API_KEY),false);
  assert.equal(text.includes(process.env.ETORO_API_KEY),false);
});
