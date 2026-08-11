const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DEFAULT_TEMPLATE } = require('./templates');

const guestsPath = path.join(__dirname, '..', 'guests.json');
const templatesPath = path.join(__dirname, '..', 'templates.json');
const usersPath = path.join(__dirname, '..', 'users.json');
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || 'kianistan';

const collectionPromises = {};
function getCollection(name) {
  if (!collectionPromises[name]) {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(MONGODB_URI);
    collectionPromises[name] = client.connect().then(async (c) => {
      const col = c.db(MONGODB_DB).collection(name);
      if (name === 'users') {
        // Guards against a race between two near-simultaneous signups for
        // the same address producing two separate accounts.
        await col.createIndex({ email: 1 }, { unique: true });
      }
      return col;
    });
  }
  return collectionPromises[name];
}

function readJsonFile(filePath) {
  return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : [];
}

// ---- guests (owner-scoped) ----

async function loadGuests(ownerId) {
  if (MONGODB_URI) {
    const col = await getCollection('guests');
    return col.find({ ownerId }).project({ _id: 0 }).toArray();
  }
  return readJsonFile(guestsPath).filter((g) => g.ownerId === ownerId);
}

// Replaces only this owner's rows — every other owner's rows in the same
// collection/file are left untouched, mirroring how callers already treat
// each owner's guests as one array.
async function saveGuests(ownerId, guests) {
  const stamped = guests.map((g) => ({ ...g, ownerId }));
  if (MONGODB_URI) {
    const col = await getCollection('guests');
    await col.deleteMany({ ownerId });
    if (stamped.length) await col.insertMany(stamped);
    return;
  }
  const others = readJsonFile(guestsPath).filter((g) => g.ownerId !== ownerId);
  fs.writeFileSync(guestsPath, JSON.stringify([...others, ...stamped], null, 2));
}

// The tracking-pixel routes are hit anonymously by the recipient's mail
// client — there's no session/ownerId at that point, only the guest's
// already-globally-unique id. This is the one deliberate exception to
// owner-scoped guest access.
async function loadGuestByIdUnscoped(id) {
  if (MONGODB_URI) {
    const col = await getCollection('guests');
    return col.findOne({ id }, { projection: { _id: 0 } });
  }
  return readJsonFile(guestsPath).find((g) => g.id === id) || null;
}

async function updateGuestByIdUnscoped(id, patch) {
  if (MONGODB_URI) {
    const col = await getCollection('guests');
    await col.updateOne({ id }, { $set: patch });
    return;
  }
  const all = readJsonFile(guestsPath);
  const idx = all.findIndex((g) => g.id === id);
  if (idx !== -1) {
    all[idx] = { ...all[idx], ...patch };
    fs.writeFileSync(guestsPath, JSON.stringify(all, null, 2));
  }
}

// ---- templates (owner-scoped) ----

// If this owner has no templates at all, seed one default for them rather
// than leaving an empty list — sending has no fallback without at least one.
async function loadTemplates(ownerId) {
  let templates;
  if (MONGODB_URI) {
    const col = await getCollection('templates');
    templates = await col.find({ ownerId }).project({ _id: 0 }).toArray();
  } else {
    templates = readJsonFile(templatesPath).filter((t) => t.ownerId === ownerId);
  }

  if (templates.length === 0) {
    const seeded = [{ id: crypto.randomUUID(), ...DEFAULT_TEMPLATE, createdAt: new Date().toISOString() }];
    await saveTemplates(ownerId, seeded);
    return seeded.map((t) => ({ ...t, ownerId }));
  }
  return templates;
}

async function saveTemplates(ownerId, templates) {
  const stamped = templates.map((t) => ({ ...t, ownerId }));
  if (MONGODB_URI) {
    const col = await getCollection('templates');
    await col.deleteMany({ ownerId });
    if (stamped.length) await col.insertMany(stamped);
    return;
  }
  const others = readJsonFile(templatesPath).filter((t) => t.ownerId !== ownerId);
  fs.writeFileSync(templatesPath, JSON.stringify([...others, ...stamped], null, 2));
}

// ---- users ----
// Targeted single-document ops rather than the whole-collection replace
// pattern above — users are created/updated individually and never
// bulk-replaced, so a load-all/save-all approach would just be an
// unnecessary race between concurrent signups.

async function findUserByEmail(email) {
  const key = email.toLowerCase();
  if (MONGODB_URI) {
    const col = await getCollection('users');
    return col.findOne({ email: key }, { projection: { _id: 0 } });
  }
  return readJsonFile(usersPath).find((u) => u.email === key) || null;
}

async function findUserById(id) {
  if (MONGODB_URI) {
    const col = await getCollection('users');
    return col.findOne({ id }, { projection: { _id: 0 } });
  }
  return readJsonFile(usersPath).find((u) => u.id === id) || null;
}

async function createUser(user) {
  if (MONGODB_URI) {
    const col = await getCollection('users');
    await col.insertOne({ ...user });
    return user;
  }
  const all = readJsonFile(usersPath);
  if (all.some((u) => u.email === user.email)) {
    throw new Error('An account with that email already exists');
  }
  all.push(user);
  fs.writeFileSync(usersPath, JSON.stringify(all, null, 2));
  return user;
}

async function updateUser(id, patch) {
  if (MONGODB_URI) {
    const col = await getCollection('users');
    await col.updateOne({ id }, { $set: patch });
    return;
  }
  const all = readJsonFile(usersPath);
  const idx = all.findIndex((u) => u.id === id);
  if (idx !== -1) {
    all[idx] = { ...all[idx], ...patch };
    fs.writeFileSync(usersPath, JSON.stringify(all, null, 2));
  }
}

// Reassigns guest/template documents that predate per-user accounts (so they
// have no ownerId yet) to a newly-created account — see server.js's signup
// handler for exactly when this runs (only for the one allow-listed email
// that matches the pre-existing shared mailer account).
async function claimUnownedData(ownerId) {
  if (MONGODB_URI) {
    const guestsCol = await getCollection('guests');
    const templatesCol = await getCollection('templates');
    await guestsCol.updateMany({ ownerId: { $exists: false } }, { $set: { ownerId } });
    await templatesCol.updateMany({ ownerId: { $exists: false } }, { $set: { ownerId } });
    return;
  }
  const guests = readJsonFile(guestsPath).map((g) => (g.ownerId ? g : { ...g, ownerId }));
  fs.writeFileSync(guestsPath, JSON.stringify(guests, null, 2));
  const templates = readJsonFile(templatesPath).map((t) => (t.ownerId ? t : { ...t, ownerId }));
  fs.writeFileSync(templatesPath, JSON.stringify(templates, null, 2));
}

module.exports = {
  loadGuests,
  saveGuests,
  loadGuestByIdUnscoped,
  updateGuestByIdUnscoped,
  loadTemplates,
  saveTemplates,
  findUserByEmail,
  findUserById,
  createUser,
  updateUser,
  claimUnownedData,
};
