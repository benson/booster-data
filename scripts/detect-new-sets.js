const fs = require('fs');
const path = require('path');

const PLAY_BOOSTER_START = '2024-02-09';
const VALID_TYPES = new Set(['expansion', 'masters', 'draft_innovation']);

const delay = ms => new Promise(r => setTimeout(r, ms));

async function fetchScryfallSets() {
  const res = await fetch('https://api.scryfall.com/sets');
  if (!res.ok) throw new Error(`Scryfall API error: ${res.status}`);
  const data = await res.json();
  return data.data;
}

async function main() {
  const indexPath = path.join(__dirname, '..', 'index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const existingSets = new Set(Object.keys(index.boosters));

  const sets = await fetchScryfallSets();
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() + 14);

  const candidates = sets.filter(s => {
    if (!VALID_TYPES.has(s.set_type)) return false;
    if (s.digital) return false;
    if (s.parent_set_code) return false;
    const released = new Date(s.released_at);
    if (released > cutoff) return false;
    if (s.released_at < PLAY_BOOSTER_START) return false;
    if (existingSets.has(s.code)) return false;
    return true;
  });

  const output = candidates.map(s => ({
    code: s.code,
    name: s.name,
    released: s.released_at,
    scryfall_uri: s.scryfall_uri
  }));

  console.log(JSON.stringify(output));
}

main().catch(e => {
  console.error(e.message);
  process.exit(1);
});
