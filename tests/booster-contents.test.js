const { describe, it } = require('node:test');
const assert = require('node:assert');
const { loadBooster, isCardInAnyPool } = require('./helpers/booster-utils');
const testData = require('./fixtures/collector-exclusives.json');

/**
 * Test suite for validating booster card distribution
 *
 * This suite verifies that:
 * 1. Cards documented as being in specific booster types ARE in those boosters
 * 2. Cards documented as being EXCLUDED from specific booster types are NOT in those boosters
 *
 * All test cases are sourced from official "Collecting [Set]" articles from Wizards of the Coast.
 */

describe('Booster Card Distribution Tests', () => {
  for (const setData of testData.testSets) {
    describe(`${setData.setName} (${setData.set.toUpperCase()})`, () => {
      for (const testCase of setData.testCases) {
        // Positive tests: card IS in expected boosters
        for (const boosterType of testCase.inBoosters) {
          it(`${testCase.card} (CN ${testCase.cn}) IS in ${boosterType} booster`, () => {
            const booster = loadBooster(setData.set, boosterType);

            if (!booster) {
              // Skip test if booster file doesn't exist
              console.log(`  Skipping: ${setData.set}-${boosterType}.json not found`);
              return;
            }

            const result = isCardInAnyPool(booster, testCase.cn);
            assert.strictEqual(
              result,
              true,
              `Expected card ${testCase.card} (CN ${testCase.cn}) to be in ${boosterType} booster pools. ` +
              `Source: "${testCase.sourceQuote}" (${setData.source})`
            );
          });
        }

        // Negative tests: card is NOT in excluded boosters
        for (const boosterType of testCase.notInBoosters) {
          it(`${testCase.card} (CN ${testCase.cn}) is NOT in ${boosterType} booster`, () => {
            const booster = loadBooster(setData.set, boosterType);

            if (!booster) {
              // Skip test if booster file doesn't exist
              console.log(`  Skipping: ${setData.set}-${boosterType}.json not found`);
              return;
            }

            const result = isCardInAnyPool(booster, testCase.cn);
            assert.strictEqual(
              result,
              false,
              `Expected card ${testCase.card} (CN ${testCase.cn}) to NOT be in ${boosterType} booster pools. ` +
              `Source: "${testCase.sourceQuote}" (${setData.source})`
            );
          });
        }
      }
    });
  }
});

// Additional utility tests
describe('Helper Function Tests', () => {
  it('isCardInAnyPool returns false for empty booster data', () => {
    assert.strictEqual(isCardInAnyPool(null, '1'), false);
    assert.strictEqual(isCardInAnyPool({}, '1'), false);
    assert.strictEqual(isCardInAnyPool({ slots: [] }, '1'), false);
  });

  it('isCardInAnyPool correctly checks range boundaries', () => {
    const mockBooster = {
      slots: [
        { pool: { nonfoil: ['1-100'] } },
        { pool: { foil: ['200-300'] } }
      ]
    };

    // In range
    assert.strictEqual(isCardInAnyPool(mockBooster, '1'), true);
    assert.strictEqual(isCardInAnyPool(mockBooster, '50'), true);
    assert.strictEqual(isCardInAnyPool(mockBooster, '100'), true);
    assert.strictEqual(isCardInAnyPool(mockBooster, '200'), true);
    assert.strictEqual(isCardInAnyPool(mockBooster, '250'), true);
    assert.strictEqual(isCardInAnyPool(mockBooster, '300'), true);

    // Out of range
    assert.strictEqual(isCardInAnyPool(mockBooster, '0'), false);
    assert.strictEqual(isCardInAnyPool(mockBooster, '101'), false);
    assert.strictEqual(isCardInAnyPool(mockBooster, '199'), false);
    assert.strictEqual(isCardInAnyPool(mockBooster, '301'), false);
  });
});
