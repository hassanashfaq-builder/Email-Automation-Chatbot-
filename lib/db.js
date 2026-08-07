const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DEFAULT_TEMPLATE } = require('./templates');

const guestsPath = path.join(__dirname, '..', 'guests.json');
const templatesPath = path.join(__dirname, '..', 'templates.json');
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || 'kianistan';

const collectionPromises = {};
function getCollection(name) {
  if (!collectionPromises[name]) {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(MONGODB_URI);
    collectionPromises[name] = client.connect().then((c) => c.db(MONGODB_DB).collection(name));
  }
  return collectionPromises[name];
}

async function loadGuests() {
  if (MONGODB_URI) {
    const col = await getCollection('guests');
    return col.find({}).project({ _id: 0 }).toArray();
  }
  if (!fs.existsSync(guestsPath)) return [];
  return JSON.parse(fs.readFileSync(guestsPath, 'utf8'));
}

// Mirrors the whole list, matching how callers already treat guests as one array.
async function saveGuests(guests) {
  if (MONGODB_URI) {
    const col = await getCollection('guests');
    await col.deleteMany({});
    if (guests.length) await col.insertMany(guests.map((g) => ({ ...g })));
    return;
  }
  fs.writeFileSync(guestsPath, JSON.stringify(guests, null, 2));
}

// If every template has been deleted, re-seed the default one rather than
// leaving an empty list — sending has no fallback without at least one.
async function loadTemplates() {
  let templates;
  if (MONGODB_URI) {
    const col = await getCollection('templates');
    templates = await col.find({}).project({ _id: 0 }).toArray();
  } else {
    templates = fs.existsSync(templatesPath) ? JSON.parse(fs.readFileSync(templatesPath, 'utf8')) : [];
  }

  if (templates.length === 0) {
    const seeded = [{ id: crypto.randomUUID(), ...DEFAULT_TEMPLATE, createdAt: new Date().toISOString() }];
    await saveTemplates(seeded);
    return seeded;
  }
  return templates;
}

async function saveTemplates(templates) {
  if (MONGODB_URI) {
    const col = await getCollection('templates');
    await col.deleteMany({});
    if (templates.length) await col.insertMany(templates.map((t) => ({ ...t })));
    return;
  }
  fs.writeFileSync(templatesPath, JSON.stringify(templates, null, 2));
}

module.exports = { loadGuests, saveGuests, loadTemplates, saveTemplates };
