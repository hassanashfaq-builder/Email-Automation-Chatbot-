const express = require('express');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns');
const {
  loadGuests, saveGuests, loadGuestByIdUnscoped, updateGuestByIdUnscoped,
  loadTemplates, saveTemplates,
  findUserByEmail, findUserById, createUser, updateUser, claimUnownedData,
} = require('./lib/db');
const { fillTemplate } = require('./lib/templates');
const { findBounces } = require('./lib/bounces');
const {
  hashPassword, verifyPassword, signSession, verifySession, readSessionCookie,
  setSessionCookie, clearSessionCookie, authRequired,
} = require('./lib/auth');
const { encrypt, decrypt } = require('./lib/crypto');

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
// The one pre-existing, already-configured mailer account — offered to every
// user during onboarding as the "use the shared account" option, unchanged
// from how the whole app worked before multi-user accounts existed.
const presetConfig = loadConfig();
const baseUrl = presetConfig.baseUrl || 'http://localhost:3344';
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
const openTrackingEnabled = !onSharedVercelDomain && (presetConfig.enableOpenTracking === true || presetConfig.enableOpenTracking === 'true');
// Cookies only need Secure once this is actually served over https — same
// signal already used above for the vercel.app tracking-pixel guard.
const cookieSecure = !baseUrl.includes('localhost');

// Who's allowed to create an account at all — the admin (whoever controls
// the deployment's env vars) grants access to teammates by adding their
// email here. Defaults to just the pre-existing preset account's email, so
// a fresh deployment always has at least one usable account without extra
// config, and that email signing up is what claims any pre-existing
// (per-owner-unscoped) guest/template data — see /api/auth/signup below.
const ALLOWED_SIGNUP_EMAILS = (process.env.ALLOWED_SIGNUP_EMAILS || presetConfig.auth.user || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

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

// Every user sends through either the shared preset mailer or their own
// verified SMTP/IMAP credentials — this is the one place that decides which,
// so every route below just asks for "this user's mailer config" instead of
// duplicating the branch.
function resolveMailerConfig(user) {
  if (user && user.mailerType === 'custom' && user.mailer) {
    const m = user.mailer;
    return {
      host: m.host,
      port: m.port,
      secure: m.secure,
      auth: { user: m.user, pass: decrypt(m.passEncrypted) },
      fromName: m.fromName,
      imapHost: m.imapHost || m.host,
      imapPort: m.imapPort || 993,
      imapSecure: m.imapSecure !== false,
    };
  }
  return presetConfig;
}

function getTransporter(mailerConfig) {
  return nodemailer.createTransport({
    host: mailerConfig.host,
    port: mailerConfig.port,
    secure: mailerConfig.secure,
    auth: mailerConfig.auth,
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

// ---- auth ----

function publicUser(user) {
  // The shared mailer account is only offered to the one identity it
  // actually belongs to — presetFromEmail is only included at all when this
  // user is that identity, so the address isn't exposed to anyone else.
  const canUsePreset = user.email === (presetConfig.auth.user || '').toLowerCase();
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    mailerType: user.mailerType,
    canUsePreset,
    presetFromEmail: canUsePreset ? presetConfig.auth.user : null,
  };
}

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'A valid email is required' });
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const normalizedEmail = email.trim().toLowerCase();
    if (!ALLOWED_SIGNUP_EMAILS.includes(normalizedEmail)) {
      return res.status(403).json({ error: "This email isn't authorized to create an account — ask the admin to add it." });
    }
    if (await findUserByEmail(normalizedEmail)) {
      return res.status(400).json({ error: 'An account with that email already exists' });
    }

    const user = {
      id: crypto.randomUUID(),
      name: name.trim(),
      email: normalizedEmail,
      passwordHash: hashPassword(password),
      mailerType: null,
      createdAt: new Date().toISOString(),
    };
    await createUser(user);

    // The one email that matches the pre-existing shared mailer account
    // inherits whatever guest/template data was created before per-user
    // accounts existed, instead of leaving it permanently orphaned. Safe
    // because only allow-listed emails can sign up at all.
    if (normalizedEmail === (presetConfig.auth.user || '').toLowerCase()) {
      await claimUnownedData(user.id);
    }

    setSessionCookie(res, signSession(user.id), cookieSecure);
    res.json(publicUser(user));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    const user = await findUserByEmail(email.trim().toLowerCase());
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: 'Incorrect email or password' });
    }
    setSessionCookie(res, signSession(user.id), cookieSecure);
    res.json(publicUser(user));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(res, cookieSecure);
  res.json({ ok: true });
});

