const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const guestsPath = path.join(__dirname, 'guests.json');

if (!fs.existsSync(guestsPath)) {
  console.error('guests.json not found. Each entry needs: { "name": "...", "email": "...", "body": "..." }');
  process.exit(1);
}

const guests = JSON.parse(fs.readFileSync(guestsPath, 'utf8'));

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = (() => {
  const idx = process.argv.indexOf('--limit');
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : null;
})();

async function main() {
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.auth,
  });

  if (!DRY_RUN) {
    await transporter.verify();
    console.log('SMTP connection verified.\n');
  }

  const toSend = LIMIT ? guests.slice(0, LIMIT) : guests;
  let sent = 0, failed = 0;

  for (const guest of toSend) {
    if (!guest.email || !guest.body) {
      console.warn(`Skipping ${guest.name || 'unknown'} - missing email or body`);
      continue;
    }

    if (DRY_RUN) {
      console.log('='.repeat(70));
      console.log(`TO: ${guest.name} <${guest.email}>`);
      console.log(`SUBJECT: ${config.subject}`);
      console.log('-'.repeat(70));
      console.log(guest.body);
      console.log('='.repeat(70) + '\n');
      continue;
    }

    try {
      await transporter.sendMail({
        from: `"${config.fromName}" <${config.auth.user}>`,
        to: guest.email,
        subject: config.subject,
        text: guest.body,
      });
      console.log(`✓ Sent to ${guest.name} <${guest.email}>`);
      sent++;
      // small delay to avoid hammering the SMTP server / triggering spam filters
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      console.error(`✗ Failed for ${guest.name} <${guest.email}>: ${err.message}`);
      failed++;
    }
  }

  if (!DRY_RUN) {
    console.log(`\nDone. Sent: ${sent}, Failed: ${failed}`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
