'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hasStrongExecutionBusinessAcknowledgement } = require('./execution-ack-policy');

test('strong acknowledgement requires durable execution proof', () => {
  assert.equal(hasStrongExecutionBusinessAcknowledgement({ orderId: '123' }), true);
  assert.equal(hasStrongExecutionBusinessAcknowledgement({ positionId: '456' }), true);
  assert.equal(hasStrongExecutionBusinessAcknowledgement({ token: 'tok' }), true);
  assert.equal(hasStrongExecutionBusinessAcknowledgement({ referenceId: 'ref' }), true);
  assert.equal(hasStrongExecutionBusinessAcknowledgement({ success: true }), true);
});

test('status, message or error metadata alone is not durable order proof', () => {
  assert.equal(hasStrongExecutionBusinessAcknowledgement({ statusId: 0 }), false);
  assert.equal(hasStrongExecutionBusinessAcknowledgement({ message: 'request received' }), false);
  assert.equal(hasStrongExecutionBusinessAcknowledgement({ errorCode: 'NONE' }), false);
  assert.equal(hasStrongExecutionBusinessAcknowledgement({ statusId: 1, message: 'accepted' }), false);
});

test('null, empty and false acknowledgements are not strong', () => {
  assert.equal(hasStrongExecutionBusinessAcknowledgement(null), false);
  assert.equal(hasStrongExecutionBusinessAcknowledgement({}), false);
  assert.equal(hasStrongExecutionBusinessAcknowledgement({ orderId: '' }), false);
  assert.equal(hasStrongExecutionBusinessAcknowledgement({ token: null, success: false }), false);
});
