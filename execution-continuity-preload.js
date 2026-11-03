'use strict';

// Installed before the other fetch wrappers, including UCITS translation.
const { guardExecutionFetch } = require('./execution-continuity');
global.fetch = guardExecutionFetch(global.fetch);
module.exports = true;
