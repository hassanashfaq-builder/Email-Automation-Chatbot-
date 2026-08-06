const express = require('express');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns');
const { generateInvitation } = require('./lib/generate');
const { loadGuests, saveGuests } = require('./lib/db');

function loadConfig() {
  const configPath = path.join(__dirname, 'config.json');
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
  // no config.json in this environment (e.g. Render) — build from env vars instead
  return {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '465', 10),
    secure: process.env.SMTP_SECURE !== 'false',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    fromName: process.env.FROM_NAME,
    subject: process.env.EMAIL_SUBJECT,
    geminiApiKey: process.env.GEMINI_API_KEY,
    geminiModel: process.env.GEMINI_MODEL || 'gemini-flash-latest',
    baseUrl: process.env.BASE_URL || 'http://localhost:3344',
  };
}
const config = loadConfig();
const baseUrl = config.baseUrl || 'http://localhost:3344';

// 1x1 transparent PNG used as the open-tracking pixel
const TRACKING_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

const app = express();
app.use(express.json({ limit: '5mb' }));
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

app.get('/api/guests', async (req, res) => res.json(await loadGuests()));

// Import guests (from paste or CSV upload). Merges by email — updates existing, adds new.
app.post('/api/guests/import', async (req, res) => {
  const incoming = req.body.guests || [];
  const existing = await loadGuests();
  const byEmail = new Map(existing.map(g => [g.email.toLowerCase(), g]));

  for (const g of incoming) {
    if (!g.email || !g.name) continue;
    const key = g.email.toLowerCase();
    const prev = byEmail.get(key);
    byEmail.set(key, {
      id: prev?.id ?? crypto.randomUUID(),
      name: g.name.trim(),
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

app.delete('/api/guests/:email', async (req, res) => {
  const guests = (await loadGuests()).filter(g => g.email.toLowerCase() !== req.params.email.toLowerCase());
  await saveGuests(guests);
  res.json(guests);
});

// Open-tracking pixel — embedded 1x1 image in each sent email
app.get('/api/track/:id.png', async (req, res) => {
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
});

app.get('/api/stats', async (req, res) => {
  const guests = await loadGuests();
  const pick = (g) => ({ name: g.name, email: g.email });

  const delivered = guests.filter(g => g.sent).map(g => ({ ...pick(g), sentAt: g.sentAt }));
  const notDelivered = guests.filter(g => g.failed).map(g => ({ ...pick(g), failedAt: g.failedAt, error: g.error }));
  const opened = guests.filter(g => g.opened).map(g => ({ ...pick(g), openedAt: g.openedAt, openCount: g.openCount || 0 }));

  res.json({
    totals: {
      total: guests.length,
      delivered: delivered.length,
      notDelivered: notDelivered.length,
      opened: opened.length,
    },
    delivered,
    notDelivered,
    opened,
  });
});

// Generate + send for a single guest. One guest per request (rather than one
// long-lived SSE stream for the whole batch) so each call finishes well
// within a serverless function's execution time limit — the client drives
// the batch by calling this once per selected guest.
app.post('/api/process-one', async (req, res) => {
  const { email } = req.body;
  const guests = await loadGuests();
  const guest = guests.find(g => g.email === email);
  if (!guest) return res.status(404).json({ ok: false, error: 'Guest not found' });

  const fail = async (message) => {
    const all = await loadGuests();
    const idx = all.findIndex(g => g.email === email);
    if (idx !== -1) {
      all[idx].sent = false;
      all[idx].failed = true;
      all[idx].failedAt = new Date().toISOString();
      all[idx].error = message;
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

    const body = await generateInvitation(guest, config);

    const withBody = await loadGuests();
    const bodyIdx = withBody.findIndex(g => g.email === email);
    if (bodyIdx !== -1) { withBody[bodyIdx].body = body; await saveGuests(withBody); }

    const html = textToHtml(body) + `<img src="${baseUrl}/api/track/${guest.id}.png" width="1" height="1" alt="" style="display:none">`;
    await sendMailWithRetry(transporter, {
      from: `"${config.fromName}" <${config.auth.user}>`,
      to: guest.email,
      subject: config.subject,
      text: body,
      html,
    });

    const all2 = await loadGuests();
    const idx2 = all2.findIndex(g => g.email === email);
    if (idx2 !== -1) {
      all2[idx2].sent = true;
      all2[idx2].sentAt = new Date().toISOString();
      all2[idx2].failed = false;
      all2[idx2].error = null;
      await saveGuests(all2);
    }

    res.json({ ok: true });
  } catch (err) {
    fail(err.message);
  }
});

if (require.main === module) {
  const PORT = process.env.PORT || 3344;
  app.listen(PORT, () => {
    console.log(`\nKianistan Podcast mailer running.\nOpen this in your browser: http://localhost:${PORT}\n`);
  });
}

module.exports = app;
