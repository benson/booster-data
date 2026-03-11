const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk').default;

const delay = ms => new Promise(r => setTimeout(r, ms));

// --- Card categorization (from analyze-set.js) ---

const COLLECTOR_PROMOS = new Set([
  'fracturefoil', 'texturedfoil', 'textured', 'ripplefoil',
  'halofoil', 'confettifoil', 'galaxyfoil', 'surgefoil',
  'raisedfoil', 'serialized', 'manafoil', 'invisibleink',
]);
// extendedart is always collector-only; inverted/etched may appear in play boosters
// depending on the set, so we categorize them separately for the prompt to decide
const ALWAYS_COLLECTOR_FRAMES = new Set(['extendedart']);

function categorize(c) {
  const promos = c.promo_types || [];
  const frames = c.frame_effects || [];
  if (promos.some(p => COLLECTOR_PROMOS.has(p))) return 'collector-promo';
  if (frames.some(f => ALWAYS_COLLECTOR_FRAMES.has(f))) return 'collector-frame';
  if (frames.includes('inverted')) return 'inverted';
  if (frames.includes('etched')) return 'etched';
  if (frames.includes('showcase')) return 'showcase';
  if (c.border_color === 'borderless') return 'borderless';
  if (promos.includes('boosterfun')) return 'boosterfun';
  if (c.type_line && c.type_line.includes('Basic Land')) return 'basic-land';
  return 'base';
}

// --- Scryfall fetching ---

async function fetchAllCards(setCode) {
  let cards = [];
  let url = `https://api.scryfall.com/cards/search?q=set:${setCode}+lang:en&unique=prints&order=set`;
  while (url) {
    await delay(100);
    const res = await fetch(url);
    if (res.status === 404) break;
    if (!res.ok) throw new Error(`Scryfall error: ${res.status}`);
    const d = await res.json();
    cards = cards.concat(d.data || []);
    url = d.has_more ? d.next_page : null;
  }
  return cards;
}

async function fetchSetInfo(setCode) {
  const res = await fetch(`https://api.scryfall.com/sets/${setCode}`);
  if (!res.ok) throw new Error(`Scryfall set error: ${res.status}`);
  return res.json();
}

// --- CN analysis ---

function analyzeCards(cards) {
  const groups = {};
  const rarityBreakdown = { common: 0, uncommon: 0, rare: 0, mythic: 0 };

  cards.forEach(c => {
    const cn = parseInt(c.collector_number, 10);
    if (isNaN(cn)) return;
    const cat = categorize(c);
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push({
      cn, name: c.name, rarity: c.rarity,
      booster: c.booster,
      type_line: c.type_line || '',
    });
    if (c.booster && rarityBreakdown[c.rarity] !== undefined) {
      rarityBreakdown[c.rarity]++;
    }
  });

  const summary = Object.entries(groups)
    .sort((a, b) => Math.min(...a[1].map(x => x.cn)) - Math.min(...b[1].map(x => x.cn)))
    .map(([cat, items]) => {
      items.sort((a, b) => a.cn - b.cn);
      const minCN = items[0].cn;
      const maxCN = items[items.length - 1].cn;
      const inBooster = items.filter(x => x.booster).length;
      const rarities = {};
      items.forEach(x => { rarities[x.rarity] = (rarities[x.rarity] || 0) + 1; });
      return { category: cat, minCN, maxCN, count: items.length, inBooster, rarities };
    });

  // Find basic land CN ranges
  const basicLands = cards.filter(c => c.type_line && c.type_line.includes('Basic Land'));
  const basicLandCNs = basicLands
    .map(c => parseInt(c.collector_number, 10))
    .filter(n => !isNaN(n))
    .sort((a, b) => a - b);

  return { groups, summary, rarityBreakdown, basicLandCNs };
}

function formatCNRanges(cns) {
  if (cns.length === 0) return [];
  const ranges = [];
  let start = cns[0], end = cns[0];
  for (let i = 1; i < cns.length; i++) {
    if (cns[i] === end + 1) {
      end = cns[i];
    } else {
      ranges.push(start === end ? `${start}` : `${start}-${end}`);
      start = end = cns[i];
    }
  }
  ranges.push(start === end ? `${start}` : `${start}-${end}`);
  return ranges;
}

// --- WotC article search ---

