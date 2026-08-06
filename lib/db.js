const fs = require('fs');
const path = require('path');

const guestsPath = path.join(__dirname, '..', 'guests.json');
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || 'kianistan';

let collectionPromise = null;
function getCollection() {
  if (!collectionPromise) {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(MONGODB_URI);
    collectionPromise = client.connect().then((c) => c.db(MONGODB_DB).collection('guests'));
  }
  return collectionPromise;
}

async function loadGuests() {
  if (MONGODB_URI) {
    const col = await getCollection();
    return col.find({}).project({ _id: 0 }).toArray();
  }
  if (!fs.existsSync(guestsPath)) return [];
  return JSON.parse(fs.readFileSync(guestsPath, 'utf8'));
}

// Mirrors the whole list, matching how callers already treat guests as one array.
async function saveGuests(guests) {
  if (MONGODB_URI) {
    const col = await getCollection();
    await col.deleteMany({});
    if (guests.length) await col.insertMany(guests.map((g) => ({ ...g })));
    return;
  }
  fs.writeFileSync(guestsPath, JSON.stringify(guests, null, 2));
}

module.exports = { loadGuests, saveGuests };
