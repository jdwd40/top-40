'use strict';
// The v1 daily transition is unsafe for a real-time v2 game. Fail without writes.
console.error('Daily catalogue migration retired. With the service stopped, use scripts/reset-hourly.js with an explicit private backup and original SHA256.');
process.exitCode = 1;
