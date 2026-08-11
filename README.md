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
- `ENCRYPTION_KEY` — encrypts custom mailer passwords at rest.
- `ALLOWED_SIGNUP_EMAILS` (optional) — comma-separated list of emails allowed
  to create an account. Defaults to just the shared account's email
  (`SMTP_USER`), so add teammates' emails here to let them sign up.

## Running it
Run:
   npm start

Then open http://localhost:3344 in your browser. Keep the terminal window open
while you use it.

## Accounts
Each person who opens the app gets their own name + email + password, their
own guest list and templates, and picks their own mailer:
- **Use the shared account** — sends through whatever's in `config.json`, no
  extra setup.
- **Connect your own email** — SMTP + IMAP credentials, verified live before
  they're saved (so a typo or wrong password is caught immediately, not on
  the first real send).

Only emails on the `ALLOWED_SIGNUP_EMAILS` list can sign up — ask whoever
controls the deployment to add you. Change mailer accounts later from the
Settings nav item. The very first person to sign up with the shared
account's own email inherits any guest/template data that existed before
accounts did.

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
- lib/crypto.js        Encrypts/decrypts custom mailer passwords at rest
- lib/db.js            Guest/template/user storage (MongoDB if MONGODB_URI is
                        set, otherwise local JSON files) — guests and
                        templates are scoped per account
- lib/bounces.js        Reads bounce notifications back out of a mailbox
- lib/templates.js     Template variable detection + substitution
- public/index.html    The UI, including the onboarding/account flow
- guests.json          Guest lists + email bodies + send status, all
                        accounts (local dev only; auto-created/updated)
- templates.json       Saved templates, all accounts (local dev only)
- users.json           Accounts + (encrypted) custom mailer credentials
                        (local dev only; never committed)
- send.js              Optional command-line sender (npm run send-cli -- --dry-run)
