const express = require('express');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns');
const { loadGuests, saveGuests, loadTemplates, saveTemplates } = require('./lib/db');
const { fillTemplate } = require('./lib/templates');
const { findBounces } = require('./lib/bounces');

function loadConfig() {
  const configPath = path.join(__dirname, 'config.json');
  if (fs.existsSync(configPath)) {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    // IMAP is only used to read bounce notifications back out of the same
    // mailbox that sends — cPanel-style hosts almost always run both on the
    // same hostname, just different ports, so default there instead of
    // requiring a second host to be configured.
    return {
      ...parsed,
      imapHost: parsed.imapHost || parsed.host,
      imapPort: parsed.imapPort || 993,
      imapSecure: parsed.imapSecure !== false,
    };
  }
  // no config.json in this environment (e.g. Render) — build from env vars instead
  return {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '465', 10),
    secure: process.env.SMTP_SECURE !== 'false',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    fromName: process.env.FROM_NAME,
    baseUrl: process.env.BASE_URL || 'http://localhost:3344',
    enableOpenTracking: process.env.ENABLE_OPEN_TRACKING === 'true',
    imapHost: process.env.IMAP_HOST || process.env.SMTP_HOST,
    imapPort: parseInt(process.env.IMAP_PORT || '993', 10),
    imapSecure: process.env.IMAP_SECURE !== 'false',
  };
}
const config = loadConfig();
const baseUrl = config.baseUrl || 'http://localhost:3344';
const baseUrlHost = (() => { try { return new URL(baseUrl).hostname; } catch (_) { return ''; } })();
// *.vercel.app is Vercel's shared preview/prod domain — because it's free,
// instant, and used by countless throwaway/phishing sites, many outbound
// spam scanners (including whatever's rejecting these as 550 SPAM) flag
// links/images pointing at it on sight, independent of how the <img> tag
// itself looks. Confirmed by this exact 550 recurring the moment tracking
// (which points the pixel at this deployment's *.vercel.app URL) was
// re-enabled. So: force tracking off while BASE_URL is still a vercel.app
// host, regardless of ENABLE_OPEN_TRACKING — a real fix needs a custom
// domain (e.g. a kianistan.com subdomain) pointed at this deployment via
// Vercel's Domains settings, with BASE_URL updated to match.
const onSharedVercelDomain = /(^|\.)vercel\.app$/i.test(baseUrlHost);
const openTrackingEnabled = !onSharedVercelDomain && (config.enableOpenTracking === true || config.enableOpenTracking === 'true');

// 1x1 transparent PNG used as the open-tracking pixel
const TRACKING_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

const app = express();
app.use(express.json({ limit: '5mb' }));
// Dynamic JSON data — without this, browsers/proxies can heuristically
// cache these GET responses (no Cache-Control/Last-Modified to say
// otherwise), which is why "Sync" could keep showing stale counts until
// enough time passed for that heuristic cache to expire on its own.
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

function textToHtml(text) {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const withLinks = escaped.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
  return `<div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #111;">${withLinks.split('\n').map(l => l || '&nbsp;').join('<br>\n')}</div>`;
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Recipient domain must have a mail server (MX, or A/AAAA as an implicit-MX
// fallback per RFC 5321) — catches typo'd/nonexistent domains before we ever
// attempt to send, instead of finding out only from an async bounce email.
async function domainHasMailServer(email) {
  const domain = email.split('@')[1];
  if (!domain) return false;
  try {
    const mx = await dns.promises.resolveMx(domain);
    if (mx && mx.length) return true;
  } catch (_) {
    // resolveMx does raw DNS queries that some networks block outright
    // (unrelated to whether the domain is real) — fall back to the OS
    // resolver below rather than treating this as "domain doesn't exist".
  }
  try {
    await dns.promises.lookup(domain);
    return true;
  } catch (_) {}
  return false;
}

function getTransporter() {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.auth,
  });
}

// SMTP 4xx codes (and connection-level errors) are temporary — worth a
// short retry. A 5xx like "550 classified as SPAM" is the server's
// permanent judgment on that exact message; retrying identical content
// immediately will just get rejected again, so those fail immediately.
function isRetryableSmtpError(err) {
  if (err.responseCode) return err.responseCode >= 400 && err.responseCode < 500;
  return ['ETIMEDOUT', 'ECONNRESET', 'ESOCKET', 'ECONNECTION'].includes(err.code);
}

