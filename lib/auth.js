const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const COOKIE_NAME = 'kianistan_session';
const SESSION_TTL = '30d';

// MONGODB_URI being set is how the rest of this app already distinguishes a
// real deployment from local JSON-file dev (see lib/db.js) — reuse that same
// signal here so a missing secret fails loudly in prod instead of silently
// falling back to a value that's sitting in this file.
const IS_DEPLOYED = !!process.env.MONGODB_URI;

function requireSecret(name, devDefault) {
  const value = process.env[name];
  if (value) return value;
  if (IS_DEPLOYED) {
    throw new Error(`${name} must be set (no default allowed once MONGODB_URI is configured)`);
  }
  console.warn(`${name} not set — using an insecure default for local dev only.`);
  return devDefault;
}

const SESSION_SECRET = requireSecret('SESSION_SECRET', 'dev-only-insecure-session-secret');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = (stored || '').split(':');
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}

function signSession(userId) {
  return jwt.sign({ uid: userId }, SESSION_SECRET, { expiresIn: SESSION_TTL });
}

function verifySession(token) {
  const payload = jwt.verify(token, SESSION_SECRET);
  return payload.uid;
}

// OAuth callbacks are a top-level browser navigation away from and back to
// this app — the session cookie *should* survive that (SameSite=Lax allows
// top-level GETs), but relying on it as the only way to know which user is
// completing the flow is fragile. A short-lived signed state token makes the
// callback self-contained: whoever holds a valid, unexpired state IS the
// user who started this specific flow, regardless of cookie behavior.
const OAUTH_STATE_TTL = '10m';

function signOAuthState(userId, provider) {
  return jwt.sign({ uid: userId, provider, nonce: crypto.randomBytes(8).toString('hex') }, SESSION_SECRET, { expiresIn: OAUTH_STATE_TTL });
}

// Callers must check the returned `provider` against the route's own
// :provider param — a state minted for one provider should never be
// accepted at another provider's callback.
function verifyOAuthState(token) {
  const payload = jwt.verify(token, SESSION_SECRET);
  return { uid: payload.uid, provider: payload.provider };
}

// The app only ever needs to read back the one cookie it sets itself, so
// cookie parsing is hand-rolled here rather than pulling in cookie-parser.
function readSessionCookie(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === COOKIE_NAME) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

function setSessionCookie(res, token, secure) {
  const maxAgeSeconds = 30 * 24 * 60 * 60;
  const flags = [`Max-Age=${maxAgeSeconds}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) flags.push('Secure');
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; ${flags.join('; ')}`);
}

function clearSessionCookie(res, secure) {
  const flags = ['Max-Age=0', 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) flags.push('Secure');
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; ${flags.join('; ')}`);
}

// Applied explicitly on each protected route (never a blanket app.use) so a
// future route added in the wrong place can't end up silently unprotected.
function authRequired(req, res, next) {
  const token = readSessionCookie(req);
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  try {
    req.userId = verifySession(token);
    next();
  } catch (_) {
    res.status(401).json({ error: 'Session expired or invalid' });
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  signSession,
  verifySession,
  signOAuthState,
  verifyOAuthState,
  readSessionCookie,
  setSessionCookie,
  clearSessionCookie,
  authRequired,
};
