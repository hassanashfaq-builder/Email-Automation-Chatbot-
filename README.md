# Kianistan Podcast — Invitation Mailer

## One-time setup
1. Install Node.js from https://nodejs.org (LTS version) if you don't have it.
2. Open this folder in Cursor (or any terminal).
3. Run:
   npm install
4. Copy config.example.json to config.json and fill in your real SMTP details
   — this becomes the "shared account" every user can choose from during
   onboarding (see "Accounts" below).

### Env vars (required once deployed with MongoDB)
Local dev (no `MONGODB_URI`) falls back to insecure defaults automatically —
nothing else to set. Once `MONGODB_URI` is configured (a real deployment),
these are required and the app refuses to boot without them:
- `SESSION_SECRET` — signs login sessions.
- `ENCRYPTION_KEY` — encrypts custom mailer passwords/OAuth tokens at rest.
- `ALLOWED_SIGNUP_EMAILS` (optional) — comma-separated list of emails allowed
  to create an account. Signup is open to anyone if this is unset.

Only needed if you want to offer "Connect with Google"/"Connect with Zoho"
during onboarding (see "Connecting Google or Zoho" below) — the app runs
fine without these, those two buttons will just fail to configure:
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
- `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET`

## Running it
Run:
   npm start

Then open http://localhost:3344 in your browser. Keep the terminal window open
while you use it.

## Accounts
Each person who opens the app gets their own name + email + password, their
own guest list and templates, and picks their own mailer:
- **Use the shared account** — only offered to the identity `SMTP_USER`
  belongs to; sends through whatever's in `config.json`, no extra setup.
- **Connect with Google** — signs in with Gmail, no password ever entered.
- **Connect with Zoho Mail** — signs in with Zoho, including free-tier
  accounts (which have no SMTP/IMAP access at all — this is the only way
  those work with this app).
- **Connect your own email (SMTP/IMAP)** — for any other provider, verified
  live before it's saved (so a typo or wrong password is caught immediately,
  not on the first real send).

If `ALLOWED_SIGNUP_EMAILS` is set, only those emails can sign up — otherwise
anyone can. Change mailer accounts later from the Settings nav item. The
very first person to sign up with the shared account's own email inherits
any guest/template data that existed before accounts did.

## Connecting Google or Zoho (admin, one-time)
"Connect with Google"/"Connect with Zoho" only work once you've registered
an OAuth app with each provider and set its Client ID/Secret as env vars —
this is a one-time setup step for whoever runs the deployment, not something
each end user does.

**Google** (console.cloud.google.com):
1. Create a project → APIs & Services → OAuth consent screen. User type
   "External." You can leave it in "Testing" and manually add each Gmail
   user's address as a test user, or click "Publish App" to open it to
   anyone (this may show a one-time "Google hasn't verified this app"
   click-through per new user unless you complete Google's verification —
   free, but not required for a small/personal-use deployment).
2. APIs & Services → Credentials → Create Credentials → OAuth client ID →
   application type **Web application**. Add this exact authorized redirect
   URI: `{your deployed URL}/api/oauth/google/callback`.
3. Copy the resulting Client ID/Secret into `GOOGLE_CLIENT_ID`/
   `GOOGLE_CLIENT_SECRET`.

**Zoho** (api-console.zoho.com):
1. Add Client → **Server-based Applications**.
2. Set the Authorized Redirect URI to
   `{your deployed URL}/api/oauth/zoho/callback`.
3. Copy the resulting Client ID/Secret into `ZOHO_CLIENT_ID`/
   `ZOHO_CLIENT_SECRET`.

`{your deployed URL}` must exactly match `BASE_URL`/what you registered —
if you change domains later, update the redirect URI in both places.

## Using the app
1. Paste your guest list (works directly from a spreadsheet copy-paste, or the
   Name | Email | Background format) or upload a CSV.
2. On the Templates tab, add or edit an email template. Use [Full Name],
   [Background], [Topic], or [Email] anywhere in the subject/body to have
   guest data inserted automatically.
3. Back on the Guests tab, check the box next to whoever you want to email,
   pick a template, and click "Send". You'll see a live status per guest and
   a toast when it's done.
4. Click "Preview" on any guest to read the email after it's sent.
5. Already-sent guests are marked ✓ Sent and unchecked automatically so you
   won't accidentally double-send.
6. The Email Stats tab shows delivered / opened / not-delivered counts, each
   expandable to the guest list behind it. Click "Sync now" to also check the
   sending mailbox for bounce notifications — a hard bounce from the
   recipient's side (e.g. their server rejecting the mailbox) arrives
   asynchronously, sometimes hours after the send looked successful, so this
   is what moves a guest from "delivered" to "failed" once the real outcome
   is known. Uses the same mailbox login as sending (IMAP), so no extra setup
   beyond what's already in config.json — override with imapHost/imapPort/
   imapSecure (or IMAP_HOST/IMAP_PORT/IMAP_SECURE) only if bounces should be
   read from a different mailbox/host than SMTP.

## Files
- config.json        SMTP credentials for the shared account (keep this
                      private, not committed)
- config.example.json  Template to copy from
- server.js           Local web server
- lib/auth.js          Password hashing, login sessions, the auth-required
                        middleware
- lib/crypto.js        Encrypts/decrypts custom mailer passwords + OAuth
                        tokens at rest
- lib/db.js            Guest/template/user storage (MongoDB if MONGODB_URI is
                        set, otherwise local JSON files) — guests and
                        templates are scoped per account
- lib/bounces.js        Reads bounce notifications back out of a mailbox
                        (IMAP, password or OAuth access token)
- lib/mailer-providers/ OAuth (Google, Zoho): auth URLs, token exchange/
                        refresh, and — for Zoho, which has no SMTP/IMAP at
                        all — sending and bounce-checking via its REST API
- lib/templates.js     Template variable detection + substitution
- public/index.html    The UI, including the onboarding/account flow
- guests.json          Guest lists + email bodies + send status, all
                        accounts (local dev only; auto-created/updated)
- templates.json       Saved templates, all accounts (local dev only)
- users.json           Accounts + (encrypted) custom mailer credentials
                        (local dev only; never committed)
- send.js              Optional command-line sender (npm run send-cli -- --dry-run)
