// Get detailed CN breakdown showing card names at boundaries
const delay = ms => new Promise(r => setTimeout(r, ms));

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
  return cards.sort((a, b) => {
    const cnA = parseInt(a.collector_number, 10) || 9999;
    const cnB = parseInt(b.collector_number, 10) || 9999;
    return cnA - cnB;
  });
}

function desc(c) {
  const parts = [];
  if (c.promo_types?.length) parts.push(c.promo_types.join(','));
  if (c.frame_effects?.length) parts.push(c.frame_effects.join(','));
  if (c.border_color === 'borderless') parts.push('borderless');
  return parts.join(' | ') || '-';
}

async function showSet(setCode, startCN, endCN) {
  const cards = await fetchAll(setCode);
  console.log(`\n${setCode.toUpperCase()} CN ${startCN}-${endCN}:\n`);

  cards
    .filter(c => {
      const cn = parseInt(c.collector_number, 10);
      return cn >= startCN && cn <= endCN;
    })
    .forEach(c => {
      const cn = c.collector_number.padStart(3);
      const booster = c.booster ? '✓' : ' ';
      console.log(`  ${cn} [${booster}] ${c.name} (${c.rarity}) [${desc(c)}]`);
    });
}

const args = process.argv.slice(2);
if (args.length < 3) {
  console.log('Usage: node detailed-cn.js <set> <startCN> <endCN>');
  process.exit(1);
}

showSet(args[0], parseInt(args[1]), parseInt(args[2]));
