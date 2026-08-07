# Kianistan Podcast — Invitation Mailer

## One-time setup
1. Install Node.js from https://nodejs.org (LTS version) if you don't have it.
2. Open this folder in Cursor (or any terminal).
3. Run:
   npm install
4. Copy config.example.json to config.json and fill in your real SMTP details.

## Running it
Run:
   npm start

Then open http://localhost:3344 in your browser. Keep the terminal window open
while you use it.

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
   expandable to the guest list behind it.

## Files
- config.json        SMTP credentials (keep this private, not committed)
- config.example.json  Template to copy from
- server.js           Local web server
- lib/db.js            Guest + template storage (MongoDB if MONGODB_URI is
                        set, otherwise local JSON files)
- lib/templates.js     Template variable detection + substitution
- public/index.html    The UI
- guests.json          Your guest list + email bodies + send status
                        (local dev only; auto-created/updated)
- templates.json       Your saved templates (local dev only)
- send.js              Optional command-line sender (npm run send-cli -- --dry-run)
