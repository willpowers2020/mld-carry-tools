#!/usr/bin/env node
/**
 * Generate carry-data.json — daily 2DP/3DP carry analysis across all Pick 4 states.
 * Pulls last 50 days of draws from MongoDB, computes transitions with pair dormancy,
 * carry detection, and signal flags.
 *
 * Usage:
 *   MONGO_URL="mongodb+srv://..." node scripts/generate-carry-data.mjs
 *   # or with .env:
 *   node --env-file=../.env scripts/generate-carry-data.mjs
 */

import { MongoClient } from 'mongodb';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..');

const MONGO_URL = process.env.MONGO_URL || process.env.MONGODB_URI;
if (!MONGO_URL) { console.error('Set MONGO_URL or MONGODB_URI'); process.exit(1); }

const DAYS_BACK = 50;

function get2DPs(numArr) {
  const pairs = [];
  for (let i = 0; i < numArr.length; i++)
    for (let j = i + 1; j < numArr.length; j++)
      pairs.push([numArr[i], numArr[j]].sort((a, b) => a - b).join(''));
  return [...new Set(pairs)].sort();
}

function get3DPs(numArr) {
  const trips = [];
  for (let i = 0; i < numArr.length; i++)
    for (let j = i + 1; j < numArr.length; j++)
      for (let k = j + 1; k < numArr.length; k++)
        trips.push([numArr[i], numArr[j], numArr[k]].sort((a, b) => a - b).join(''));
  return [...new Set(trips)].sort();
}

function dateStr(d) {
  return d.toISOString().slice(0, 10);
}

