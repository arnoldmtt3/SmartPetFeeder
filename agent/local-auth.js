'use strict';
const { timingSafeEqual } = require('node:crypto');
const { allowedPath } = require('../shared/device-protocol');
function authorizeLocalAgent(req, token) {
  if (!token || token.length < 32) return false;
  const ip = req.socket.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return false;
  const allowed = allowedPath(req.method, req.path);
  if (!allowed) return false;
  const actual = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
module.exports = { authorizeLocalAgent };
