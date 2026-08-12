// Gmail OAuth2. Bounce-checking needs IMAP access regardless of how sending
// is done, and Gmail's IMAP only accepts OAuth2 tokens carrying the broad
// `https://mail.google.com/` scope (Google's "restricted" tier) — there's no
// narrower IMAP-only scope. Since that scope is required anyway, sending
// also goes through it via nodemailer's built-in Gmail OAuth2 SMTP support,
// rather than the Gmail REST API's narrower `gmail.send` scope — one scope,
// one token, both operations, and the existing nodemailer/imapflow-based
// send/bounce-check code in server.js and lib/bounces.js runs unmodified
// (only the `auth` object shape differs from a password-based account).

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const SCOPE = 'https://mail.google.com/ openid email';

function creds() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Google sign-in is not configured (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET missing)');
  }
  return { clientId, clientSecret };
}

function buildAuthUrl(state, redirectUri) {
  const { clientId } = creds();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    // access_type=offline is required to get a refresh_token at all;
    // prompt=consent forces Google to reissue one even on a repeat consent
    // (by default it's only returned on the very first authorization).
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function tokenRequest(body) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Google: ${data.error_description || data.error || res.statusText}`);
  }
  return data;
}

async function exchangeCode(code, redirectUri) {
  const { clientId, clientSecret } = creds();
  // { access_token, refresh_token, expires_in, id_token, ... }
  return tokenRequest({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' });
}

async function refreshAccessToken(refreshToken) {
  const { clientId, clientSecret } = creds();
  // Google does not rotate the refresh token on refresh — no new one comes
  // back, the existing stored one stays valid.
  return tokenRequest({ refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token' });
}

// The access token alone doesn't say which mailbox it belongs to — fetch it
// once at connect time so it can be stored (used as the From/IMAP-login
// address on every future send, without a network round-trip each time).
async function fetchAccountEmail(accessToken) {
  const res = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google: could not read account info (${data.error?.message || res.statusText})`);
  if (!data.email) throw new Error('Google: account info had no email address');
  return data.email;
}

module.exports = { buildAuthUrl, exchangeCode, refreshAccessToken, fetchAccountEmail };