async function main() {
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  const col = client.db('lottery').collection('draws');

  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - DAYS_BACK);
  cutoff.setUTCHours(0, 0, 0, 0);

  console.log(`Fetching pick4 draws since ${dateStr(cutoff)}...`);
  const rawDraws = await col.find({
    game_type: 'pick4',
    date: { $gte: cutoff }
  }).sort({ date: 1, state: 1, tod: 1 }).toArray();

  console.log(`Got ${rawDraws.length} draws`);

  // Group by date
  const byDate = {};
  for (const d of rawDraws) {
    const ds = dateStr(d.date);
    if (!byDate[ds]) byDate[ds] = {};
    const st = (d.state || '').toUpperCase();
    if (!byDate[ds][st]) byDate[ds][st] = [];

    const digits = Array.isArray(d.numbers) ? d.numbers :
      (d.number_str ? d.number_str.split('').map(Number) :
       String(d.normalized || '').split('').map(Number));

    if (digits.length !== 4) continue;

    byDate[ds][st].push({
      num: digits.join(''),
      norm: [...digits].sort((a, b) => a - b).join(''),
      tod: d.tod || null,
      digits
    });
  }

  const dates = Object.keys(byDate).sort();
  console.log(`${dates.length} unique dates: ${dates[0]} → ${dates[dates.length - 1]}`);

  // Build pair history for dormancy lookups
  const pairHistory = {}; // state -> pair -> [date strings]
  const tripHistory = {}; // state -> trip -> [date strings]
  for (const ds of dates) {
    for (const [st, draws] of Object.entries(byDate[ds])) {
      if (!pairHistory[st]) pairHistory[st] = {};
      if (!tripHistory[st]) tripHistory[st] = {};
      for (const d of draws) {
        for (const p of get2DPs(d.digits)) {
          if (!pairHistory[st][p]) pairHistory[st][p] = [];
          pairHistory[st][p].push(ds);
        }
        for (const t of get3DPs(d.digits)) {
          if (!tripHistory[st][t]) tripHistory[st][t] = [];
          tripHistory[st][t].push(ds);
        }
      }
    }
  }

  function pairDormancy(state, pair, beforeDate) {
    const hist = pairHistory[state]?.[pair];
    if (!hist) return null;
    const prior = hist.filter(d => d < beforeDate);
    if (!prior.length) return null;
    const last = prior[prior.length - 1];
    return Math.round((new Date(beforeDate) - new Date(last)) / 86400000);
  }

  function tripDormancy(state, trip, beforeDate) {
    const hist = tripHistory[state]?.[trip];
    if (!hist) return null;
    const prior = hist.filter(d => d < beforeDate);
    if (!prior.length) return null;
    const last = prior[prior.length - 1];
    return Math.round((new Date(beforeDate) - new Date(last)) / 86400000);
  }

  function pairHeat14(state, pair, beforeDate) {
    const hist = pairHistory[state]?.[pair];
    if (!hist) return 0;
    const cutoff = new Date(beforeDate);
    cutoff.setUTCDate(cutoff.getUTCDate() - 14);
    const cutStr = dateStr(cutoff);
    return hist.filter(d => d >= cutStr && d < beforeDate).length;
  }

  // Build transitions
  const transitions = [];
  for (let i = 0; i < dates.length - 1; i++) {
    const d1Date = dates[i];
    const d2Date = dates[i + 1];

    const allStates = new Set([...Object.keys(byDate[d1Date]), ...Object.keys(byDate[d2Date])]);
    const stateResults = [];
    let carryCount = 0, carry3dpCount = 0;
    let signalCount = 0, coldEveCount = 0;

    for (const st of [...allStates].sort()) {
      const d1Draws = byDate[d1Date][st] || [];
      const d2Draws = byDate[d2Date][st] || [];
      if (!d1Draws.length || !d2Draws.length) continue;

      // Get all 2DPs from d1
      const d1Pairs = new Map();
      for (const d of d1Draws) {
        for (const p of get2DPs(d.digits)) {
          if (!d1Pairs.has(p)) {
            d1Pairs.set(p, {
              p,
              d: pairDormancy(st, p, d1Date),
              heat14: pairHeat14(st, p, d1Date),
              tod: d.tod,
              src: d.num
            });
          }
        }
      }

      // Get all 2DPs from d2
      const d2PairSet = new Set();
      for (const d of d2Draws)
        for (const p of get2DPs(d.digits))
          d2PairSet.add(p);

      // Find carried pairs
      const carried = [];
      for (const [p, info] of d1Pairs) {
        if (d2PairSet.has(p)) {
          carried.push({ p, d: info.d, heat14: info.heat14, c: 1, tod: info.tod });
        }
      }

      // 3DP analysis
      const d1Trips = new Map();
      for (const d of d1Draws) {
        for (const t of get3DPs(d.digits)) {
          if (!d1Trips.has(t)) {
            d1Trips.set(t, { p: t, d: tripDormancy(st, t, d1Date), c: 0, tod: d.tod });
          }
        }
      }
      const d2TripSet = new Set();
      for (const d of d2Draws)
        for (const t of get3DPs(d.digits))
          d2TripSet.add(t);

      const carried3dp = [];
      for (const [t, info] of d1Trips) {
        if (d2TripSet.has(t)) {
          carried3dp.push({ p: t, d: info.d, c: 1, tod: info.tod });
        }
      }

      const hasCarry = carried.length > 0;
      const hasCarry3dp = carried3dp.length > 0;
      if (hasCarry) carryCount++;
      if (hasCarry3dp) carry3dpCount++;

      // Signal detection
      const coldPairs = carried.filter(c => c.heat14 === 0 && c.d != null && c.d >= 14);
      const eveSrc = d1Draws.filter(d => (d.tod || '').toLowerCase().includes('even'));
      const eveWin = d2Draws.filter(d => (d.tod || '').toLowerCase().includes('even'));

      let coldEveSignal = false, coldEvePairs = [];
      if (coldPairs.length && eveSrc.length && eveWin.length) {
        const eveSrcPairs = new Set();
        for (const d of eveSrc) for (const p of get2DPs(d.digits)) eveSrcPairs.add(p);
        const eveWinPairs = new Set();
        for (const d of eveWin) for (const p of get2DPs(d.digits)) eveWinPairs.add(p);
        coldEvePairs = coldPairs.filter(c => eveSrcPairs.has(c.p) && eveWinPairs.has(c.p));
        if (coldEvePairs.length) {
          coldEveSignal = true;
          coldEveCount++;
        }
      }

      let signal = false, signalPair = null;
      const singlesSrc = d1Draws.filter(d => {
        const freq = {};
        for (const c of d.digits) freq[c] = (freq[c] || 0) + 1;
        return Math.max(...Object.values(freq)) === 1;
      });
      if (singlesSrc.length && carried.length === 1 && carried[0].d != null && carried[0].d >= 11) {
        signal = true;
        signalPair = carried[0].p;
        signalCount++;
      }

      // Build d1_draws and d2_draws with pair info
      const d1DrawsOut = d1Draws.map(d => ({
        num: d.num,
        tod: d.tod,
        pairs: get2DPs(d.digits).map(p => ({
          p,
          d: pairDormancy(st, p, d1Date),
          heat14: pairHeat14(st, p, d1Date),
          c: d2PairSet.has(p) ? 1 : 0
        })),
        trips: get3DPs(d.digits).map(t => ({
          p: t,
          d: tripDormancy(st, t, d1Date),
          c: d2TripSet.has(t) ? 1 : 0
        }))
      }));

      const d2DrawsOut = d2Draws.map(d => {
        const d2p = get2DPs(d.digits);
        const d2t = get3DPs(d.digits);
        const carriedFromD1 = d2p.filter(p => d1Pairs.has(p));
        const carried3dpFromD1 = d2t.filter(t => d1Trips.has(t));
        return {
          num: d.num,
          tod: d.tod,
          pairs: d2p.map(p => ({
            p,
            d: pairDormancy(st, p, d2Date),
            heat14: pairHeat14(st, p, d2Date),
            c: d1Pairs.has(p) ? 1 : 0
          })),
          trips: d2t.map(t => ({
            p: t,
            d: tripDormancy(st, t, d2Date),
            c: d1Trips.has(t) ? 1 : 0
          })),
          carried_from_d1: carriedFromD1,
          carried_3dp: carried3dpFromD1
        };
      });

      stateResults.push({
        state: st,
        has_carry: hasCarry,
        has_carry_3dp: hasCarry3dp,
        d1_draws: d1DrawsOut,
        d2_draws: d2DrawsOut,
        carried,
        carried_3dp: carried3dp,
        cold_eve_signal: coldEveSignal,
        cold_eve_pairs: coldEvePairs.map(c => c.p),
        signal,
        signal_pair: signalPair
      });
    }

    const totalStates = stateResults.length;
    transitions.push({
      from_date: d1Date,
      to_date: d2Date,
      rate: totalStates ? Math.round(carryCount / totalStates * 1000) / 10 : 0,
      rate_3dp: totalStates ? Math.round(carry3dpCount / totalStates * 1000) / 10 : 0,
      carry_states: carryCount,
      carry_states_3dp: carry3dpCount,
      total_states: totalStates,
      signal_count: signalCount,
      cold_eve_signal_count: coldEveCount,
      states: stateResults
    });
  }

  await client.close();

  // Write carry-data.json
  const outPath = join(OUT_DIR, 'carry-data.json');
  writeFileSync(outPath, JSON.stringify(transitions));
  const sizeMB = (Buffer.byteLength(JSON.stringify(transitions)) / 1024 / 1024).toFixed(1);
  console.log(`\nWrote ${outPath} (${sizeMB}MB, ${transitions.length} transitions)`);
  console.log(`Date range: ${transitions[0]?.from_date} → ${transitions[transitions.length - 1]?.to_date}`);

  // Also write recent-draws.json (draws-index for Carry Explorer)
  const drawsIndex = {};
  for (const ds of dates) {
    drawsIndex[ds] = {};
    for (const [st, draws] of Object.entries(byDate[ds])) {
      drawsIndex[ds][st] = draws.map(d => d.num);
    }
  }
  const drawsPath = join(OUT_DIR, 'recent-draws.json');
  writeFileSync(drawsPath, JSON.stringify(drawsIndex));
  console.log(`Wrote ${drawsPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
