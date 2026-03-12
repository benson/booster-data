const fs = require('fs');
const path = require('path');

const delay = ms => new Promise(r => setTimeout(r, ms));

function parseRange(range) {
  const match = range.match(/^(\d+)-(\d+)$/);
  if (match) return { start: parseInt(match[1]), end: parseInt(match[2]) };
  const single = range.match(/^(\d+)$/);
  if (single) return { start: parseInt(single[1]), end: parseInt(single[1]) };
  return null;
}

function getAllCNsFromSlot(slot) {
  const cns = new Set();
  if (!slot.pool || slot.bonusSet) return cns;
  Object.values(slot.pool).forEach(ranges => {
    if (!Array.isArray(ranges)) return;
    ranges.forEach(r => {
      const parsed = parseRange(r);
      if (parsed) {
        for (let i = parsed.start; i <= parsed.end; i++) cns.add(i);
      }
    });
  });
  return cns;
}

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

async function validate(setCode) {
  const errors = [];
  const warnings = [];

  const configPath = path.join(__dirname, '..', 'boosters', `${setCode}-play.json`);
  if (!fs.existsSync(configPath)) {
    errors.push(`Config file not found: ${setCode}-play.json`);
    return { valid: false, errors, warnings };
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    errors.push(`Invalid JSON: ${e.message}`);
    return { valid: false, errors, warnings };
  }

  // Schema validation
  if (!config.set) errors.push('Missing "set" field');
  if (!config.setName) errors.push('Missing "setName" field');
  if (!config.boosterType) errors.push('Missing "boosterType" field');
  if (config.set !== setCode) errors.push(`"set" field "${config.set}" doesn't match expected "${setCode}"`);
  if (config.boosterType !== 'play') errors.push(`"boosterType" should be "play", got "${config.boosterType}"`);
  if (!config.slots || !Array.isArray(config.slots)) {
    errors.push('Missing or invalid "slots" array');
    return { valid: false, errors, warnings };
  }

  // Slot validation
  const totalCards = config.slots.reduce((sum, s) => sum + (s.count || 0), 0);
  if (totalCards === 13) {
    // standard
  } else if (totalCards === 14) {
    warnings.push(`Pack has ${totalCards} cards (non-standard but valid for sets with bonus slots)`);
  } else {
    errors.push(`Pack has ${totalCards} cards (expected 13 standard or 14 with bonus slot)`);
  }

  const slotNames = new Set();
  for (const slot of config.slots) {
    if (!slot.name) errors.push('Slot missing "name"');
    if (slot.name && slotNames.has(slot.name)) errors.push(`Duplicate slot name: ${slot.name}`);
    if (slot.name) slotNames.add(slot.name);

    if (slot.count === undefined) errors.push(`Slot "${slot.name}" missing "count"`);
    if (!slot.pool) errors.push(`Slot "${slot.name}" missing "pool"`);

    if (slot.pool && !slot.bonusSet) {
      Object.entries(slot.pool).forEach(([foilType, ranges]) => {
        if (!Array.isArray(ranges)) {
          errors.push(`Slot "${slot.name}" pool.${foilType} should be an array`);
          return;
        }
        ranges.forEach(r => {
          const parsed = parseRange(r);
          if (!parsed) errors.push(`Slot "${slot.name}" invalid range: "${r}"`);
          else if (parsed.start > parsed.end) errors.push(`Slot "${slot.name}" range "${r}" start > end`);
          else if (parsed.start < 1) errors.push(`Slot "${slot.name}" range "${r}" starts below 1`);
        });
      });
    }

    if (slot.mythicRate !== undefined) {
      if (typeof slot.mythicRate !== 'number' || slot.mythicRate < 0 || slot.mythicRate > 1) {
        errors.push(`Slot "${slot.name}" mythicRate out of range`);
      }
    }
  }

  // Scryfall cross-validation
  console.error(`Fetching Scryfall data for ${setCode}...`);
  const setInfo = await fetchSetInfo(setCode);
  const cards = await fetchAllCards(setCode);

  // Check max CN doesn't exceed card_count
  let maxCN = 0;
  config.slots.forEach(slot => {
    if (!slot.pool || slot.bonusSet) return;
    Object.values(slot.pool).forEach(ranges => {
      if (!Array.isArray(ranges)) return;
      ranges.forEach(r => {
        const parsed = parseRange(r);
        if (parsed && parsed.end > maxCN) maxCN = parsed.end;
      });
    });
  });

  if (maxCN > setInfo.card_count) {
    errors.push(`Max CN ${maxCN} exceeds Scryfall card_count ${setInfo.card_count}`);
  }

  // Check land slot contains actual lands
  const landSlot = config.slots.find(s => s.name === 'land');
  if (landSlot) {
    const landCNs = getAllCNsFromSlot(landSlot);
    const actualLandCNs = new Set(
      cards
        .filter(c => c.type_line && c.type_line.includes('Basic Land'))
        .map(c => parseInt(c.collector_number, 10))
        .filter(n => !isNaN(n))
    );
    let hasLand = false;
    for (const cn of landCNs) {
      if (actualLandCNs.has(cn)) { hasLand = true; break; }
    }
    if (!hasLand && landCNs.size > 0) {
      errors.push('Land slot CN ranges contain no basic lands');
    }
  } else {
    warnings.push('No "land" slot found');
  }

  // Check rarity pools have reasonable sizes
  const rareSlot = config.slots.find(s => s.name === 'rare');
  const uncommonSlot = config.slots.find(s => s.name === 'uncommon');
  const commonSlot = config.slots.find(s => s.name === 'common');

  if (rareSlot) {
    const rareCNs = getAllCNsFromSlot(rareSlot);
    const rareCards = cards.filter(c => {
      const cn = parseInt(c.collector_number, 10);
      return rareCNs.has(cn) && (c.rarity === 'rare' || c.rarity === 'mythic');
    });
    if (rareCards.length < 10) warnings.push(`Only ${rareCards.length} rare/mythic cards in rare slot pool`);
  }

  if (uncommonSlot) {
    const ucCNs = getAllCNsFromSlot(uncommonSlot);
    const ucCards = cards.filter(c => {
      const cn = parseInt(c.collector_number, 10);
      return ucCNs.has(cn) && c.rarity === 'uncommon';
    });
    if (ucCards.length < 20) warnings.push(`Only ${ucCards.length} uncommon cards in uncommon slot pool`);
  }

  if (commonSlot) {
    const cCNs = getAllCNsFromSlot(commonSlot);
    const cCards = cards.filter(c => {
      const cn = parseInt(c.collector_number, 10);
      return cCNs.has(cn) && c.rarity === 'common';
    });
    if (cCards.length < 30) warnings.push(`Only ${cCards.length} common cards in common slot pool`);
  }

  // Coverage check: are there booster-eligible cards not covered by any slot?
  const allConfigCNs = new Set();
  config.slots.forEach(slot => {
    const cns = getAllCNsFromSlot(slot);
    cns.forEach(cn => allConfigCNs.add(cn));
  });

  const boosterEligible = cards.filter(c => c.booster);
  const uncoveredCards = boosterEligible.filter(c => {
    const cn = parseInt(c.collector_number, 10);
    return !isNaN(cn) && !allConfigCNs.has(cn);
  });
  if (uncoveredCards.length > 0) {
    const byCategory = {};
    uncoveredCards.forEach(c => {
      const frames = (c.frame_effects || []).join('+') || 'none';
      const key = `${c.rarity} ${frames}`;
      if (!byCategory[key]) byCategory[key] = [];
      byCategory[key].push(c.collector_number);
    });
    const details = Object.entries(byCategory).map(([k, cns]) => `${k}: CN ${cns.join(',')}`).join('; ');
    warnings.push(`${uncoveredCards.length} booster-eligible cards not in any slot pool: ${details}`);
  }

  // Collector-exclusive check: cards in config that should NOT be in play boosters
  const COLLECTOR_PROMOS = new Set([
    'fracturefoil', 'texturedfoil', 'textured', 'ripplefoil',
    'halofoil', 'confettifoil', 'galaxyfoil', 'surgefoil',
    'raisedfoil', 'serialized', 'manafoil', 'invisibleink',
    'headliner',
  ]);
  const COLLECTOR_FRAMES = new Set(['extendedart']);

  // Only check booster:false if the set has a meaningful split (not all-false like UB sets)
  const boosterTrueCount = cards.filter(c => c.booster === true).length;
  const boosterFalseCount = cards.filter(c => c.booster === false).length;
  const hasBoosterData = boosterTrueCount > 0 && boosterTrueCount > boosterFalseCount * 0.2;

  const nonBoosterInConfig = cards.filter(c => {
    const cn = parseInt(c.collector_number, 10);
    return !isNaN(cn) && allConfigCNs.has(cn) && c.booster === false;
  });
  if (nonBoosterInConfig.length > 0) {
    // Filter out UB-only false positives (universesbeyond promo_type without collector-exclusive markers)
    const suspicious = nonBoosterInConfig.filter(c => {
      const promos = c.promo_types || [];
      const frames = c.frame_effects || [];
      const hasCollectorMarker = promos.some(p => COLLECTOR_PROMOS.has(p)) || frames.some(f => COLLECTOR_FRAMES.has(f));
      const isUBSet = promos.includes('universesbeyond');
      const isBoosterFun = promos.includes('boosterfun');
      return !((isUBSet || isBoosterFun) && !hasCollectorMarker);
    });
    if (suspicious.length > 0) {
      const samples = suspicious.slice(0, 10).map(c =>
        `CN ${c.collector_number} ${c.name} (${(c.promo_types || []).join(',')})`
      );
      warnings.push(`${suspicious.length} non-UB cards with booster:false in config — verify manually: ${samples.join('; ')}`);
    }
  }

  const collectorExclusiveInConfig = cards.filter(c => {
    const cn = parseInt(c.collector_number, 10);
    if (isNaN(cn) || !allConfigCNs.has(cn)) return false;
    const promos = c.promo_types || [];
    const frames = c.frame_effects || [];
    return promos.some(p => COLLECTOR_PROMOS.has(p)) || frames.some(f => COLLECTOR_FRAMES.has(f));
  });
  if (collectorExclusiveInConfig.length > 0) {
    const samples = collectorExclusiveInConfig.slice(0, 10).map(c => {
      const markers = [...(c.promo_types || []), ...(c.frame_effects || [])].join(',');
      return `CN ${c.collector_number} ${c.name} (${markers})`;
    });
    errors.push(`${collectorExclusiveInConfig.length} collector-exclusive cards in config: ${samples.join('; ')}`);
  }

  // Index check
  const indexPath = path.join(__dirname, '..', 'index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  if (!index.boosters[setCode] || !index.boosters[setCode].includes('play')) {
    warnings.push('Set not found in index.json with "play" type');
  }

  const valid = errors.length === 0;
  return { valid, errors, warnings };
}

async function main() {
  const setCode = process.argv[2];
  if (!setCode) {
    console.error('Usage: node validate-generated.js <set-code>');
    process.exit(1);
  }

  const result = await validate(setCode.toLowerCase());
  console.log(JSON.stringify(result, null, 2));

  if (result.errors.length > 0) {
    console.error(`ERRORS: ${result.errors.join('; ')}`);
  }
  if (result.warnings.length > 0) {
    console.error(`WARNINGS: ${result.warnings.join('; ')}`);
  }

  process.exit(result.valid ? 0 : 1);
}

main().catch(e => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