// Always 200 (never 401) — this is the boot-time check the frontend uses to
// decide which screen to show, so it shouldn't need special-case error
// handling for "not logged in," which is an expected, common response here.
app.get('/api/auth/me', async (req, res) => {
  const token = readSessionCookie(req);
  if (!token) return res.json({ authenticated: false });
  try {
    const user = await findUserById(verifySession(token));
    if (!user) return res.json({ authenticated: false });
    res.json({
      authenticated: true,
      ...publicUser(user),
      fromEmail: resolveMailerConfig(user).auth.user,
    });
  } catch (_) {
    res.json({ authenticated: false });
  }
});

app.post('/api/auth/mailer/preset', authRequired, async (req, res) => {
  // Enforced here, not just hidden in the UI — the shared account is only
  // for the one identity it actually belongs to.
  const user = await findUserById(req.userId);
  if (!user || user.email !== (presetConfig.auth.user || '').toLowerCase()) {
    return res.status(403).json({ error: 'The shared account is not available for this login' });
  }
  await updateUser(req.userId, { mailerType: 'preset' });
  res.json({ ok: true, mailerType: 'preset' });
});

app.post('/api/auth/mailer/custom', authRequired, async (req, res) => {
  const { host, port, secure, user, pass, fromName, imapHost, imapPort, imapSecure } = req.body;
  if (!host || !port || !user || !pass) {
    return res.status(400).json({ error: 'Host, port, email, and password are required' });
  }

  const transporter = nodemailer.createTransport({
    host, port: parseInt(port, 10), secure: secure !== false, auth: { user, pass },
  });
  try {
    await transporter.verify();
  } catch (err) {
    return res.status(400).json({ error: `Could not connect: ${err.message}` });
  }

  await updateUser(req.userId, {
    mailerType: 'custom',
    mailer: {
      host,
      port: parseInt(port, 10),
      secure: secure !== false,
      user,
      passEncrypted: encrypt(pass),
      fromName: (fromName || '').trim() || user,
      imapHost: (imapHost || '').trim() || host,
      imapPort: imapPort ? parseInt(imapPort, 10) : 993,
      imapSecure: imapSecure !== false,
    },
  });
  res.json({ ok: true, mailerType: 'custom' });
});

app.get('/api/config', authRequired, async (req, res) => {
  const mailerConfig = resolveMailerConfig(await findUserById(req.userId));
  res.json({
    fromEmail: mailerConfig.auth.user,
    openTrackingEnabled,
    openTrackingBlockedReason: onSharedVercelDomain ? 'BASE_URL is a *.vercel.app domain — set a custom domain to enable tracking' : null,
  });
});

app.get('/api/guests', authRequired, async (req, res) => res.json(await loadGuests(req.userId)));

// Import guests (from paste or CSV upload). Merges by email — updates existing, adds new.
app.post('/api/guests/import', authRequired, async (req, res) => {
  const incoming = req.body.guests || [];
  const existing = await loadGuests(req.userId);
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
  await saveGuests(req.userId, merged);
  res.json(merged);
});

