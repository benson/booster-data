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

// --- Cross-cutting metadata detection ---

// Find Special Guests (spg) CN range released same day as this set
async function detectSpecialGuestsRange(setReleasedAt) {
  try {
    const res = await fetch(`https://api.scryfall.com/cards/search?q=set%3Aspg&unique=prints&order=set&page=1`);
    if (!res.ok) return null;
    let data = await res.json();
    let cards = data.data || [];
    while (data.has_more) {
      await delay(100);
      const r2 = await fetch(data.next_page);
      data = await r2.json();
      cards = cards.concat(data.data || []);
    }
    const matching = cards
      .filter(c => c.released_at === setReleasedAt)
      .map(c => parseInt(c.collector_number, 10))
      .filter(n => !isNaN(n))
      .sort((a, b) => a - b);
    if (matching.length === 0) return null;
    return [matching[0], matching[matching.length - 1]];
  } catch (e) {
    console.error(`  Special Guests detection failed: ${e.message}`);
    return null;
  }
}

// Find bonus sheet: a Scryfall set with parent_set_code === setCode that isn't promos/tokens
async function detectBonusSheet(setCode) {
  try {
    const res = await fetch('https://api.scryfall.com/sets');
    if (!res.ok) return null;
    const data = await res.json();
    const children = data.data.filter(s =>
      s.parent_set_code === setCode &&
      !s.digital &&
      !['token', 'memorabilia', 'promo'].includes(s.set_type) &&
      (s.card_count || 0) >= 20 &&
      !/token|art series|substitute|promo/i.test(s.name)
    );
    // Prefer sets that look like bonus sheets (reprints/eternal/masters types)
    const preferred = children.find(s => ['masters', 'draft_innovation', 'eternal'].includes(s.set_type));
    const pick = preferred || children[0];
    return pick ? pick.code : null;
  } catch (e) {
    console.error(`  Bonus sheet detection failed: ${e.message}`);
    return null;
  }
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

// --- Example configs for prompt (cached) ---

function loadExampleConfigs() {
  const boostersDir = path.join(__dirname, '..', 'boosters');
  const examples = [
    'sos-play.json', 'sos-collector.json', // mystical-archive-style
    'fin-play.json', 'fin-collector.json', // bonus-sheet-style
    'blb-play.json', 'blb-collector.json', // special-guests-style
    'tmt-play.json',                        // unusual slot (legendary turtle)
  ];
  const configs = [];
  for (const name of examples) {
    const fp = path.join(boostersDir, name);
    if (fs.existsSync(fp)) {
      configs.push({ name, content: JSON.parse(fs.readFileSync(fp, 'utf8')) });
    }
  }
  return configs;
}

// Extract a JSON object from text that may contain prose and/or markdown fences.
function extractJSON(text) {
  // Prefer the last fenced ```json``` block if present
  const blocks = [...text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/gi)];
  if (blocks.length > 0) return blocks[blocks.length - 1][1].trim();

  // Fallback: find the outermost balanced { ... } in the text
  const start = text.indexOf('{');
  if (start === -1) throw new Error('No { found in response');
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error('Unbalanced braces');
}

// --- Claude API call with web search ---