async function searchCollectingArticle(setName) {
  const query = encodeURIComponent(`site:magic.wizards.com "collecting" "${setName}"`);
  try {
    const res = await fetch(`https://www.google.com/search?q=${query}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; bot)' }
    });
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(/https:\/\/magic\.wizards\.com\/en\/news\/feature\/collecting-[^\s"&]+/);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

async function fetchArticleText(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; bot)' }
    });
    if (!res.ok) return null;
    const html = await res.text();
    // Strip HTML tags, keep text content
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    // Truncate to ~8000 chars to fit in prompt
    return text.substring(0, 8000);
  } catch {
    return null;
  }
}

// --- Example configs for prompt ---

function loadExampleConfigs() {
  const boostersDir = path.join(__dirname, '..', 'boosters');
  const examples = ['fin-play.json', 'blb-play.json', 'tmt-play.json'];
  const configs = [];
  for (const name of examples) {
    const fp = path.join(boostersDir, name);
    if (fs.existsSync(fp)) {
      configs.push({ name, content: JSON.parse(fs.readFileSync(fp, 'utf8')) });
    }
  }
  return configs;
}

// --- Claude API call ---

async function generateWithClaude(setCode, setName, analysis, articleUrl, articleText, examples) {
  const client = new Anthropic();

  const { summary, basicLandCNs } = analysis;
  const basicLandRanges = formatCNRanges(basicLandCNs);

  let prompt = `Generate a play booster config JSON for the Magic: The Gathering set "${setName}" (set code: "${setCode}").

## CN Analysis from Scryfall
${summary.map(s => `- ${s.category}: CN ${s.minCN}-${s.maxCN} (${s.count} cards, ${s.inBooster} booster-eligible) — rarities: ${JSON.stringify(s.rarities)}`).join('\n')}

## Basic Land CNs
${basicLandRanges.length > 0 ? basicLandRanges.join(', ') : 'None found'}

`;

  if (articleText) {
    prompt += `## WotC Collecting Article
Source: ${articleUrl}
${articleText}

`;
  } else {
    prompt += `## No WotC Collecting Article Found
Use standard play booster structure based on the CN analysis.

`;
  }

  prompt += `## Example Configs for Reference
${examples.map(e => `### ${e.name}\n\`\`\`json\n${JSON.stringify(e.content, null, 2)}\n\`\`\``).join('\n\n')}

## Instructions
1. Standard play booster = 6 commons + 3 uncommons + 1 rare/mythic + 1 wildcard + 1 foil + 1 land = 13 cards per pack
2. If the collecting article mentions a special slot (like a dedicated character slot, bonus sheet, etc.), add it and adjust counts accordingly
3. The "pool" CN ranges should include ALL booster-eligible cards. CRITICAL: check the collecting article carefully for which treatments appear in play boosters:
   - "inverted" / sewer frame cards CAN appear in play boosters for some sets (e.g. TMT) — include them if the article says so
   - "showcase" / scene cards typically appear in play boosters — include them
   - "borderless" cards may appear in play boosters — check the article
   - Extended-art cards are almost always collector-booster-only — exclude unless article says otherwise
   - Silhouette / special mythics often appear in play boosters at low rates — include if article confirms
4. Do NOT assume all bonus cards are collector-only. Read the article slot-by-slot and include every treatment it lists for play boosters
5. The land slot should use the basic land CN range specifically
6. If there's a bonus sheet from another set, use "bonusSet" field with that set's code
7. mythicRate should be 0.125 (1 in 8) for the rare slot
8. The "source" field should be the WotC collecting article URL if available

Return ONLY the JSON object, no markdown fencing or explanation.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.trim();
  // Strip markdown fencing if present
  const json = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
  return JSON.parse(json);
}

// --- Main ---

async function main() {
  const setCode = process.argv[2];
  if (!setCode) {
    console.error('Usage: node generate-config.js <set-code>');
    process.exit(1);
  }

  const code = setCode.toLowerCase();
  console.error(`Fetching set info for ${code}...`);
  const setInfo = await fetchSetInfo(code);

  console.error(`Fetching cards for ${setInfo.name}...`);
  const cards = await fetchAllCards(code);
  console.error(`  ${cards.length} cards fetched`);

  console.error('Analyzing CN structure...');
  const analysis = analyzeCards(cards);
  analysis.summary.forEach(s => {
    console.error(`  ${s.category}: CN ${s.minCN}-${s.maxCN} (${s.count} cards, ${s.inBooster} booster-eligible)`);
  });

  console.error('Searching for WotC collecting article...');
  const articleUrl = await searchCollectingArticle(setInfo.name);
  let articleText = null;
  if (articleUrl) {
    console.error(`  Found: ${articleUrl}`);
    articleText = await fetchArticleText(articleUrl);
  } else {
    console.error('  Not found — will use standard structure');
  }

  console.error('Loading example configs...');
  const examples = loadExampleConfigs();

  console.error('Calling Claude API...');
  const config = await generateWithClaude(code, setInfo.name, analysis, articleUrl, articleText, examples);

  // Ensure required fields
  config.set = code;
  config.setName = setInfo.name;
  config.boosterType = 'play';

  // Write config file
  const outPath = path.join(__dirname, '..', 'boosters', `${code}-play.json`);
  fs.writeFileSync(outPath, JSON.stringify(config, null, 2) + '\n');
  console.error(`Config written to boosters/${code}-play.json`);

  // Update index.json
  const indexPath = path.join(__dirname, '..', 'index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  if (!index.boosters[code]) {
    index.boosters[code] = ['play'];
  } else if (!index.boosters[code].includes('play')) {
    index.boosters[code].push('play');
    index.boosters[code].sort();
  }

  // Sort boosters object alphabetically
  const sorted = {};
  sorted.version = index.version;
  sorted.boosters = {};
  Object.keys(index.boosters).sort().forEach(k => {
    sorted.boosters[k] = index.boosters[k];
  });
  fs.writeFileSync(indexPath, JSON.stringify(sorted, null, 4) + '\n');
  console.error(`index.json updated`);
}

main().catch(e => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
