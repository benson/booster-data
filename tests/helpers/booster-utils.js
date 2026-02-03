const fs = require('fs');
const path = require('path');

const BOOSTERS_DIR = path.join(__dirname, '../../boosters');

/**
 * Load a booster JSON file
 * @param {string} setCode - The set code (e.g., 'dsk')
 * @param {string} boosterType - The booster type (e.g., 'draft', 'collector', 'play')
 * @returns {object|null} The booster data or null if not found
 */
function loadBooster(setCode, boosterType) {
  const filename = `${setCode}-${boosterType}.json`;
  const filepath = path.join(BOOSTERS_DIR, filename);

  if (!fs.existsSync(filepath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}

/**
 * Check if a collector number is within a range string
 * @param {string|number} cn - The collector number to check
 * @param {string} rangeStr - The range string (e.g., '1-269' or '301')
 * @returns {boolean}
 */
function isInRange(cn, rangeStr) {
  const num = parseInt(cn, 10);

  if (rangeStr.includes('-')) {
    const [start, end] = rangeStr.split('-').map(Number);
    return num >= start && num <= end;
  } else {
    // Single number range
    return num === parseInt(rangeStr, 10);
  }
}

/**
 * Check if a collector number appears in any pool of a booster
 * @param {object} boosterData - The booster JSON data
 * @param {string|number} collectorNumber - The collector number to check
 * @returns {boolean}
 */
function isCardInAnyPool(boosterData, collectorNumber) {
  if (!boosterData || !boosterData.slots) {
    return false;
  }

  for (const slot of boosterData.slots) {
    if (!slot.pool) continue;

    for (const [foilType, ranges] of Object.entries(slot.pool)) {
      if (!Array.isArray(ranges)) continue;

      for (const range of ranges) {
        if (isInRange(collectorNumber, range)) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Get all booster types available for a set
 * @param {string} setCode - The set code
 * @returns {string[]} Array of booster types
 */
function getAvailableBoosterTypes(setCode) {
  const types = [];
  const possibleTypes = ['draft', 'play', 'collector', 'jumpstart', 'set'];

  for (const type of possibleTypes) {
    const filepath = path.join(BOOSTERS_DIR, `${setCode}-${type}.json`);
    if (fs.existsSync(filepath)) {
      types.push(type);
    }
  }

  return types;
}

module.exports = {
  loadBooster,
  isInRange,
  isCardInAnyPool,
  getAvailableBoosterTypes,
  BOOSTERS_DIR
};
