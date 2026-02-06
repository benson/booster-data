const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const boostersDir = path.join(__dirname, 'boosters');
const indexPath = path.join(__dirname, 'index.json');

let errors = [];
let warnings = [];
let infos = [];

const args = process.argv.slice(2);
const checkUrls = args.includes('--check-urls');
const checkScryfall = args.includes('--check-scryfall');
const verbose = args.includes('--verbose') || args.includes('-v');

function parseRange(range) {
  const match = range.match(/^(\d+)-(\d+)$/);
  if (match) return { start: parseInt(match[1]), end: parseInt(match[2]) };
  const single = range.match(/^(\d+)$/);
  if (single) return { start: parseInt(single[1]), end: parseInt(single[1]) };
  return null;
}

function getMaxCN(data) {
  let max = 0;
  data.slots.forEach(slot => {
    if (!slot.pool || slot.bonusSet) return; // skip bonus set slots
    Object.values(slot.pool).forEach(ranges => {
      if (Array.isArray(ranges)) {
        ranges.forEach(r => {
          const parsed = parseRange(r);
          if (parsed && parsed.end > max) max = parsed.end;
        });
      }
    });
  });
  return max;
}

function validateFile(filePath) {
  const fileName = path.basename(filePath);
  let data;

  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    errors.push(`${fileName}: Invalid JSON - ${e.message}`);
    return null;
  }

  // Required fields
  if (!data.set) errors.push(`${fileName}: Missing "set" field`);
  if (!data.setName) errors.push(`${fileName}: Missing "setName" field`);
  if (!data.boosterType) errors.push(`${fileName}: Missing "boosterType" field`);
  if (!data.slots || !Array.isArray(data.slots)) {
    errors.push(`${fileName}: Missing or invalid "slots" array`);
    return data;
  }

  // Source field
  if (!data.source) {
    warnings.push(`${fileName}: Missing "source" field`);
  }

  // Validate filename matches content
  const expectedFileName = `${data.set}-${data.boosterType}.json`;
  if (fileName !== expectedFileName) {
    errors.push(`${fileName}: Filename doesn't match content (expected ${expectedFileName})`);
  }

  // Validate each slot
  const slotNames = new Set();
  data.slots.forEach((slot, i) => {
    if (!slot.name) {
      errors.push(`${fileName}: Slot ${i} missing "name"`);
    } else {
      if (slotNames.has(slot.name)) {
        warnings.push(`${fileName}: Duplicate slot name "${slot.name}"`);
      }
      slotNames.add(slot.name);
    }

    if (slot.count === undefined) {
      errors.push(`${fileName}: Slot "${slot.name || i}" missing "count"`);
    } else if (typeof slot.count !== 'number' || slot.count < 0) {
      errors.push(`${fileName}: Slot "${slot.name || i}" count should be a positive number`);
    }

    if (!slot.pool) {
      errors.push(`${fileName}: Slot "${slot.name || i}" missing "pool"`);
      return;
    }

    // Validate CN ranges within pool
    Object.entries(slot.pool).forEach(([foilType, ranges]) => {
      if (!Array.isArray(ranges)) {
        errors.push(`${fileName}: Slot "${slot.name}" pool.${foilType} should be an array`);
        return;
      }

      ranges.forEach(range => {
        const parsed = parseRange(range);
        if (!parsed) {
          errors.push(`${fileName}: Slot "${slot.name}" invalid range format: "${range}"`);
        } else if (parsed.start > parsed.end) {
          errors.push(`${fileName}: Slot "${slot.name}" range "${range}" has start > end`);
        } else if (parsed.start < 1) {
          errors.push(`${fileName}: Slot "${slot.name}" range "${range}" starts below 1`);
        }
      });
    });

    // Validate rarities field if present
    if (slot.rarities) {
      if (!Array.isArray(slot.rarities)) {
        errors.push(`${fileName}: Slot "${slot.name}" rarities should be an array`);
      } else {
        const validRarities = ['common', 'uncommon', 'rare', 'mythic', 'special', 'bonus'];
        slot.rarities.forEach(r => {
          if (!validRarities.includes(r)) {
            warnings.push(`${fileName}: Slot "${slot.name}" unknown rarity "${r}"`);
          }
        });
      }
    }

    // Validate mythicRate if present
    if (slot.mythicRate !== undefined) {
      if (typeof slot.mythicRate !== 'number' || slot.mythicRate < 0 || slot.mythicRate > 1) {
        errors.push(`${fileName}: Slot "${slot.name}" mythicRate should be between 0 and 1`);
      }
      if (!slot.rarities || !slot.rarities.includes('mythic')) {
        warnings.push(`${fileName}: Slot "${slot.name}" has mythicRate but no mythic rarity`);
      }
    }

    // Validate pullRate if present
    if (slot.pullRate !== undefined) {
      if (typeof slot.pullRate !== 'number' || slot.pullRate < 0 || slot.pullRate > 1) {
        errors.push(`${fileName}: Slot "${slot.name}" pullRate should be between 0 and 1`);
      }
    }

    // Validate bonusSet if present
    if (slot.bonusSet && typeof slot.bonusSet !== 'string') {
      errors.push(`${fileName}: Slot "${slot.name}" bonusSet should be a string`);
    }
  });

  return data;
}

