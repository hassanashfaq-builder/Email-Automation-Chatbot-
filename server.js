const express = require('express');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { generateInvitation } = require('./lib/generate');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const guestsPath = path.join(__dirname, 'guests.json');
const baseUrl = config.baseUrl || 'http://localhost:3344';

// 1x1 transparent PNG used as the open-tracking pixel
const TRACKING_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function loadGuests() {
  if (!fs.existsSync(guestsPath)) return [];
  return JSON.parse(fs.readFileSync(guestsPath, 'utf8'));
}
function saveGuests(guests) {
  fs.writeFileSync(guestsPath, JSON.stringify(guests, null, 2));
}
function textToHtml(text) {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const withLinks = escaped.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
  return `<div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #111;">${withLinks.split('\n').map(l => l || '&nbsp;').join('<br>\n')}</div>`;
}
function getTransporter() {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.auth,
  });
}

app.get('/api/guests', (req, res) => res.json(loadGuests()));

// Import guests (from paste or CSV upload). Merges by email — updates existing, adds new.
app.post('/api/guests/import', (req, res) => {
  const incoming = req.body.guests || [];
  const existing = loadGuests();
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
  saveGuests(merged);
  res.json(merged);
});

app.delete('/api/guests/:email', (req, res) => {
  const guests = loadGuests().filter(g => g.email.toLowerCase() !== req.params.email.toLowerCase());
  saveGuests(guests);
  res.json(guests);
});

// Open-tracking pixel — embedded 1x1 image in each sent email
app.get('/api/track/:id.png', (req, res) => {
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.end(TRACKING_PIXEL);

  const guests = loadGuests();
  const idx = guests.findIndex(g => g.id === req.params.id);
  if (idx !== -1) {
    if (!guests[idx].opened) {
      guests[idx].opened = true;
      guests[idx].openedAt = new Date().toISOString();
    }
    guests[idx].openCount = (guests[idx].openCount || 0) + 1;
    saveGuests(guests);
  }
});

app.get('/api/stats', (req, res) => {
  const guests = loadGuests();
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

// Generate + send for the selected guests, streaming progress via SSE
app.post('/api/process', async (req, res) => {
  const { emails } = req.body;
  const guests = loadGuests();
  const targets = guests.filter(g => emails.includes(g.email));

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  const transporter = getTransporter();
  try {
    await transporter.verify();
  } catch (err) {
    send({ type: 'fatal', error: `SMTP connection failed: ${err.message}` });
    return res.end();
  }

  for (const guest of targets) {
    try {
      // guests created before tracking support may not have an id yet
      if (!guest.id) {
        guest.id = crypto.randomUUID();
        const withId = loadGuests();
        const i = withId.findIndex(g => g.email === guest.email);
        if (i !== -1) { withId[i].id = guest.id; saveGuests(withId); }
      }

      send({ type: 'status', email: guest.email, name: guest.name, stage: 'generating' });
      const body = await generateInvitation(guest, config);

      // persist generated body immediately
      const all = loadGuests();
      const idx = all.findIndex(g => g.email === guest.email);
      if (idx !== -1) { all[idx].body = body; saveGuests(all); }

      send({ type: 'status', email: guest.email, name: guest.name, stage: 'sending' });
      const html = textToHtml(body) + `<img src="${baseUrl}/api/track/${guest.id}.png" width="1" height="1" alt="" style="display:none">`;
      await transporter.sendMail({
        from: `"${config.fromName}" <${config.auth.user}>`,
        to: guest.email,
        subject: config.subject,
        text: body,
        html,
      });

      const all2 = loadGuests();
      const idx2 = all2.findIndex(g => g.email === guest.email);
      if (idx2 !== -1) {
        all2[idx2].sent = true;
        all2[idx2].sentAt = new Date().toISOString();
        all2[idx2].failed = false;
        all2[idx2].error = null;
        saveGuests(all2);
      }

      send({ type: 'status', email: guest.email, name: guest.name, stage: 'done' });
    } catch (err) {
      const all3 = loadGuests();
      const idx3 = all3.findIndex(g => g.email === guest.email);
      if (idx3 !== -1) {
        all3[idx3].failed = true;
        all3[idx3].failedAt = new Date().toISOString();
        all3[idx3].error = err.message;
        saveGuests(all3);
      }
      send({ type: 'status', email: guest.email, name: guest.name, stage: 'error', error: err.message });
    }
    await new Promise(r => setTimeout(r, 1500)); // throttle between guests
  }

  send({ type: 'complete' });
  res.end();
});

const PORT = 3344;
app.listen(PORT, () => {
  console.log(`\nKianistan Podcast mailer running.\nOpen this in your browser: http://localhost:${PORT}\n`);
});
