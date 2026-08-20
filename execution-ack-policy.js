'use strict';

/**
 * Strong eToro execution acknowledgement policy.
 *
 * A durable acknowledgement must contain an execution identifier or an explicit
 * success boolean. Text/status/error metadata alone is not proof that an order
 * actually exists and therefore must not keep a no-effect intent active forever.
 */
function present(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function hasStrongExecutionBusinessAcknowledgement(response = null) {
  if (!response || typeof response !== 'object') return false;
  if (present(response.orderId)) return true;
  if (present(response.positionId)) return true;
  if (present(response.token)) return true;
  if (present(response.referenceId)) return true;
  if (response.success === true) return true;
  return false;
}

module.exports = { hasStrongExecutionBusinessAcknowledgement };