async function sendMailWithRetry(transporter, mail, attempts = 2) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await transporter.sendMail(mail);
    } catch (err) {
      if (attempt === attempts || !isRetryableSmtpError(err)) throw err;
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
}

app.get('/api/config', (req, res) => res.json({
  fromEmail: config.auth.user,
  openTrackingEnabled,
  openTrackingBlockedReason: onSharedVercelDomain ? 'BASE_URL is a *.vercel.app domain — set a custom domain to enable tracking' : null,
}));

app.get('/api/guests', async (req, res) => res.json(await loadGuests()));

// Import guests (from paste or CSV upload). Merges by email — updates existing, adds new.
app.post('/api/guests/import', async (req, res) => {
  const incoming = req.body.guests || [];
  const existing = await loadGuests();
  const byEmail = new Map(existing.map(g => [g.email.toLowerCase(), g]));

  for (const g of incoming) {
    if (!g.email) continue;
    const key = g.email.toLowerCase();
    const prev = byEmail.get(key);
    const name = (g.name || '').trim() || g.email.split('@')[0];
    byEmail.set(key, {
      id: prev?.id ?? crypto.randomUUID(),
      name,
      email: g.email.trim(),
      background: (g.background || '').trim(),
      topic: (g.topic || '').trim(),
      body: prev?.body ?? null,
      sent: prev?.sent ?? false,
      sentAt: prev?.sentAt ?? null,
      failed: prev?.failed ?? false,
      failedAt: prev?.failedAt ?? null,
      error: prev?.error ?? null,
      opened: prev?.opened ?? false,
      openedAt: prev?.openedAt ?? null,
      openCount: prev?.openCount ?? 0,
    });
  }

  const merged = [...byEmail.values()];
  await saveGuests(merged);
  res.json(merged);
});

