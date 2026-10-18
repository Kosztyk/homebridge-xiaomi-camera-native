'use strict';
class XiaomiError extends Error {}
class AuthenticationError extends XiaomiError {}
class CloudError extends XiaomiError {}
class ProtocolError extends XiaomiError {}
class TransportError extends XiaomiError {}
class LoginChallenge extends XiaomiError {
  constructor(kind, details = {}) { super('Xiaomi account verification required'); this.kind = kind; Object.assign(this, details); }
}
// Only our deliberately constructed messages are allowed into logs and the UI.
function safeError(error) { return error instanceof XiaomiError ? error.message : 'Operation failed; check network access, configuration and installed FFmpeg.'; }
module.exports = { XiaomiError, AuthenticationError, CloudError, ProtocolError, TransportError, LoginChallenge, safeError };