function validateIndex() {
  let index;
  try {
    index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch (e) {
    errors.push(`index.json: Invalid JSON - ${e.message}`);
    return;
  }

  const actualFiles = fs.readdirSync(boostersDir).filter(f => f.endsWith('.json'));
  const indexedFiles = new Set();

  // Check all indexed files exist
  Object.entries(index.boosters).forEach(([set, types]) => {
    if (!Array.isArray(types)) {
      errors.push(`index.json: "${set}" should have an array of types`);
      return;
    }
    types.forEach(type => {
      const fileName = `${set}-${type}.json`;
      indexedFiles.add(fileName);
      const filePath = path.join(boostersDir, fileName);
      if (!fs.existsSync(filePath)) {
        errors.push(`index.json: References "${fileName}" but file doesn't exist`);
      }
    });
  });

  // Check all actual files are indexed
  actualFiles.forEach(fileName => {
    if (!indexedFiles.has(fileName)) {
      warnings.push(`${fileName}: Not listed in index.json`);
    }
  });

  return index;
}

function validateCollectorSupersets() {
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));

  Object.entries(index.boosters).forEach(([set, types]) => {
    if (!types.includes('collector')) return;

    const draftType = types.find(t => ['draft', 'play', 'set'].includes(t));
    if (!draftType) return;

    const collectorPath = path.join(boostersDir, `${set}-collector.json`);
    const draftPath = path.join(boostersDir, `${set}-${draftType}.json`);

    if (!fs.existsSync(collectorPath) || !fs.existsSync(draftPath)) return;

    const collector = JSON.parse(fs.readFileSync(collectorPath, 'utf8'));
    const draft = JSON.parse(fs.readFileSync(draftPath, 'utf8'));

    function getAllRanges(data) {
      const ranges = new Set();
      data.slots.forEach(slot => {
        if (!slot.pool || slot.bonusSet) return;
        Object.values(slot.pool).forEach(poolRanges => {
          if (Array.isArray(poolRanges)) {
            poolRanges.forEach(r => {
              const parsed = parseRange(r);
              if (parsed) {
                for (let i = parsed.start; i <= parsed.end; i++) {
                  ranges.add(i);
                }
              }
            });
          }
        });
      });
      return ranges;
    }

    const collectorCNs = getAllRanges(collector);
    const draftCNs = getAllRanges(draft);

    const missingCNs = [];
    draftCNs.forEach(cn => {
      if (!collectorCNs.has(cn)) {
        missingCNs.push(cn);
      }
    });

    if (missingCNs.length > 0) {
      const min = Math.min(...missingCNs);
      const max = Math.max(...missingCNs);
      const likelyBasicLands = min >= 250 && max <= 320;
      if (!likelyBasicLands) {
        warnings.push(`${set}: Draft CNs ${min}-${max} not in collector booster`);
      }
    }
  });
}

function validateBoosterTypeCoverage() {
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));

  // Sets that should have collector boosters (2019+)
  const setsWithCollectors = new Set();
  const modernSets = [
    'eld', 'thb', 'iko', 'm21', 'znr', 'khm', 'stx', 'afr', 'mid', 'vow',
    'neo', 'snc', 'dmu', 'bro', 'one', 'mom', 'woe', 'lci', 'mkm', 'otj',
    'mh3', 'blb', 'dsk', 'fdn', 'acr', 'dft', 'tdm', 'fin', 'inr', 'tla',
    'eoe', 'spm', 'ecl', 'ltr', 'mh2'
  ];

  modernSets.forEach(set => {
    if (index.boosters[set] && !index.boosters[set].includes('collector')) {
      warnings.push(`${set}: Modern set missing collector booster file`);
    }
  });

  // Check for sets with collector but no draft/play/set
  Object.entries(index.boosters).forEach(([set, types]) => {
    if (types.includes('collector')) {
      const hasDraftType = types.some(t => ['draft', 'play', 'set'].includes(t));
      if (!hasDraftType) {
        warnings.push(`${set}: Has collector booster but no draft/play/set booster`);
      }
    }
  });
}

