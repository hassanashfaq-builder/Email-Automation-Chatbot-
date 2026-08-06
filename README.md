# Kianistan Podcast — Invitation Mailer

## One-time setup
1. Install Node.js from https://nodejs.org (LTS version) if you don't have it.
2. Open this folder in Cursor (or any terminal).
3. Run:
   npm install

## Add your Anthropic API key (needed for auto-writing personalized emails)
1. Get a key at https://console.anthropic.com/settings/keys
2. Open config.json and replace "YOUR_ANTHROPIC_API_KEY_HERE" with your real key.

Your SMTP details are already filled in in config.json. If you ever change your
email password, update it there too.

## Running it
Run:
   npm start

Then open http://localhost:3344 in your browser. Keep the terminal window open
while you use it.

## Using the app
1. Paste your guest list (Name | Email | Background | Topic, one per line)
   or upload a CSV (columns: name, email, background, topic).
2. Check the box next to whoever you want to email.
3. Click "Generate & Send" — it writes a personalized invitation for each
   selected guest (following your template's tone/structure) and sends it
   through your mail server automatically. You'll see a live status per
   guest and a toast when it's done.
4. Click "Preview" on any guest to read the generated email after it's sent.
5. Already-sent guests are marked ✓ Sent and unchecked automatically so you
   won't accidentally double-send.

## Files
- config.json      SMTP + Anthropic API credentials (keep this private)
- server.js        Local web server
- lib/generate.js  Calls Claude to write each personalized email
- public/index.html  The UI
- guests.json      Your guest list + generated emails + send status (auto-created/updated)
- send.js          Optional command-line sender (npm run send-cli -- --dry-run)