// Edit a guest's name/email/background by id (rather than by email, since
// email itself — the merge key used elsewhere — may be what's being changed).
app.put('/api/guests/:id', async (req, res) => {
  const { name, email, background } = req.body;
  if (!email || !email.trim()) return res.status(400).json({ error: 'Email is required' });

  const guests = await loadGuests();
  const idx = guests.findIndex(g => g.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Guest not found' });

  const newEmail = email.trim();
  const collision = guests.find(g => g.id !== req.params.id && g.email.toLowerCase() === newEmail.toLowerCase());
  if (collision) return res.status(400).json({ error: 'Another guest already has that email' });

  guests[idx].email = newEmail;
  guests[idx].name = (name || '').trim() || newEmail.split('@')[0];
  guests[idx].background = (background || '').trim();
  await saveGuests(guests);
  res.json(guests[idx]);
});

app.delete('/api/guests/:email', async (req, res) => {
  const guests = (await loadGuests()).filter(g => g.email.toLowerCase() !== req.params.email.toLowerCase());
  await saveGuests(guests);
  res.json(guests);
});

// Bulk delete — either a specific set of emails, or every guest when `all` is set.
app.post('/api/guests/delete-bulk', async (req, res) => {
  const { emails, all } = req.body;
  if (all) {
    await saveGuests([]);
    return res.json([]);
  }
  const toRemove = new Set((emails || []).map(e => e.toLowerCase()));
  const guests = (await loadGuests()).filter(g => !toRemove.has(g.email.toLowerCase()));
  await saveGuests(guests);
  res.json(guests);
});

app.get('/api/templates', async (req, res) => res.json(await loadTemplates()));

app.post('/api/templates', async (req, res) => {
  const { name, subject, body } = req.body;
  if (!name || !subject || !body) {
    return res.status(400).json({ error: 'name, subject, and body are all required' });
  }
  const templates = await loadTemplates();
  const template = {
    id: crypto.randomUUID(),
    name: name.trim(),
    subject: subject.trim(),
    body,
    createdAt: new Date().toISOString(),
  };
  templates.push(template);
  await saveTemplates(templates);
  res.json(template);
});

app.put('/api/templates/:id', async (req, res) => {
  const { name, subject, body } = req.body;
  const templates = await loadTemplates();
  const idx = templates.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Template not found' });
  templates[idx] = {
    ...templates[idx],
    name: name?.trim() ?? templates[idx].name,
    subject: subject?.trim() ?? templates[idx].subject,
    body: body ?? templates[idx].body,
    updatedAt: new Date().toISOString(),
  };
  await saveTemplates(templates);
  res.json(templates[idx]);
});

app.delete('/api/templates/:id', async (req, res) => {
  const templates = (await loadTemplates()).filter(t => t.id !== req.params.id);
  await saveTemplates(templates);
  res.json(templates);
});

// Open-tracking pixel — embedded 1x1 image in each sent email. Served at
// /api/e/ (not /api/track/) because some spam filters keyword-scan URLs for
// "track"/"pixel"/"beacon"; /api/track/ is kept as an alias so pixels already
// out in previously-sent emails keep working.
async function servePixel(req, res) {
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.end(TRACKING_PIXEL);

  try {
    const guests = await loadGuests();
    const idx = guests.findIndex(g => g.id === req.params.id);
    if (idx !== -1) {
      if (!guests[idx].opened) {
        guests[idx].opened = true;
        guests[idx].openedAt = new Date().toISOString();
      }
      guests[idx].openCount = (guests[idx].openCount || 0) + 1;
      await saveGuests(guests);
    }
  } catch (err) {
    console.error('Failed to record open:', err.message);
  }
}
app.get('/api/e/:id.png', servePixel);
app.get('/api/track/:id.png', servePixel);

// No bounce-webhook or inbox access exists to confirm real delivery, so
// "delivered" is a heuristic: sent, not failed, and either opened or old
// enough that a bounce (which we catch synchronously as a send failure)
// would already have shown up. Keep this in sync with DELIVERED_GRACE_MS
// in public/index.html's statusInfo().
const DELIVERED_GRACE_MS = 2 * 60 * 1000;

function deliveryState(g) {
  if (g.failed) return 'failed';
  if (!g.sent) return 'pending';
  if (g.opened) return 'opened';
  const age = Date.now() - new Date(g.sentAt).getTime();
  return age >= DELIVERED_GRACE_MS ? 'delivered' : 'sent';
}

app.get('/api/stats', async (req, res) => {
  const guests = await loadGuests();
  const pick = (g) => ({ name: g.name, email: g.email });

  const sent = guests.filter(g => g.sent).map(g => ({ ...pick(g), sentAt: g.sentAt }));
  const delivered = guests.filter(g => ['delivered', 'opened'].includes(deliveryState(g))).map(g => ({ ...pick(g), sentAt: g.sentAt }));
  const opened = guests.filter(g => g.opened).map(g => ({ ...pick(g), openedAt: g.openedAt, openCount: g.openCount || 0 }));
  const notDelivered = guests.filter(g => g.failed).map(g => ({ ...pick(g), failedAt: g.failedAt, error: g.error }));

  res.json({
    totals: {
      total: guests.length,
      sent: sent.length,
      delivered: delivered.length,
      opened: opened.length,
      replied: 0,
      notDelivered: notDelivered.length,
    },
    sent,
    delivered,
    opened,
    replied: [],
    notDelivered,
  });
});

// Reads bounce (DSN) notifications out of the sending mailbox's INBOX and
// reclassifies any matching guest as failed. This is the only way to catch a
// hard bounce that happens after the SMTP transaction already succeeded —
// e.g. the receiving provider accepts the relay, then rejects the mailbox
// itself and emails the bounce back to us asynchronously, sometimes hours
// later. Guests already marked failed are left alone (idempotent re-checks).
app.post('/api/check-bounces', async (req, res) => {
  try {
    const guests = await loadGuests();
    const sentDates = guests.map(g => g.sentAt && new Date(g.sentAt).getTime()).filter(n => n && !Number.isNaN(n));
    const since = sentDates.length ? new Date(Math.min(...sentDates)) : undefined;

    const bounces = await findBounces({
      host: config.imapHost,
      port: config.imapPort,
      secure: config.imapSecure,
      user: config.auth.user,
      pass: config.auth.pass,
      since,
    });

    if (!bounces.length) return res.json({ ok: true, checked: 0, matched: 0 });

    let matched = 0;
    for (const bounce of bounces) {
      const idx = guests.findIndex(g => g.email.toLowerCase() === bounce.email && !g.failed);
      if (idx === -1) continue;
      guests[idx].sent = false;
      guests[idx].failed = true;
      guests[idx].failedAt = new Date().toISOString();
      guests[idx].error = bounce.reason;
      matched++;
    }
    if (matched) await saveGuests(guests);

    res.json({ ok: true, checked: bounces.length, matched });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Generate + send for a single guest. One guest per request (rather than one
// long-lived SSE stream for the whole batch) so each call finishes well
// within a serverless function's execution time limit — the client drives
// the batch by calling this once per selected guest.
app.post('/api/process-one', async (req, res) => {
  const { email, templateId } = req.body;
  const guests = await loadGuests();
  const guest = guests.find(g => g.email === email);
  if (!guest) return res.status(404).json({ ok: false, error: 'Guest not found' });

  const templates = await loadTemplates();
  const template = templates.find(t => t.id === templateId);
  if (!template) return res.status(400).json({ ok: false, error: 'Template not found' });

  const fail = async (message) => {
    const all = await loadGuests();
    const idx = all.findIndex(g => g.email === email);
    if (idx !== -1) {
      all[idx].sent = false;
      all[idx].failed = true;
      all[idx].failedAt = new Date().toISOString();
      all[idx].error = message;
      // record which template this attempt used even on failure — otherwise
      // a guest who's never successfully sent has no templateId at all, and
      // the Analytics template filter would silently drop them from every list
      all[idx].templateId = template.id;
      all[idx].templateName = template.name;
      await saveGuests(all);
    }
    return res.json({ ok: false, error: message });
  };

  try {
    // guests created before tracking support may not have an id yet
    if (!guest.id) {
      guest.id = crypto.randomUUID();
      const withId = await loadGuests();
      const i = withId.findIndex(g => g.email === email);
      if (i !== -1) { withId[i].id = guest.id; await saveGuests(withId); }
    }

    if (!EMAIL_RE.test(guest.email)) {
      return fail('Invalid email address format');
    }
    if (!(await domainHasMailServer(guest.email))) {
      return fail(`"${guest.email.split('@')[1]}" has no mail server (MX/A record) — address can't receive email`);
    }

    const transporter = getTransporter();
    try {
      await transporter.verify();
    } catch (err) {
      return fail(`SMTP connection failed: ${err.message}`);
    }

    const subject = fillTemplate(template.subject, guest);
    const body = fillTemplate(template.body, guest);

    const withBody = await loadGuests();
    const bodyIdx = withBody.findIndex(g => g.email === email);
    if (bodyIdx !== -1) { withBody[bodyIdx].body = body; await saveGuests(withBody); }

    // No style="display:none" — an explicitly hidden element is a stronger
    // spam-filter signal than a merely 1x1 image (which is invisible anyway
    // purely by virtue of its size, the same way legitimate ESPs do it).
    const trackingPixel = openTrackingEnabled
      ? `<img src="${baseUrl}/api/e/${guest.id}.png" width="1" height="1" alt="">`
      : '';
    const html = textToHtml(body) + trackingPixel;
    // Message-ID/List-Unsubscribe/Reply-To are set explicitly because the sending
    // host (mail.kianistan.com, a cPanel-style server) runs outbound SpamAssassin
    // scoring and rejects the SMTP transaction itself — same "550 classified as
    // SPAM" text regardless of recipient domain — when these are missing/generic.
    // nodemailer's default Message-ID uses the local machine/container hostname,
    // which doesn't match the sending domain and scores as suspicious.
    const senderDomain = config.auth.user.split('@')[1];
    await sendMailWithRetry(transporter, {
      from: `"${config.fromName}" <${config.auth.user}>`,
      to: guest.email,
      replyTo: config.auth.user,
      subject,
      text: body,
      html,
      messageId: `<${crypto.randomUUID()}@${senderDomain}>`,
      headers: {
        'List-Unsubscribe': `<mailto:${config.auth.user}?subject=unsubscribe>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });

    const all2 = await loadGuests();
    const idx2 = all2.findIndex(g => g.email === email);
    if (idx2 !== -1) {
      all2[idx2].sent = true;
      all2[idx2].sentAt = new Date().toISOString();
      all2[idx2].failed = false;
      all2[idx2].error = null;
      all2[idx2].templateId = template.id;
      all2[idx2].templateName = template.name;
      await saveGuests(all2);
    }

    res.json({ ok: true });
  } catch (err) {
    // err.response is the SMTP server's full raw reply (sometimes multi-line,
    // e.g. a spam-score breakdown) — err.message is often just a generic
    // "Message failed: <code>" summary of it, so prefer the fuller text.
    fail(err.response || err.message);
  }
});

if (require.main === module) {
  const PORT = process.env.PORT || 3344;
  app.listen(PORT, () => {
    console.log(`\nKianistan Podcast mailer running.\nOpen this in your browser: http://localhost:${PORT}\n`);
  });
}

module.exports = app;
