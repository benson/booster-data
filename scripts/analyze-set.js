// Analyze CN structure for a set
const delay = ms => new Promise(r => setTimeout(r, ms));

const COLLECTOR_PROMOS = new Set([
  'fracturefoil', 'texturedfoil', 'textured', 'ripplefoil',
  'halofoil', 'confettifoil', 'galaxyfoil', 'surgefoil',
  'raisedfoil', 'serialized', 'manafoil', 'invisibleink',
]);
const COLLECTOR_FRAMES = new Set(['extendedart', 'inverted', 'etched']);

function categorize(c) {
  const promos = c.promo_types || [];
  const frames = c.frame_effects || [];

  if (promos.some(p => COLLECTOR_PROMOS.has(p))) return 'collector-promo';
  if (frames.some(f => COLLECTOR_FRAMES.has(f))) return 'collector-frame';
  if (frames.includes('showcase')) return 'showcase';
  if (c.border_color === 'borderless') return 'borderless';
  if (promos.includes('boosterfun')) return 'boosterfun';
  if (c.type_line && c.type_line.includes('Basic Land')) return 'basic-land';
  return 'base';
}

async function fetchAll(setCode) {
  let cards = [];
  let url = `https://api.scryfall.com/cards/search?q=set:${setCode}+lang:en&unique=prints&order=set`;
  while (url) {
    await delay(100);
    const res = await fetch(url);
    if (res.status === 404) break;
    const d = await res.json();
    cards = cards.concat(d.data || []);
    url = d.has_more ? d.next_page : null;
  }
  return cards;
}

async function analyzeSet(setCode) {
  const cards = await fetchAll(setCode);
  const groups = {};

  cards.forEach(c => {
    const cn = parseInt(c.collector_number, 10);
    if (isNaN(cn)) return;
    const cat = categorize(c);
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push({ cn, name: c.name, rarity: c.rarity, booster: c.booster });
  });

  console.log(`${setCode.toUpperCase()} (${cards.length} cards):\n`);

  Object.entries(groups)
    .sort((a, b) => Math.min(...a[1].map(x => x.cn)) - Math.min(...b[1].map(x => x.cn)))
    .forEach(([cat, items]) => {
      items.sort((a, b) => a.cn - b.cn);
      const minCN = items[0].cn;
      const maxCN = items[items.length - 1].cn;
      const inBooster = items.filter(x => x.booster).length;
      console.log(`  ${cat}: CN ${minCN}-${maxCN} (${items.length} cards, ${inBooster} with booster:true)`);
    });

  console.log();
}

const sets = process.argv.slice(2);
if (sets.length === 0) {
  console.log('Usage: node analyze-set.js <set1> <set2> ...');
  process.exit(1);
}

(async () => {
  for (const set of sets) {
    await analyzeSet(set);
  }
})();
