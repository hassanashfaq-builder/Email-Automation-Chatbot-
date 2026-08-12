// Zoho Mail OAuth2. Zoho's free tier has no SMTP/IMAP/POP access at all
// (confirmed on Zoho's own docs), and neither protocol documents OAuth2
// support even on paid plans — so unlike Gmail, both sending and
// bounce-checking here go entirely through Zoho's REST Mail API, not
// nodemailer/imapflow. No official Zoho Mail Node SDK exists; this uses
// plain fetch throughout.
//
// NOTE: the exact field names in Zoho's account-list/message-search/
// message-content JSON responses below are based on documented endpoint
// shapes and scopes, not a live test against a real Zoho account (no
// credentials exist yet to test against). Treat the account-info and
// bounce-checking parsing as best-effort — likely to need a small field-name
// fix once someone actually connects a real Zoho account and we can see a
// real response.

const { looksLikeBounce, extractBounceInfo } = require('../bounces');

// Auth always starts at accounts.zoho.com regardless of the user's actual
// data center — Zoho redirects appropriately and the callback tells us
// which DC the account really lives in via a `location` param. Every
// *subsequent* call (refresh, send, bounce-check) must use that DC's own
// host, or it fails.
const DC_HOSTS = {
  us: { accounts: 'accounts.zoho.com', mail: 'mail.zoho.com' },
  eu: { accounts: 'accounts.zoho.eu', mail: 'mail.zoho.eu' },
  in: { accounts: 'accounts.zoho.in', mail: 'mail.zoho.in' },
  au: { accounts: 'accounts.zoho.com.au', mail: 'mail.zoho.com.au' },
  jp: { accounts: 'accounts.zoho.jp', mail: 'mail.zoho.jp' },
  cn: { accounts: 'accounts.zoho.com.cn', mail: 'mail.zoho.com.cn' },
  ca: { accounts: 'accounts.zohocloud.ca', mail: 'mail.zohocloud.ca' },
  sa: { accounts: 'accounts.zoho.sa', mail: 'mail.zoho.sa' },
};
function hostsFor(dcLocation) {
  return DC_HOSTS[(dcLocation || 'us').toLowerCase()] || DC_HOSTS.us;
}

const SCOPE = 'ZohoMail.messages.ALL,ZohoMail.accounts.READ';

function creds() {
  const clientId = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Zoho sign-in is not configured (ZOHO_CLIENT_ID/ZOHO_CLIENT_SECRET missing)');
  }
  return { clientId, clientSecret };
}

function buildAuthUrl(state, redirectUri) {
  const { clientId } = creds();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `https://accounts.zoho.com/oauth/v2/auth?${params.toString()}`;
}

async function tokenRequest(accountsHost, body) {
  const res = await fetch(`https://${accountsHost}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(`Zoho: ${data.error || res.statusText}`);
  return data;
}

// Code exchange always happens against accounts.zoho.com — the DC-specific
// host only matters for calls made *after* we know `location` from the
// callback.
async function exchangeCode(code, redirectUri) {
  const { clientId, clientSecret } = creds();
  return tokenRequest('accounts.zoho.com', { grant_type: 'authorization_code', client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, code });
}

async function refreshAccessToken(refreshToken, dcLocation) {
  const { clientId, clientSecret } = creds();
  const { accounts } = hostsFor(dcLocation);
  return tokenRequest(accounts, { grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken });
}

// accountId is required by every other Mail API call — fetching it doubles
// as the connect-time "does this actually work" verification step (mirrors
// what transporter.verify() does for custom SMTP).
async function fetchAccountInfo(accessToken, dcLocation) {
  const { mail } = hostsFor(dcLocation);
  const res = await fetch(`https://${mail}/api/accounts`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Zoho: could not fetch account info (${data.status?.description || res.statusText})`);
  const account = (data.data || [])[0];
  if (!account) throw new Error('Zoho: no mail account found for this login');
  const email = account.primaryEmailAddress || account.emailAddress || account.mailId;
  if (!account.accountId || !email) throw new Error('Zoho: account info response was missing accountId/email');
  return { accountId: account.accountId, email };
}

async function sendMail(send, message) {
  const { mail } = hostsFor(send.zohoDcLocation);
  const res = await fetch(`https://${mail}/api/accounts/${send.zohoAccountId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Zoho-oauthtoken ${send.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fromAddress: send.fromEmail,
      toAddress: message.to,
      subject: message.subject,
      content: message.html || message.text,
      mailFormat: message.html ? 'html' : 'plaintext',
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.data?.moreInfo || data.status?.description || `Zoho: send failed (HTTP ${res.status})`);
  }
  return data;
}

// Zoho's search endpoint returns metadata only (sender/subject/date/ids),
// never the message body extractBounceInfo needs — genuinely a two-step
// process: search for DSN-shaped candidates, then fetch each candidate's
// content. Capped at 20 candidates per run to stay well under Zoho's flat
// 30 requests/minute/account limit.
async function checkBounces(bounceCheck, { since }) {
  const { mail } = hostsFor(bounceCheck.zohoDcLocation);
  const headers = { Authorization: `Zoho-oauthtoken ${bounceCheck.accessToken}` };

  const searchParams = new URLSearchParams({ searchKey: 'sender:mailer-daemon', limit: '20' });
  if (since) searchParams.set('receivedTime', String(since.getTime()));

  const searchRes = await fetch(`https://${mail}/api/accounts/${bounceCheck.zohoAccountId}/messages/search?${searchParams}`, { headers });
  if (!searchRes.ok) return []; // best-effort — a search failure just means "nothing found this run", not a hard error
  const searchData = await searchRes.json();
  const candidates = (searchData.data || []).slice(0, 20);

  const bounces = [];
  for (const msg of candidates) {
    try {
      const contentRes = await fetch(`https://${mail}/api/accounts/${bounceCheck.zohoAccountId}/folders/${msg.folderId}/messages/${msg.messageId}/content`, { headers });
      if (!contentRes.ok) continue;
      const contentData = await contentRes.json();
      const normalized = {
        from: msg.sender || msg.fromAddress || '',
        subject: msg.subject || '',
        contentType: 'text/plain',
        text: contentData.data?.content || '',
      };
      if (!looksLikeBounce(normalized)) continue;
      const info = extractBounceInfo(normalized);
      if (info) bounces.push(info);
    } catch (_) {
      // one bad candidate shouldn't abort the whole check
    }
  }
  return bounces;
}

module.exports = { buildAuthUrl, exchangeCode, refreshAccessToken, fetchAccountInfo, sendMail, checkBounces };