async function generateWithClaude({ setCode, setName, setReleasedAt, analysis, specialGuestsRange, bonusSheetCode, examples }) {
  const client = new Anthropic();

  const { summary, basicLandCNs } = analysis;
  const basicLandRanges = formatCNRanges(basicLandCNs);

  const systemPrompt = `You generate accurate booster-pack configuration JSON files for Magic: The Gathering sets, consumed by pack-value and sealed-pool tools.

Rules:
1. Use web_search to find the official Wizards of the Coast "collecting {set name}" article at magic.wizards.com/en/news — it describes every booster slot. If you cannot find it, STOP and return an error message explaining the article is unavailable.
2. Never guess slot structure. CN ranges come from Scryfall analysis (given); slot rules come from the WotC article (found via search).
3. Play Boosters are typically 13 cards: 6 commons + 3 uncommons + 1 rare/mythic + 1 wildcard + 1 foil + 1 land. Some sets add a dedicated bonus-sheet slot for 14 total.
4. Collector Boosters are typically 15: 5 rare/mythic + 4 uncommon (foil) + 4 common (foil) + 2 collector-exclusive + occasional bonus slot.
5. CN ranges in "pool" must include every treatment mentioned by the article as appearing in that booster.
6. Extended-art cards are collector-only unless the article says otherwise.
7. Output ONLY valid JSON in the final response — no markdown, no commentary.`;

  const examplesBlock = examples.map(e => `### ${e.name}\n\`\`\`json\n${JSON.stringify(e.content, null, 2)}\n\`\`\``).join('\n\n');

  const userPrompt = `Generate play AND collector booster configs for the set "${setName}" (code: "${setCode}", released ${setReleasedAt}).

## Scryfall CN analysis
${summary.map(s => `- ${s.category}: CN ${s.minCN}-${s.maxCN} (${s.count} cards, ${s.inBooster} booster-eligible) — rarities ${JSON.stringify(s.rarities)}`).join('\n')}

## Basic Land CNs
${basicLandRanges.length > 0 ? basicLandRanges.join(', ') : 'None found'}

## Detected cross-cutting metadata
- Special Guests range (set:spg cards released ${setReleasedAt}): ${specialGuestsRange ? `CN ${specialGuestsRange[0]}-${specialGuestsRange[1]}` : 'none'}
- Bonus sheet child set on Scryfall: ${bonusSheetCode || 'none'}

## Task
Use web_search to find the "collecting ${setName}" article on magic.wizards.com. Read it carefully. Produce a JSON object with three fields:

\`\`\`
{
  "play": { ...play booster config... },
  "collector": { ...collector booster config... },
  "metadata": {
    "specialGuests": [start, end] | null,
    "bonusSheet": "xxx" | null,
    "hasBigScore": boolean
  }
}
\`\`\`

The play and collector configs must match the example format exactly (set, setName, boosterType, source, slots[]). Use "${setCode}" as set, "${setName}" as setName, "play"/"collector" as boosterType, the article URL as source.

Set metadata.specialGuests to the detected range if the article confirms Special Guests appear in this set's play boosters; else null.
Set metadata.bonusSheet to the detected child set code if the article confirms it appears as a dedicated bonus-sheet slot in play boosters; else null.
Set metadata.hasBigScore to true only if this set is OTJ or a direct Big Score reprint.`;

  const examplesSystem = `## Example configs for reference\n\n${examplesBlock}`;

  let response;
  try {
    response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      system: [
        { type: 'text', text: systemPrompt },
        { type: 'text', text: examplesSystem, cache_control: { type: 'ephemeral' } },
      ],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (e) {
    throw new Error(`Claude API error: ${e.message}`);
  }

  // Extract the final text block (after any tool_use/tool_result rounds)
  const textBlocks = response.content.filter(b => b.type === 'text');
  if (textBlocks.length === 0) throw new Error('Claude returned no text content');
  const finalText = textBlocks[textBlocks.length - 1].text.trim();

  const json = extractJSON(finalText);
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`Claude did not return valid JSON: ${e.message}. Response excerpt: ${finalText.slice(0, 500)}`);
  }

  if (!parsed.play || !parsed.collector || !parsed.metadata) {
    throw new Error(`Claude output missing required top-level fields (play/collector/metadata). Got keys: ${Object.keys(parsed).join(',')}`);
  }
  return parsed;
}

// --- Metadata merging ---

