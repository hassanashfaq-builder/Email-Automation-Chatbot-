const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

// A "550 classified as SPAM" during transporter.sendMail() is a *synchronous*
// rejection — the sending server refused it outright, so /api/process-one
// already marks that guest failed on the spot. A hard bounce from the
// *recipient's* server (e.g. Exchange Online rejecting the mailbox) usually
// isn't synchronous at all: mail.kianistan.com accepts and relays the
// message, then the failure comes back later as a Delivery Status
// Notification (DSN) emailed to the sending mailbox itself. There's no
// webhook for that on plain SMTP — the only way to find out is to log into
// the mailbox and read the bounce.

const FINAL_RECIPIENT_RE = /Final-Recipient:\s*rfc822;\s*<?([^\s<>]+)>?/i;
const ORIGINAL_RECIPIENT_RE = /Original-Recipient:\s*rfc822;\s*<?([^\s<>]+)>?/i;
// Fallback for providers (e.g. GoDaddy/SecureServer) that send a human-readable
// DSN body instead of (or alongside) the machine-readable RFC 3464 part:
// "Delivery to the following recipients failed permanently:\n\n   * a@b.com"
const RECIPIENTS_LIST_RE = /recipients?\s+failed[^\n]*:\s*\n+\s*\*?\s*<?([^\s<>]+@[^\s<>]+)>?/i;
const DIAGNOSTIC_RE = /Diagnostic-Code:\s*(?:smtp;)?\s*([^\n]+)/i;
const REASON_LINE_RE = /^Reason:\s*(.+)$/im;

function looksLikeBounce(parsed) {
  const from = (parsed.from?.text || '').toLowerCase();
  const subject = (parsed.subject || '').toLowerCase();
  const contentType = String(parsed.headers?.get('content-type') || '').toLowerCase();
  if (/mailer-daemon|postmaster|mail delivery (system|subsystem)/.test(from)) return true;
  if (contentType.includes('multipart/report')) return true;
  if (/undeliver|delivery status notification|delivery (has )?failed|returned mail|failure notice|delivery incomplete/.test(subject)) return true;
  return false;
}

function extractBounceInfo(parsed) {
  let blob = parsed.text || '';
  for (const att of parsed.attachments || []) {
    if (att.contentType === 'message/delivery-status' || att.contentType === 'text/rfc822-headers') {
      blob += '\n' + att.content.toString('utf8');
    }
  }

  const recipientMatch = blob.match(FINAL_RECIPIENT_RE) || blob.match(ORIGINAL_RECIPIENT_RE) || blob.match(RECIPIENTS_LIST_RE);
  if (!recipientMatch) return null;

  const diagMatch = blob.match(DIAGNOSTIC_RE);
  const reasonMatch = blob.match(REASON_LINE_RE);
  const reason = (diagMatch ? diagMatch[1] : reasonMatch ? reasonMatch[1] : 'Delivery failed permanently (bounce received)').trim();

  return { email: recipientMatch[1].toLowerCase(), reason };
}

// Scans unseen INBOX messages for bounce notifications and returns what it
// found. Matched messages are flagged \Seen so a repeat check doesn't re-read
// them — the guest list (updated by the caller) is what actually records the
// failure, the mailbox is just where the signal comes from.
async function findBounces({ host, port, secure, user, pass, since }) {
  if (!host || !user || !pass) return [];

  const client = new ImapFlow({ host, port, secure, auth: { user, pass }, logger: false });
  const bounces = [];

  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Bounded by `since` (typically the earliest guest send date) so a
      // mailbox that already has years of unrelated unread mail doesn't get
      // fully re-scanned on every check.
      const searchCriteria = since ? { seen: false, since } : { seen: false };
      const uids = await client.search(searchCriteria, { uid: true });
      for (const uid of uids || []) {
        const msg = await client.fetchOne(uid, { source: true }, { uid: true });
        if (!msg?.source) continue;
        const parsed = await simpleParser(msg.source);
        if (!looksLikeBounce(parsed)) continue;
        const info = extractBounceInfo(parsed);
        if (info) bounces.push({ ...info, uid });
      }
      if (bounces.length) {
        await client.messageFlagsAdd(bounces.map((b) => b.uid), ['\\Seen'], { uid: true });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }

  return bounces;
}

module.exports = { findBounces, looksLikeBounce, extractBounceInfo };
