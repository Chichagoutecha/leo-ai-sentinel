'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isLunaModel, sanitizeLunaParams } = require('./ai-luna-temperature-compat.js');

test('detects GPT-5.6 Luna model names', () => {
  assert.equal(isLunaModel('gpt-5.6-luna'), true);
  assert.equal(isLunaModel('GPT-5.6-LUNA'), true);
  assert.equal(isLunaModel('gpt-4.1-mini'), false);
});

test('removes explicit temperature for Luna without mutating caller input', () => {
  const input = { model: 'gpt-5.6-luna', temperature: 0.1, max_completion_tokens: 1200, messages: [{ role: 'user', content: 'x' }] };
  const output = sanitizeLunaParams(input);
  assert.equal(Object.prototype.hasOwnProperty.call(output, 'temperature'), false);
  assert.equal(input.temperature, 0.1);
  assert.equal(output.model, 'gpt-5.6-luna');
  assert.equal(output.max_completion_tokens, 1200);
  assert.deepEqual(output.messages, input.messages);
});

test('removes temperature when optimizer force-routes another requested model to Luna', () => {
  const output = sanitizeLunaParams(
    { model: 'gpt-4.1-mini', temperature: 0.1 },
    { forcePrimaryModel: true, primaryModel: 'gpt-5.6-luna' }
  );
  assert.equal(Object.prototype.hasOwnProperty.call(output, 'temperature'), false);
});

test('also removes temperature=1 so provider default is used', () => {
  const output = sanitizeLunaParams({ model: 'gpt-5.6-luna', temperature: 1 });
  assert.equal(Object.prototype.hasOwnProperty.call(output, 'temperature'), false);
});

test('does not alter temperature for a non-Luna effective model', () => {
  const output = sanitizeLunaParams(
    { model: 'gpt-4.1-mini', temperature: 0.1 },
    { forcePrimaryModel: false, primaryModel: 'gpt-5.6-luna' }
  );
  assert.equal(output.temperature, 0.1);
});

test('does not add or remove unrelated request fields', () => {
  const input = {
    model: 'gpt-5.6-luna',
    temperature: 0.1,
    response_format: { type: 'json_object' },
    user: 'leo-sentinel',
    max_completion_tokens: 999
  };
  const output = sanitizeLunaParams(input);
  assert.deepEqual(output.response_format, input.response_format);
  assert.equal(output.user, input.user);
  assert.equal(output.max_completion_tokens, 999);
});