function updateMetadata(setCode, m) {
  const metaPath = path.join(__dirname, '..', 'metadata.json');
  const existing = fs.existsSync(metaPath)
    ? JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    : { version: 1, sets: {} };

  const entry = {};
  if (Array.isArray(m.specialGuests) && m.specialGuests.length === 2) entry.specialGuests = m.specialGuests;
  if (m.bonusSheet) entry.bonusSheet = m.bonusSheet;
  if (m.hasBigScore) entry.hasBigScore = true;

  if (Object.keys(entry).length === 0) {
    // Nothing to record; leave metadata.json alone
    return false;
  }

  existing.sets = existing.sets || {};
  existing.sets[setCode] = entry;

  // Keep sets keyed alphabetically for stable diffs
  const sortedSets = Object.fromEntries(Object.keys(existing.sets).sort().map(k => [k, existing.sets[k]]));
  existing.sets = sortedSets;

  fs.writeFileSync(metaPath, JSON.stringify(existing, null, 2) + '\n');
  return true;
}

// --- Index.json update ---

function updateIndex(setCode, hasCollector) {
  const indexPath = path.join(__dirname, '..', 'index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const types = index.boosters[setCode] || [];
  if (!types.includes('play')) types.push('play');
  if (hasCollector && !types.includes('collector')) types.push('collector');
  types.sort();
  index.boosters[setCode] = types;

  const sorted = { version: index.version, boosters: {} };
  Object.keys(index.boosters).sort().forEach(k => { sorted.boosters[k] = index.boosters[k]; });
  fs.writeFileSync(indexPath, JSON.stringify(sorted, null, 4) + '\n');
}

// --- Main ---

async function main() {
  const setCode = process.argv[2];
  if (!setCode) {
    console.error('Usage: node generate-config.js <set-code>');
    process.exit(1);
  }

  const code = setCode.toLowerCase();
  console.error(`[${code}] fetching set info...`);
  const setInfo = await fetchSetInfo(code);

  console.error(`[${code}] fetching cards for ${setInfo.name}...`);
  const cards = await fetchAllCards(code);
  console.error(`[${code}]   ${cards.length} cards`);

  console.error(`[${code}] analyzing CN structure...`);
  const analysis = analyzeCards(cards);
  analysis.summary.forEach(s => {
    console.error(`[${code}]   ${s.category}: CN ${s.minCN}-${s.maxCN} (${s.count} cards, ${s.inBooster} booster-eligible)`);
  });

  console.error(`[${code}] detecting Special Guests range...`);
  const specialGuestsRange = await detectSpecialGuestsRange(setInfo.released_at);
  console.error(`[${code}]   ${specialGuestsRange ? `CN ${specialGuestsRange[0]}-${specialGuestsRange[1]}` : 'none'}`);

  console.error(`[${code}] detecting bonus sheet...`);
  const bonusSheetCode = await detectBonusSheet(code);
  console.error(`[${code}]   ${bonusSheetCode || 'none'}`);

  console.error(`[${code}] loading example configs...`);
  const examples = loadExampleConfigs();

  console.error(`[${code}] calling Claude with web_search...`);
  const result = await generateWithClaude({
    setCode: code,
    setName: setInfo.name,
    setReleasedAt: setInfo.released_at,
    analysis,
    specialGuestsRange,
    bonusSheetCode,
    examples,
  });

  // Overwrite authoritative fields on the configs
  for (const bt of ['play', 'collector']) {
    result[bt].set = code;
    result[bt].setName = setInfo.name;
    result[bt].boosterType = bt;
  }

  const playPath = path.join(__dirname, '..', 'boosters', `${code}-play.json`);
  const collectorPath = path.join(__dirname, '..', 'boosters', `${code}-collector.json`);
  fs.writeFileSync(playPath, JSON.stringify(result.play, null, 2) + '\n');
  fs.writeFileSync(collectorPath, JSON.stringify(result.collector, null, 2) + '\n');
  console.error(`[${code}] wrote ${code}-play.json and ${code}-collector.json`);

  updateIndex(code, true);
  console.error(`[${code}] updated index.json`);

  const metaChanged = updateMetadata(code, result.metadata);
  console.error(`[${code}] metadata.json ${metaChanged ? 'updated' : 'unchanged'}`);
}

main().catch(e => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
