# MLD Carry Tools

Interactive tools for analyzing 2DP and 3DP carryover patterns in Pick 4 lottery draws.

## Tools

### [Carry Explorer](https://willpowers2020.github.io/mld-carry-tools/) (`index.html`)
Interactive explorer showing how yesterday's 2-digit pairs (2DP) and 3-digit triples (3DP) carry into today's winners across all US Pick 4 states.

**Features:**
- **Calendar view** — 44 transitions (Oct 1 – Nov 14, 2026) with carry rates and signal counts
- **2DP detail view** — Per-state breakdown showing which pairs carried, dormancy days, and the exact proof
- **3DP detail view** — 3-day window carryover analysis (46.5% average carry rate)
- **4DP Explorer** — Click any pair to see all 4-digit combinations, colored by cross-state recency
- **Signal detection** — Purple badges highlight triple-signal events (Singles + Only Carrier + 11d+ dormancy = 57.9% win rate)

### [2DP Carry Guide](https://willpowers2020.github.io/mld-carry-tools/guide.html) (`guide.html`)
Comprehensive reference guide covering the 2DP carry phenomenon and the dormancy signal discovery.

**Sections:**
- Carry rates by state (FL 94.8%, CA 64.9%, all states)
- Top 15 most-carried pairs and least-carried doubles
- Dormancy signal: 3 independent stacking filters
- "What doesn't matter" — 8 tested parameters with no signal
- Stacked filter combinations table

## Data Files

- `carry-data.json` — Transition data for all states, Oct 1 – Nov 14 2026, with 2DP/3DP carries and signal flags
- `recent-draws.json` — Raw draw data index (Sep 15 – Nov 14 2026) for cross-state recency lookups

## Key Findings

| Signal | Win Rate | Lift | Events |
|--------|----------|------|--------|
| Only 1 carrier | 54.9% | 1.17x | 1,764 |
| 15d+ dormancy | 54.9% | 1.17x | 197 |
| Singles source | 68.7% carry rate | — | — |
| **All three stacked** | **57.9%** | **1.23x** | **197** |

## Part of [MyLottoData](https://mylotterydata.com)
