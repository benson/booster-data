# Booster Data Completeness Plan

Goal: Make booster-data the 100% accurate source for which cards can be opened in which packs.

## Current State

- **213 booster files** across 165 sets
- **27 files missing source URLs** (unverified)
- Good coverage for 2020+ standard sets
- Older sets have basic draft files but likely incomplete ranges

## Priority Tiers

### Tier 1: High Priority (Current Standard + Popular Formats)
Modern-legal sets that players actively open and need accurate data for.

**1.1 Verify 2024+ Play Booster sets (16 sets)**
All have play + collector files. Need to verify CN ranges against collecting articles.
- [x] MKM, OTJ, BLB, FDN, DSK, TDM, TLA, EOE, INR, FIN (fixed in previous session)
- [ ] MH3 - needs verification
- [ ] LCI - needs verification
- [ ] ACR - needs verification (Universes Beyond)
- [ ] DFT - needs verification
- [ ] SPM - needs verification (Universes Beyond)
- [ ] ECL - [x] verified

**1.2 Verify 2020-2023 Draft+Set Booster sets (14 sets)**
All have draft + set + collector files. Need to:
- Verify draft booster CN ranges include showcase/borderless
- Verify set booster CN ranges (often include more variants than draft)
- Verify set booster "The List" slot handling

Sets: ZNR, KHM, STX, AFR, MID, VOW, NEO, SNC, DMU, BRO, ONE, MOM, WOE, LTR

Status from previous session:
- [x] AFR, KHM, ELD, MID, VOW, SNC, MH2, M21, WOE (draft ranges fixed)
- [ ] ZNR, STX, NEO, DMU, BRO, ONE, MOM, LTR (need verification)
- [ ] All set booster files need verification

**1.3 Add source URLs to files missing them (27 files)**
Priority order:
1. Modern Horizons sets (MH1) - popular for drafting
2. Masters sets (2XM, 2X2, DMR, RVR, etc.) - still drafted
3. Commander draft sets (CMR, CLB, CMM)
4. Un-sets and older specialty products

### Tier 2: Medium Priority (Older Standard, Masters)

**2.1 Pre-2020 Standard sets with collector boosters**
- ELD, THB, IKO, M21 (partial coverage exists)
- Need to verify draft ranges include showcase treatments

**2.2 Masters/Remaster sets**
These have unique structures (VIP packs, box toppers, etc.)
- 2XM, 2X2 - need VIP/box topper modeling
- DMR, RVR, TSR - remaster sets
- UMA, A25, IMA, MM3, EMA, MM2, MMA - older masters

**2.3 Commander draft sets**
Unique structure with commander-specific slots
- CMR, CLB, CMM - need proper slot modeling

### Tier 3: Lower Priority (Older/Niche)

**3.1 Pre-ELD Standard sets**
Sets before collector boosters existed. Simple draft structure.
- WAR, RNA, GRN, M19, DOM, RIX, XLN, etc.
- 90+ sets going back to Alpha

**3.2 Specialty products**
- Jumpstart (JMP, J22, J25) - themed half-deck packs
- Conspiracy (CNS, CN2) - multiplayer draft
- Battlebond (BBD) - two-headed giant draft
- Un-sets (UGL, UNH, UST, UNF)

### Tier 4: Bonus Sheets & Special Slots

**4.1 Model bonus sheet slots properly**
Many sets have "bonus sheet" cards from separate mini-sets:
- WOE has WOT (Enchanting Tales)
- OTJ has OTP (Breaking News) + BIG (The Big Score)
- MOM has MUL (Multiverse Legends)
- BRO has BRR (Retro Artifacts)
- STA (Mystical Archive) in STX
- etc.

**4.2 "The List" slot**
Set boosters (2020-2023) had a slot for reprints from "The List"
- Changes each set
- Low pull rate (~25% of set boosters)
- Need to decide if/how to model

**4.3 Serialized cards**
Some sets have serialized cards (001/500 etc.)
- Currently excluded from ranges (correct)
- Could add metadata about existence/odds

## Verification Process

For each file:

1. **Find the source** - WotC "Collecting [Set Name]" article
2. **Document the URL** in the `source` field
3. **Map CN ranges** from the article:
   - Main set cards
   - Showcase/borderless treatments
   - Basic land variants
   - What's in play/draft vs collector-only
4. **Cross-reference** with Scryfall for CN boundaries (but don't trust `booster:true`)
5. **Test** with real pack openings if possible

## Data Model Improvements

Consider adding:
- `verified: true/false` field to indicate confidence level
- `lastVerified: "2024-01-15"` date field
- `bonusSheets: [{ set: "wot", slot: "enchantingTales" }]` for proper bonus sheet modeling
- `notes` field for edge cases and caveats

## Files to Create

Missing files that should exist:
- Jumpstart 2025 (J25) when released
- Any new Universes Beyond sets
- Set booster files for sets that only have draft (if meaningfully different)

## Automated Validation Ideas

Since Scryfall `booster:true` is unreliable, consider:
- Schema validation (all required fields present)
- CN range overlap detection (no gaps or overlaps within a file)
- Cross-file consistency (collector ranges should be superset of play ranges)
- Source URL validation (URLs still work)

## Next Steps

1. Start with Tier 1.1 - verify remaining 2024+ play booster sets
2. Add source URLs to the 27 missing files
3. Verify Tier 1.2 draft ranges for 2020-2023 sets
4. Model bonus sheets consistently
5. Work through Tier 2 as time permits
