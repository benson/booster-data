// Audit booster-data CN ranges against Scryfall booster:true data
// Finds cards Scryfall says are in boosters but our ranges exclude
// Filters out known collector-exclusive treatments to reduce false positives

const fs = require('fs');
const path = require('path');

const SCRYFALL_API = 'https://api.scryfall.com';
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// Known non-play-booster promo types
const COLLECTOR_ONLY_PROMOS = new Set([
  'fracturefoil', 'texturedfoil', 'ripplefoil', 'halofoil',
  'confettifoil', 'galaxyfoil', 'surgefoil', 'raisedfoil',
  'headliner', 'serialized', 'buyabox', 'bundle',
  'planeswalkerdeck', 'starterdeck', 'prerelease',
  'datestamped', 'playerrewards', 'gameday', 'release',
  'promostamped', 'startercollection', 'beginnerbox',
  'promopack', 'themepack', 'brawldeck', 'playtest',
  'manafoil', 'invisibleink',
]);

// Known collector-exclusive frame effects
const COLLECTOR_ONLY_FRAMES = new Set([
  'extendedart', 'inverted', 'etched',
]);

async function fetchJSON(url) {
  for (let i = 0; i < 3; i++) {
    const res = await fetch(url);
    if (res.status === 429) { await delay(1000); continue; }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }
}

function isInRange(cn, rangeStr) {
  const cnNum = parseInt(cn, 10);
  if (isNaN(cnNum)) return false;
  if (rangeStr.includes('-')) {
    const [start, end] = rangeStr.split('-').map(n => parseInt(n, 10));
    return cnNum >= start && cnNum <= end;
  }
  return cnNum === parseInt(rangeStr, 10);
}

// Check if card is likely collector-exclusive based on promo types / frames
function isLikelyCollectorExclusive(card) {
  const promos = card.promo_types || [];
  const frames = card.frame_effects || [];
  if (promos.some(p => COLLECTOR_ONLY_PROMOS.has(p))) return true;
  if (frames.some(f => COLLECTOR_ONLY_FRAMES.has(f))) return true;
  return false;
}

async function fetchAllCards(setCode) {
  const query = `set:${setCode} booster:true lang:en`;
  const url = `${SCRYFALL_API}/cards/search?q=${encodeURIComponent(query)}&unique=prints`;

  let cards = [];
  let data = await fetchJSON(url);
  if (!data) return [];
  cards = data.data || [];
  while (data.has_more && data.next_page) {
    await delay(100);
    data = await fetchJSON(data.next_page);
    cards = cards.concat(data.data || []);
  }
  return cards;
}

async function main() {
  const boosterDir = path.join(__dirname, '..', 'boosters');
  const files = fs.readdirSync(boosterDir).filter(f => f.endsWith('-play.json') || f.endsWith('-draft.json'));

  console.log(`Auditing ${files.length} booster files...`);
  console.log(`Filtering out known collector-exclusive treatments\n`);

  let totalSuspicious = 0;
  let totalFiltered = 0;
  const issues = [];

  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(boosterDir, file), 'utf8'));
    const setCode = data.set;

    // Collect all CN ranges from all slots
    const allRanges = [];
    for (const slot of (data.slots || [])) {
      if (!slot.pool) continue;
      for (const ranges of Object.values(slot.pool)) {
        allRanges.push(...ranges);
      }
    }

    if (allRanges.length === 0) continue;

    const uniqueRanges = [...new Set(allRanges)];

    await delay(100);
    let cards;
    try {
      cards = await fetchAllCards(setCode);
    } catch (e) {
      console.log(`${setCode}: ERROR fetching - ${e.message}`);
      continue;
    }

    if (cards.length === 0) continue;

    // Find cards outside our ranges
    const outsideRange = cards.filter(card => {
      const cn = card.collector_number;
      if (isNaN(parseInt(cn, 10))) return false;
      return !uniqueRanges.some(range => isInRange(cn, range));
    });

    // Split into likely collector-exclusive (filtered) vs suspicious
    const filtered = outsideRange.filter(c => isLikelyCollectorExclusive(c));
    const suspicious = outsideRange.filter(c => !isLikelyCollectorExclusive(c));

    totalFiltered += filtered.length;

    if (suspicious.length > 0) {
      totalSuspicious += suspicious.length;
      const setIssue = {
        set: setCode.toUpperCase(),
        name: data.setName,
        ranges: uniqueRanges,
        cards: suspicious.map(c => ({
          cn: c.collector_number,
          name: c.name,
          rarity: c.rarity,
          promos: (c.promo_types || []).join(','),
          frames: (c.frame_effects || []).join(','),
        })),
        filteredCount: filtered.length,
      };
      issues.push(setIssue);

      console.log(`${setIssue.set} (${setIssue.name}) - ${suspicious.length} SUSPICIOUS (${filtered.length} filtered) [ranges: ${uniqueRanges.join(', ')}]:`);
      suspicious.forEach(c => {
        const promos = (c.promo_types || []).join(',');
        const frames = (c.frame_effects || []).join(',');
        const tags = [promos, frames].filter(Boolean).join(' | ');
        console.log(`  CN ${c.collector_number} ${c.name} (${c.rarity})${tags ? ' [' + tags + ']' : ''}`);
      });
      console.log();
    } else {
      process.stdout.write('.');
    }
  }

  console.log(`\n\nDone.`);
  console.log(`${totalSuspicious} suspicious cards outside ranges (need review)`);
  console.log(`${totalFiltered} cards filtered as likely collector-exclusive`);

  // Write results to file for easier analysis
  const outPath = path.join(__dirname, '..', 'audit-results.json');
  fs.writeFileSync(outPath, JSON.stringify(issues, null, 2));
  console.log(`\nDetailed results written to ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
