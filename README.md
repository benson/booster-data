# booster-data

Accurate collector number (CN) ranges for Magic: The Gathering booster pack contents.

## why

Scryfall's `booster:true` field is unreliable. This project provides verified CN ranges for what cards can actually be opened in each booster type, sourced from official WotC "Collecting" articles.

## structure

```
boosters/
  {set}-{type}.json    # e.g., mkm-play.json, znr-collector.json
index.json             # lists all available files
validate.js            # validation script
```

## booster types

- `draft` - draft boosters (pre-2024 sets)
- `set` - set boosters (2020-2023)
- `play` - play boosters (2024+)
- `collector` - collector boosters
- `jumpstart` - jumpstart packs

## data model

```json
{
  "set": "mkm",
  "setName": "Murders at Karlov Manor",
  "boosterType": "play",
  "source": "https://magic.wizards.com/en/news/feature/collecting-murders-karlov-manor",
  "slots": [
    {
      "name": "rare",
      "count": 1,
      "rarities": ["rare", "mythic"],
      "pool": { "nonfoil": ["1-286"] },
      "mythicRate": 0.125,
      "notes": "main set + showcase"
    }
  ]
}
```

### slot fields

| field | description |
|-------|-------------|
| `name` | slot identifier |
| `count` | number of cards from this slot per pack |
| `rarities` | which rarities can appear (for filtering) |
| `pool` | CN ranges by foil type: `nonfoil`, `foil`, `etched`, `texturedfoil`, etc. |
| `mythicRate` | probability of mythic vs rare (typically 0.125 = 1/8) |
| `pullRate` | probability this slot appears at all (for masterpieces, expeditions) |
| `bonusSet` | set code for bonus sheet cards (e.g., `sta` for Mystical Archive) |
| `notes` | human-readable explanation |

### CN ranges

Ranges are strings: `"1-286"` or `"1-100", "200-250"` for non-contiguous ranges.

## special cases

### bonus sheets

Sets with bonus sheets have a dedicated slot with `bonusSet` referencing the mini-set:
- STX: `sta` (Mystical Archive)
- BRO: `brr` (Retro Artifacts)
- MOM: `mul` (Multiverse Legends)
- WOE: `wot` (Enchanting Tales)
- OTJ: `otp` (Breaking News)

### masterpieces/expeditions

Older sets have masterpiece slots with `pullRate` indicating rarity:
- BFZ/OGW: `exp` Expeditions (~1/144 packs, pullRate: 0.007)
- KLD/AER: `mps` Inventions (~1/144 packs)
- AKH/HOU: `mp2` Invocations (~1/144 packs)
- ZNR collector: `zne` Expeditions (~1/6 packs, pullRate: 0.167)

### attractions (UNF)

Unfinity draft boosters have 2 Attraction cards per pack (CN 200-234).

## validation

```bash
node validate.js                  # basic validation
node validate.js --check-urls     # also check source URLs are reachable
node validate.js --check-scryfall # also verify CN ranges against Scryfall
node validate.js -v               # verbose output
```

Checks:
- required fields present
- CN range format valid
- filename matches set/boosterType content
- collector boosters are supersets of play/draft (excluding basic lands)
- modern sets have collector booster files
- index.json matches actual files
- `--check-urls`: source URLs return 2xx/3xx status
- `--check-scryfall`: max CN doesn't exceed Scryfall card_count

## usage

Fetch a booster file:
```js
const res = await fetch('https://bensonperry.com/booster-data/boosters/mkm-play.json');
const booster = await res.json();
```

Get all available boosters:
```js
const res = await fetch('https://bensonperry.com/booster-data/index.json');
const { boosters } = await res.json();
// boosters = { "mkm": ["collector", "play"], ... }
```

## sources

- 2019+ sets: WotC "Collecting [Set Name]" articles
- Pre-2019 sets: MTG Wiki (mtg.fandom.com)

## not modeled

- **The List**: Changes each set, ~25% in set boosters, uses PLST set code
- **Serialized cards**: Correctly excluded from CN ranges
