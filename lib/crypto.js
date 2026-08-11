const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const KEY_VERSION = 1;

// Same "MONGODB_URI means a real deployment" signal used in lib/auth.js —
// a missing key must fail loudly in prod, not silently encrypt every user's
// real mailbox password with a default sitting in this file.
const IS_DEPLOYED = !!process.env.MONGODB_URI;

function requireKeySource() {
  const value = process.env.ENCRYPTION_KEY;
  if (value) return value;
  if (IS_DEPLOYED) {
    throw new Error('ENCRYPTION_KEY must be set (no default allowed once MONGODB_URI is configured)');
  }
  console.warn('ENCRYPTION_KEY not set — using an insecure default for local dev only.');
  return 'dev-only-insecure-encryption-key';
}

function getKey() {
  return crypto.createHash('sha256').update(requireKeySource()).digest();
}

// Stored as "keyVersion.ivB64.tagB64.encB64". keyVersion is unused today
// (always 1) but reserved so a future key rotation has somewhere to hang a
// migration instead of every stored credential becoming undecryptable at once.
function encrypt(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [KEY_VERSION, iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join('.');
}

function decrypt(stored) {
  const [, ivB64, tagB64, encB64] = stored.split('.');
  const decipher = crypto.createDecipheriv(ALGO, getKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encB64, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