async function checkUrl(url) {
  return new Promise((resolve) => {
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.request(url, { method: 'HEAD', timeout: 10000 }, (res) => {
      resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 400 });
    });
    req.on('error', () => resolve({ status: 0, ok: false }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, ok: false }); });
    req.end();
  });
}

async function validateSourceUrls() {
  console.log('Checking source URLs (this may take a while)...\n');
  const files = fs.readdirSync(boostersDir).filter(f => f.endsWith('.json'));
  const urlCache = new Map();

  for (const fileName of files) {
    const data = JSON.parse(fs.readFileSync(path.join(boostersDir, fileName), 'utf8'));
    if (!data.source) continue;

    if (urlCache.has(data.source)) {
      const cached = urlCache.get(data.source);
      if (!cached.ok) {
        warnings.push(`${fileName}: Source URL unreachable (${cached.status})`);
      }
      continue;
    }

    const result = await checkUrl(data.source);
    urlCache.set(data.source, result);

    if (!result.ok) {
      warnings.push(`${fileName}: Source URL unreachable (${result.status || 'timeout'})`);
    } else if (verbose) {
      infos.push(`${fileName}: Source URL OK`);
    }
  }
}

async function fetchScryfall(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function validateScryfallCardCounts() {
  console.log('Checking CN ranges against Scryfall (this may take a while)...\n');
  const files = fs.readdirSync(boostersDir).filter(f => f.endsWith('.json'));
  const setCache = new Map();

  for (const fileName of files) {
    const data = JSON.parse(fs.readFileSync(path.join(boostersDir, fileName), 'utf8'));
    const setCode = data.set;

    if (!setCache.has(setCode)) {
      try {
        // Rate limit: Scryfall asks for 50-100ms between requests
        await new Promise(r => setTimeout(r, 100));
        const setData = await fetchScryfall(`https://api.scryfall.com/sets/${setCode}`);
        setCache.set(setCode, setData);
      } catch (e) {
        warnings.push(`${fileName}: Could not fetch Scryfall data for set ${setCode}`);
        continue;
      }
    }

    const setData = setCache.get(setCode);
    const maxCN = getMaxCN(data);

    if (maxCN > setData.card_count) {
      errors.push(`${fileName}: Max CN ${maxCN} exceeds Scryfall card_count ${setData.card_count}`);
    } else if (verbose) {
      infos.push(`${fileName}: Max CN ${maxCN} within Scryfall count ${setData.card_count}`);
    }
  }
}

// Main
async function main() {
  console.log('Validating booster-data...');
  if (checkUrls) console.log('  --check-urls enabled');
  if (checkScryfall) console.log('  --check-scryfall enabled');
  console.log('');

  const files = fs.readdirSync(boostersDir).filter(f => f.endsWith('.json'));
  files.forEach(f => validateFile(path.join(boostersDir, f)));

  validateIndex();
  validateCollectorSupersets();
  validateBoosterTypeCoverage();

  if (checkUrls) {
    await validateSourceUrls();
  }

  if (checkScryfall) {
    await validateScryfallCardCounts();
  }

  // Report results
  if (errors.length === 0 && warnings.length === 0) {
    console.log('All validations passed!');
  } else {
    if (errors.length > 0) {
      console.log(`ERRORS (${errors.length}):`);
      errors.forEach(e => console.log(`  - ${e}`));
      console.log('');
    }
    if (warnings.length > 0) {
      console.log(`WARNINGS (${warnings.length}):`);
      warnings.forEach(w => console.log(`  - ${w}`));
      console.log('');
    }
  }

  if (verbose && infos.length > 0) {
    console.log(`INFO (${infos.length}):`);
    infos.forEach(i => console.log(`  - ${i}`));
  }

  process.exit(errors.length > 0 ? 1 : 0);
}

main();
