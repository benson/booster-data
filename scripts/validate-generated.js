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

async function scryfallSetExists(setCode) {
  try {
    const res = await fetch(`https://api.scryfall.com/sets/${setCode}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Detect a plausible bonus-sheet child set on Scryfall — mirrors generate-config.js.
// Used to cross-check that Claude didn't omit a real bonus sheet.
async function detectBonusSheet(setCode) {
  try {
    const res = await fetch('https://api.scryfall.com/sets');
    if (!res.ok) return null;
    const data = await res.json();
    const children = (data.data || []).filter(s =>
      s.parent_set_code === setCode &&
      !s.digital &&
      !['token', 'memorabilia', 'promo'].includes(s.set_type) &&
      (s.card_count || 0) >= 20 &&
      !/token|art series|substitute|promo/i.test(s.name)
    );
    const preferred = children.find(s => ['masters', 'draft_innovation', 'eternal'].includes(s.set_type));
    const pick = preferred || children[0];
    return pick ? pick.code : null;
  } catch {
    return null;
  }
}

// Detect Special Guests CN range for a set's release date — same logic as
// generate-config.js. Used to cross-check Claude's metadata.specialGuests.
async function detectSpecialGuestsRange(setReleasedAt) {
  try {
    let url = 'https://api.scryfall.com/cards/search?q=set%3Aspg&unique=prints&order=set';
    let cards = [];
    while (url) {
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json();
      cards = cards.concat(data.data || []);
      url = data.has_more ? data.next_page : null;
      if (url) await delay(100);
    }
    const matching = cards
      .filter(c => c.released_at === setReleasedAt)
      .map(c => parseInt(c.collector_number, 10))
      .filter(n => !isNaN(n))
      .sort((a, b) => a - b);
    if (matching.length === 0) return null;
    const min = matching[0];
    const max = matching[matching.length - 1];
    if (max - min + 1 > matching.length) return null; // non-contiguous; can't disambiguate
    return [min, max];
  } catch {
    return null;
  }
}

// Compare a new play config's structural shape (slot count, slot names, total card count)
// against the most recent sibling play config. Returns errors only for radical divergence —
// the real signal is "Claude invented or dropped a slot," not minor naming variation.
function compareToSibling(config, setCode) {
  const errors = [];
  const boostersDir = path.join(__dirname, '..', 'boosters');
  const indexPath = path.join(__dirname, '..', 'index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const PLAY_BOOSTER_START = '2024-02-09';

  // Collect candidate sibling configs (other play-era sets we've already verified).
  const siblings = [];
  for (const code of Object.keys(index.boosters)) {
    if (code === setCode) continue;
    if (!index.boosters[code].includes('play')) continue;
    const fp = path.join(boostersDir, `${code}-play.json`);
    if (!fs.existsSync(fp)) continue;
    try {
      const sibling = JSON.parse(fs.readFileSync(fp, 'utf8'));
      siblings.push(sibling);
    } catch { /* skip unreadable */ }
  }

  if (siblings.length === 0) return errors; // no peers to compare to

  const siblingSlotCounts = siblings.map(s => s.slots.length);
  const median = [...siblingSlotCounts].sort((a, b) => a - b)[Math.floor(siblingSlotCounts.length / 2)];
  if (Math.abs(config.slots.length - median) >= 3) {
    errors.push(`Slot count ${config.slots.length} diverges sharply from sibling median ${median} — likely hallucinated structure`);
  }

  // Common slot names that appear in nearly every play booster
  const expectedSlots = ['rare', 'uncommon', 'common', 'land', 'wildcard', 'foil'];
  const ourNames = new Set(config.slots.map(s => s.name));
  const missingExpected = expectedSlots.filter(n => !ourNames.has(n));
  if (missingExpected.length > 1) {
    errors.push(`Missing expected slot names: ${missingExpected.join(', ')} — play boosters always include these`);
  }

  return errors;
}

async function validate(setCode, boosterType = 'play') {
  if (boosterType !== 'play' && boosterType !== 'collector') {
    return { valid: false, errors: [`Unsupported boosterType: ${boosterType}`], warnings: [] };
  }

  const errors = [];
  const warnings = [];

  const configPath = path.join(__dirname, '..', 'boosters', `${setCode}-${boosterType}.json`);
  if (!fs.existsSync(configPath)) {
    errors.push(`Config file not found: ${setCode}-${boosterType}.json`);
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
  if (config.boosterType !== boosterType) errors.push(`"boosterType" should be "${boosterType}", got "${config.boosterType}"`);
  if (!config.source) {
    errors.push('Missing "source" field (must be a magic.wizards.com URL)');
  } else if (!/^https:\/\/magic\.wizards\.com\//.test(config.source)) {
    errors.push(`"source" must be a magic.wizards.com URL, got "${config.source}"`);
  }
  if (!config.slots || !Array.isArray(config.slots)) {
    errors.push('Missing or invalid "slots" array');
    return { valid: false, errors, warnings };
  }

  // Pack-size sanity. Play: 13 standard, 14 with bonus slot. Collector: 15 standard.
  const totalCards = config.slots.reduce((sum, s) => sum + (s.count || 0), 0);
  if (boosterType === 'play') {
    if (totalCards === 13 || totalCards === 14) {
      // ok (14 is valid for sets with a dedicated bonus-sheet slot)
    } else {
      errors.push(`Play pack has ${totalCards} cards (expected 13 or 14)`);
    }
  } else {
    // Collector pack sizes vary widely depending on bonus-sheet structure:
    // 15 standard (5+4+4+2), 17 with a 2-card bonus sheet (e.g. otj), 19 with a 3-card
    // bonus sheet + land slot (e.g. sos), and 17 for TMT (5+4+4+1+2+1). The reliable
    // invariant is the core: rareOrMythic + uncommon + common always sum to 13.
    const core = config.slots
      .filter(s => ['rareOrMythic', 'rare', 'uncommon', 'common'].includes(s.name))
      .reduce((sum, s) => sum + (s.count || 0), 0);
    if (core !== 13) {
      errors.push(`Collector core slots (rareOrMythic + uncommon + common) total ${core}, expected 13`);
    }
    if (totalCards < 13 || totalCards > 22) {
      errors.push(`Collector pack has ${totalCards} cards (outside sane 13-22 band)`);
    }
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
      } else if (slot.mythicRate < 0.05 || slot.mythicRate > 0.25) {
        // Real WotC rates cluster around 0.125 (1/8). Anything outside 1/20–1/4 is almost
        // certainly a hallucination — the rate would be either trivially zero or as common
        // as a rare, neither of which has ever shipped.
        errors.push(`Slot "${slot.name}" mythicRate ${slot.mythicRate} outside plausible 0.05–0.25 range`);
      }
    }
  }

  // Sibling-set similarity: the structure of a new play config should look like the
  // most-recent same-era play config. Catches "Claude invented a slot" / "Claude dropped a slot"
  // even when individual CN ranges still parse and exist on Scryfall.
  if (boosterType === 'play') {
    const siblingErrors = compareToSibling(config, setCode);
    errors.push(...siblingErrors);
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

  if (boosterType === 'play') {
    // Land slot must exist and reference real basic lands
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

    // Rarity pool sanity: each slot's CN range should contain enough of the right rarity.
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
  } else {
    // Collector-specific structural checks. The collectorExclusive slot is what
    // downstream consumers (mtg.js, packcracker) treat as authoritative for filtering
    // cards OUT of play caches — getting it wrong silently corrupts play data.
    const collectorExclusive = config.slots.find(s => s.name === 'collectorExclusive');
    if (!collectorExclusive) {
      errors.push('Collector booster missing required "collectorExclusive" slot');
    } else {
      const collectorCNs = getAllCNsFromSlot(collectorExclusive);
      if (collectorCNs.size === 0) {
        errors.push('"collectorExclusive" slot has empty CN ranges');
      } else {
        // Sanity: at least some cards in the collectorExclusive range should actually
        // carry collector-exclusive markers (extendedart frame, fracturefoil promo, etc.).
        // If zero match, the range is pointing at the wrong CNs.
        const COLLECTOR_PROMOS_LOCAL = new Set([
          'fracturefoil', 'texturedfoil', 'textured', 'ripplefoil',
          'halofoil', 'confettifoil', 'galaxyfoil', 'surgefoil',
          'raisedfoil', 'serialized', 'manafoil', 'invisibleink', 'headliner',
        ]);
        const COLLECTOR_FRAMES_LOCAL = new Set(['extendedart']);
        const cardsInRange = cards.filter(c => {
          const cn = parseInt(c.collector_number, 10);
          return !isNaN(cn) && collectorCNs.has(cn);
        });
        const withCollectorMarkers = cardsInRange.filter(c => {
          const promos = c.promo_types || [];
          const frames = c.frame_effects || [];
          return promos.some(p => COLLECTOR_PROMOS_LOCAL.has(p)) ||
                 frames.some(f => COLLECTOR_FRAMES_LOCAL.has(f));
        });
        // Freshly-released sets often lack populated promo metadata on Scryfall — skip.
        const releasedAt = setInfo.released_at ? new Date(setInfo.released_at) : null;
        const days = releasedAt ? (Date.now() - releasedAt.getTime()) / 86400000 : Infinity;
        if (days > 14 && cardsInRange.length > 0 && withCollectorMarkers.length === 0) {
          errors.push(`"collectorExclusive" CN range covers ${cardsInRange.length} cards but none have collector-exclusive markers (extendedart, fracturefoil, etc.) — range likely wrong`);
        }
      }
    }
  }

  // Build the union of all CNs in the config — needed for index check below and for
  // the play-only checks that follow.
  const allConfigCNs = new Set();
  config.slots.forEach(slot => {
    const cns = getAllCNsFromSlot(slot);
    cns.forEach(cn => allConfigCNs.add(cn));
  });

  if (boosterType === 'play') {
    // Coverage check: are there booster-eligible cards not covered by any slot?
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

    // Collector-exclusive cards must NOT appear in a play config.
    const COLLECTOR_PROMOS = new Set([
      'fracturefoil', 'texturedfoil', 'textured', 'ripplefoil',
      'halofoil', 'confettifoil', 'galaxyfoil', 'surgefoil',
      'raisedfoil', 'serialized', 'manafoil', 'invisibleink',
      'headliner',
    ]);
    const COLLECTOR_FRAMES = new Set(['extendedart']);

    // Skip booster:false check entirely for freshly-released sets — Scryfall hasn't
    // populated booster metadata yet, so false-positives would drown real signal.
    const releasedAt = setInfo.released_at ? new Date(setInfo.released_at) : null;
    const daysSinceRelease = releasedAt
      ? (Date.now() - releasedAt.getTime()) / (1000 * 60 * 60 * 24)
      : Infinity;
    const isFreshlyReleased = daysSinceRelease <= 14;

    if (!isFreshlyReleased) {
      const nonBoosterInConfig = cards.filter(c => {
        const cn = parseInt(c.collector_number, 10);
        return !isNaN(cn) && allConfigCNs.has(cn) && c.booster === false;
      });
      if (nonBoosterInConfig.length > 0) {
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
  }

  // Index check
  const indexPath = path.join(__dirname, '..', 'index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  if (!index.boosters[setCode] || !index.boosters[setCode].includes(boosterType)) {
    warnings.push(`Set not found in index.json with "${boosterType}" type`);
  }

  // Cross-check metadata.json against Scryfall. Detection runs unconditionally so we
  // catch the LLM OMITTING metadata (saying null/missing for a real SPG/bonus-sheet set),
  // not just the LLM inventing wrong values. Only run on the play pass to avoid duplicate API calls.
  if (boosterType === 'play') {
  const metaPath = path.join(__dirname, '..', 'metadata.json');
  const metadata = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : { sets: {} };
  const setMeta = metadata.sets?.[setCode] || {};

  // Bonus sheet: check both directions
  if (setMeta.bonusSheet) {
    const bonusSet = await scryfallSetExists(setMeta.bonusSheet);
    if (!bonusSet) {
      errors.push(`metadata.bonusSheet "${setMeta.bonusSheet}" does not resolve to a real Scryfall set`);
    } else if ((bonusSet.card_count || 0) < 20) {
      errors.push(`metadata.bonusSheet "${setMeta.bonusSheet}" only has ${bonusSet.card_count} cards — too small to be a real bonus sheet`);
    }
  } else {
    // No bonus sheet declared — verify Scryfall agrees (no plausible child set looks like one).
    const detectedBonusSheet = await detectBonusSheet(setCode);
    if (detectedBonusSheet) {
      errors.push(`Scryfall has a plausible bonus-sheet child set "${detectedBonusSheet}" for ${setCode} but metadata.bonusSheet is null/missing`);
    }
  }

  // Special Guests: detect always, then compare with what the LLM emitted.
  const detectedSPG = await detectSpecialGuestsRange(setInfo.released_at);
  if (Array.isArray(setMeta.specialGuests) && setMeta.specialGuests.length === 2) {
    if (detectedSPG) {
      const [cMin, cMax] = setMeta.specialGuests;
      const [dMin, dMax] = detectedSPG;
      if (Math.abs(cMin - dMin) > 1 || Math.abs(cMax - dMax) > 1) {
        errors.push(`metadata.specialGuests [${cMin},${cMax}] disagrees with Scryfall-detected SPG range [${dMin},${dMax}] for release date ${setInfo.released_at}`);
      }
    }
    // Detector returned null (multiple sets sharing release date) — trust the LLM.
  } else if (detectedSPG) {
    // Detector found a clean range but Claude omitted it. Almost certainly a hallucinated null.
    errors.push(`Scryfall detected a Special Guests range [${detectedSPG[0]},${detectedSPG[1]}] for release date ${setInfo.released_at} but metadata.specialGuests is null/missing`);
  }
  } // end metadata block (play-only)

  const valid = errors.length === 0;
  return { valid, errors, warnings };
}

async function main() {
  const setCode = process.argv[2];
  const boosterType = process.argv[3] || 'play';
  if (!setCode) {
    console.error('Usage: node validate-generated.js <set-code> [play|collector]');
    process.exit(1);
  }

  const result = await validate(setCode.toLowerCase(), boosterType);
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