// Edit a guest's name/email/background by id (rather than by email, since
// email itself — the merge key used elsewhere — may be what's being changed).
app.put('/api/guests/:id', authRequired, async (req, res) => {
  const { name, email, background } = req.body;
  if (!email || !email.trim()) return res.status(400).json({ error: 'Email is required' });

  const guests = await loadGuests(req.userId);
  const idx = guests.findIndex(g => g.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Guest not found' });

  const newEmail = email.trim();
  const collision = guests.find(g => g.id !== req.params.id && g.email.toLowerCase() === newEmail.toLowerCase());
  if (collision) return res.status(400).json({ error: 'Another guest already has that email' });

  guests[idx].email = newEmail;
  guests[idx].name = (name || '').trim() || newEmail.split('@')[0];
  guests[idx].background = (background || '').trim();
  await saveGuests(req.userId, guests);
  res.json(guests[idx]);
});

app.delete('/api/guests/:email', authRequired, async (req, res) => {
  const guests = (await loadGuests(req.userId)).filter(g => g.email.toLowerCase() !== req.params.email.toLowerCase());
  await saveGuests(req.userId, guests);
  res.json(guests);
});

// Bulk delete — either a specific set of emails, or every guest when `all` is set.
app.post('/api/guests/delete-bulk', authRequired, async (req, res) => {
  const { emails, all } = req.body;
  if (all) {
    await saveGuests(req.userId, []);
    return res.json([]);
  }
  const toRemove = new Set((emails || []).map(e => e.toLowerCase()));
  const guests = (await loadGuests(req.userId)).filter(g => !toRemove.has(g.email.toLowerCase()));
  await saveGuests(req.userId, guests);
  res.json(guests);
});

app.get('/api/templates', authRequired, async (req, res) => res.json(await loadTemplates(req.userId)));

app.post('/api/templates', authRequired, async (req, res) => {
  const { name, subject, body } = req.body;
  if (!name || !subject || !body) {
    return res.status(400).json({ error: 'name, subject, and body are all required' });
  }
  const templates = await loadTemplates(req.userId);
  const template = {
    id: crypto.randomUUID(),
    name: name.trim(),
    subject: subject.trim(),
    body,
    createdAt: new Date().toISOString(),
  };
  templates.push(template);
  await saveTemplates(req.userId, templates);
  res.json(template);
});

app.put('/api/templates/:id', authRequired, async (req, res) => {
  const { name, subject, body } = req.body;
  const templates = await loadTemplates(req.userId);
  const idx = templates.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Template not found' });
  templates[idx] = {
    ...templates[idx],
    name: name?.trim() ?? templates[idx].name,
    subject: subject?.trim() ?? templates[idx].subject,
    body: body ?? templates[idx].body,
    updatedAt: new Date().toISOString(),
  };
  await saveTemplates(req.userId, templates);
  res.json(templates[idx]);
});

app.delete('/api/templates/:id', authRequired, async (req, res) => {
  const templates = (await loadTemplates(req.userId)).filter(t => t.id !== req.params.id);
  await saveTemplates(req.userId, templates);
  res.json(templates);
});

// Open-tracking pixel — embedded 1x1 image in each sent email. Served at
// /api/e/ (not /api/track/) because some spam filters keyword-scan URLs for
// "track"/"pixel"/"beacon"; /api/track/ is kept as an alias so pixels already
// out in previously-sent emails keep working. Hit anonymously by the
// recipient's mail client — no session/owner here, only the guest's
// already-globally-unique id, so this uses the unscoped lookup helpers.
async function servePixel(req, res) {
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.end(TRACKING_PIXEL);

  try {
    const guest = await loadGuestByIdUnscoped(req.params.id);
    if (guest) {
      const patch = { openCount: (guest.openCount || 0) + 1 };
      if (!guest.opened) {
        patch.opened = true;
        patch.openedAt = new Date().toISOString();
      }
      await updateGuestByIdUnscoped(req.params.id, patch);
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

app.get('/api/stats', authRequired, async (req, res) => {
  const guests = await loadGuests(req.userId);
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
app.post('/api/check-bounces', authRequired, async (req, res) => {
  try {
    const mailerConfig = resolveMailerConfig(await findUserById(req.userId));
    const guests = await loadGuests(req.userId);
    const sentDates = guests.map(g => g.sentAt && new Date(g.sentAt).getTime()).filter(n => n && !Number.isNaN(n));
    const since = sentDates.length ? new Date(Math.min(...sentDates)) : undefined;

    const bounces = await findBounces({
      host: mailerConfig.imapHost,
      port: mailerConfig.imapPort,
      secure: mailerConfig.imapSecure,
      user: mailerConfig.auth.user,
      pass: mailerConfig.auth.pass,
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
    if (matched) await saveGuests(req.userId, guests);

    res.json({ ok: true, checked: bounces.length, matched });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Generate + send for a single guest. One guest per request (rather than one
// long-lived SSE stream for the whole batch) so each call finishes well
// within a serverless function's execution time limit — the client drives
// the batch by calling this once per selected guest.
app.post('/api/process-one', authRequired, async (req, res) => {
  const { email, templateId } = req.body;
  const mailerConfig = resolveMailerConfig(await findUserById(req.userId));

  const guests = await loadGuests(req.userId);
  const guest = guests.find(g => g.email === email);
  if (!guest) return res.status(404).json({ ok: false, error: 'Guest not found' });

  const templates = await loadTemplates(req.userId);
  const template = templates.find(t => t.id === templateId);
  if (!template) return res.status(400).json({ ok: false, error: 'Template not found' });

  const fail = async (message) => {
    const all = await loadGuests(req.userId);
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
      await saveGuests(req.userId, all);
    }
    return res.json({ ok: false, error: message });
  };

  try {
    // guests created before tracking support may not have an id yet
    if (!guest.id) {
      guest.id = crypto.randomUUID();
      const withId = await loadGuests(req.userId);
      const i = withId.findIndex(g => g.email === email);
      if (i !== -1) { withId[i].id = guest.id; await saveGuests(req.userId, withId); }
    }

    if (!EMAIL_RE.test(guest.email)) {
      return fail('Invalid email address format');
    }
    if (!(await domainHasMailServer(guest.email))) {
      return fail(`"${guest.email.split('@')[1]}" has no mail server (MX/A record) — address can't receive email`);
    }

    const transporter = getTransporter(mailerConfig);
    try {
      await transporter.verify();
    } catch (err) {
      return fail(`SMTP connection failed: ${err.message}`);
    }

    const subject = fillTemplate(template.subject, guest);
    const body = fillTemplate(template.body, guest);

    const withBody = await loadGuests(req.userId);
    const bodyIdx = withBody.findIndex(g => g.email === email);
    if (bodyIdx !== -1) { withBody[bodyIdx].body = body; await saveGuests(req.userId, withBody); }

    // No style="display:none" — an explicitly hidden element is a stronger
    // spam-filter signal than a merely 1x1 image (which is invisible anyway
    // purely by virtue of its size, the same way legitimate ESPs do it).
    const trackingPixel = openTrackingEnabled
      ? `<img src="${baseUrl}/api/e/${guest.id}.png" width="1" height="1" alt="">`
      : '';
    const html = textToHtml(body) + trackingPixel;
    // Message-ID/List-Unsubscribe/Reply-To are set explicitly because a
    // cPanel-style sending host commonly runs outbound SpamAssassin scoring
    // and rejects the SMTP transaction itself — same "550 classified as
    // SPAM" text regardless of recipient domain — when these are
    // missing/generic. nodemailer's default Message-ID uses the local
    // machine/container hostname, which doesn't match the sending domain
    // and scores as suspicious.
    const senderDomain = mailerConfig.auth.user.split('@')[1];
    await sendMailWithRetry(transporter, {
      from: `"${mailerConfig.fromName}" <${mailerConfig.auth.user}>`,
      to: guest.email,
      replyTo: mailerConfig.auth.user,
      subject,
      text: body,
      html,
      messageId: `<${crypto.randomUUID()}@${senderDomain}>`,
      headers: {
        'List-Unsubscribe': `<mailto:${mailerConfig.auth.user}?subject=unsubscribe>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });

    const all2 = await loadGuests(req.userId);
    const idx2 = all2.findIndex(g => g.email === email);
    if (idx2 !== -1) {
      all2[idx2].sent = true;
      all2[idx2].sentAt = new Date().toISOString();
      all2[idx2].failed = false;
      all2[idx2].error = null;
      all2[idx2].templateId = template.id;
      all2[idx2].templateName = template.name;
      await saveGuests(req.userId, all2);
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
