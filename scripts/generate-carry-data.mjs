#!/usr/bin/env node
/**
 * Generate carry-data.json and recent-draws.json for the Carry Explorer.
 * Runs daily via GitHub Action or manually.
 *
 * Env: MONGODB_URI
 * Output: carry-data.json, recent-draws.json in repo root
 */
import { MongoClient } from 'mongodb';
import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..');

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) { console.error('Missing MONGODB_URI'); process.exit(1); }

const LOOKBACK_DAYS = 60;
const CARRY_WINDOW_DAYS = 45;
const THREE_DP_WINDOW = 3;

function get2DPs(numStr) {
  const digits = numStr.split('');
  const pairs = new Set();
  for (let i = 0; i < digits.length; i++)
    for (let j = i + 1; j < digits.length; j++)
      pairs.add([digits[i], digits[j]].sort().join(''));
  return [...pairs].sort();
}

function get3DPs(numStr) {
  const digits = numStr.split('');
  const trips = new Set();
  for (let i = 0; i < digits.length; i++)
    for (let j = i + 1; j < digits.length; j++)
      for (let k = j + 1; k < digits.length; k++)
        trips.add([digits[i], digits[j], digits[k]].sort().join(''));
  return [...trips].sort();
}

function digitPattern(num) {
  const freq = {};
  for (const c of num) freq[c] = (freq[c] || 0) + 1;
  const vals = Object.values(freq).sort((a, b) => b - a);
  if (vals[0] === 4) return 'Quad';
  if (vals[0] === 3) return 'Triple';
  if (vals[0] === 2 && vals[1] === 2) return 'DblDbl';
  if (vals[0] === 2) return 'Double';
  return 'Single';
}

async function run() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const coll = client.db('lottery').collection('draws');

  const now = new Date();
  const lookbackStart = new Date(now);
  lookbackStart.setDate(lookbackStart.getDate() - LOOKBACK_DAYS);
  const carryStart = new Date(now);
  carryStart.setDate(carryStart.getDate() - CARRY_WINDOW_DAYS);

  const draws = await coll.find({
    game_type: 'pick4',
    date: { $gte: lookbackStart, $lte: now }
  }).sort({ date: 1 }).toArray();

  console.log(`Draws loaded: ${draws.length}`);

  const byDateState = {};
  for (const d of draws) {
    const ds = d.date.toISOString().split('T')[0];
    if (!byDateState[ds]) byDateState[ds] = {};
    if (!byDateState[ds][d.state]) byDateState[ds][d.state] = [];
    const num = d.number_str || d.normalized;
    if (num && num.length === 4) {
      byDateState[ds][d.state].push({
        tod: d.tod || '', num,
        norm: d.normalized || num.split('').sort().join(''),
        game: d.game || ''
      });
    }
  }
  const dates = Object.keys(byDateState).sort();

  // Build pair/trip history
  const state2dpHist = {};
  const state3dpHist = {};
  for (const date of dates) {
    for (const st of Object.keys(byDateState[date])) {
      if (!state2dpHist[st]) state2dpHist[st] = {};
      if (!state3dpHist[st]) state3dpHist[st] = {};
      const seen2 = new Set(), seen3 = new Set();
      for (const entry of byDateState[date][st]) {
        get2DPs(entry.num).forEach(p => seen2.add(p));
        get3DPs(entry.num).forEach(p => seen3.add(p));
      }
      for (const p of seen2) { if (!state2dpHist[st][p]) state2dpHist[st][p] = []; state2dpHist[st][p].push(date); }
      for (const p of seen3) { if (!state3dpHist[st][p]) state3dpHist[st][p] = []; state3dpHist[st][p].push(date); }
    }
  }

  const carryStartStr = carryStart.toISOString().split('T')[0];
  const transitions = [];

  for (let i = 0; i < dates.length - 1; i++) {
    const d1 = dates[i], d2 = dates[i + 1];
    if (d1 < carryStartStr) continue;

    const d2States = byDateState[d2];
    if (!d2States) continue;

    const windowDates = [];
    for (let w = i; w >= 0 && w > i - THREE_DP_WINDOW; w--) windowDates.push(dates[w]);

    const stateResults = [];
    let carryCount2 = 0, carryCount3 = 0, totalCount = 0;

    const allStates = new Set([...Object.keys(byDateState[d1] || {}), ...Object.keys(d2States)]);

    for (const st of allStates) {
      if (!byDateState[d1]?.[st] || !d2States[st]) continue;
      totalCount++;

      const d1Draws = byDateState[d1][st];
      const d2Draws = d2States[st];

      // 2DP carry
      const d1Pairs2 = new Set();
      for (const dr of d1Draws) get2DPs(dr.num).forEach(p => d1Pairs2.add(p));
      const d2Pairs2 = new Set();
      for (const dr of d2Draws) get2DPs(dr.num).forEach(p => d2Pairs2.add(p));
      const carried2 = [...d1Pairs2].filter(p => d2Pairs2.has(p)).sort();

      const carried2WithDorm = carried2.map(p => {
        const hist = state2dpHist[st]?.[p] || [];
        let dorm = null;
        for (let k = hist.length - 1; k >= 0; k--) {
          if (hist[k] < d1) { dorm = Math.round((new Date(d1) - new Date(hist[k])) / 86400000); break; }
        }
        // Heat: how many times this pair appeared in the state in the last 14 days
        let heat14 = 0;
        for (const hd of hist) {
          if (hd >= d1) break;
          const diff = Math.round((new Date(d1) - new Date(hd)) / 86400000);
          if (diff <= 14) heat14++;
        }
        return { p, d: dorm, heat14 };
      });

      // Determine TOD transition for each carried pair
      const carriedTOD = {};
      for (const pair of carried2) {
        for (const d1dr of d1Draws) {
          for (const d2dr of d2Draws) {
            if (get2DPs(d1dr.num).includes(pair) && get2DPs(d2dr.num).includes(pair)) {
              carriedTOD[pair] = `${d1dr.tod || 'unknown'}->${d2dr.tod || 'unknown'}`;
            }
          }
        }
      }
      // Annotate each carried entry with TOD transition
      for (const c of carried2WithDorm) {
        c.tod = carriedTOD[c.p] || null;
      }

      const hasSingles = d1Draws.some(dr => digitPattern(dr.num) === 'Single');
      const onlyCarrier2 = carried2.length === 1;
      const maxDorm2 = carried2WithDorm.length ? Math.max(...carried2WithDorm.map(c => c.d || 0)) : 0;
      const signal2 = hasSingles && onlyCarrier2 && maxDorm2 >= 11;
      // New signals
      const hasColdSignal = carried2WithDorm.some(c => c.heat14 === 0);
      const hasEveSignal = carried2WithDorm.some(c => c.tod === 'Evening->Evening');
      const coldEvePairs = carried2WithDorm.filter(c => c.heat14 === 0 && c.tod === 'Evening->Evening');
      const hasColdEveSignal = coldEvePairs.length > 0;

      if (carried2.length > 0) carryCount2++;

      // 3DP carry
      const windowTrips = new Set();
      const windowDrawsByTrip = {};
      for (const wd of windowDates) {
        if (!byDateState[wd]?.[st]) continue;
        for (const dr of byDateState[wd][st]) {
          for (const t of get3DPs(dr.num)) {
            windowTrips.add(t);
            if (!windowDrawsByTrip[t]) windowDrawsByTrip[t] = [];
            windowDrawsByTrip[t].push({ date: wd, num: dr.num, tod: dr.tod });
          }
        }
      }
      const d2Trips = new Set();
      for (const dr of d2Draws) get3DPs(dr.num).forEach(t => d2Trips.add(t));
      const carried3 = [...windowTrips].filter(t => d2Trips.has(t)).sort();

      const carried3WithInfo = carried3.map(t => {
        const hist = state3dpHist[st]?.[t] || [];
        let dorm = null;
        const srcDate = windowDrawsByTrip[t]?.[0]?.date || d1;
        for (let k = hist.length - 1; k >= 0; k--) {
          if (hist[k] < srcDate) { dorm = Math.round((new Date(srcDate) - new Date(hist[k])) / 86400000); break; }
        }
        return { p: t, d: dorm, src: (windowDrawsByTrip[t] || []).map(s => ({ date: s.date, num: s.num, tod: s.tod })) };
      });

      if (carried3.length > 0) carryCount3++;

      const d1Info = d1Draws.map(dr => ({
        tod: dr.tod, num: dr.num, norm: dr.norm,
        pairs: get2DPs(dr.num).map(p => ({
          p, d: (() => {
            const hist = state2dpHist[st]?.[p] || [];
            for (let k = hist.length - 1; k >= 0; k--) { if (hist[k] < d1) return Math.round((new Date(d1) - new Date(hist[k])) / 86400000); }
            return null;
          })(), c: carried2.includes(p) ? 1 : 0
        })),
        trips: get3DPs(dr.num).map(t => ({ p: t, c: carried3.includes(t) ? 1 : 0 })),
        pattern: digitPattern(dr.num)
      }));

      const d2Info = d2Draws.map(dr => ({
        tod: dr.tod, num: dr.num, norm: dr.norm,
        pairs: get2DPs(dr.num).map(p => ({
          p, d: (() => {
            const hist = state2dpHist[st]?.[p] || [];
            for (let k = hist.length - 1; k >= 0; k--) { if (hist[k] < d2) return Math.round((new Date(d2) - new Date(hist[k])) / 86400000); }
            return null;
          })(), c: carried2.includes(p) ? 1 : 0
        })),
        trips: get3DPs(dr.num).map(t => ({ p: t, c: carried3.includes(t) ? 1 : 0 })),
        carried_from_d1: carried2.filter(p => get2DPs(dr.num).includes(p)),
        carried_3dp: carried3.filter(t => get3DPs(dr.num).includes(t))
      }));

      stateResults.push({
        state: st.toUpperCase(), d1_draws: d1Info, d2_draws: d2Info,
        carried: carried2WithDorm, carried_3dp: carried3WithInfo,
        has_carry: carried2.length > 0, has_carry_3dp: carried3.length > 0,
        signal: signal2, signal_pair: onlyCarrier2 && carried2.length ? carried2[0] : null,
        signal_dorm: maxDorm2, has_singles: hasSingles, only_carrier: onlyCarrier2,
        cold_signal: hasColdSignal, eve_signal: hasEveSignal,
        cold_eve_signal: hasColdEveSignal,
        cold_eve_pairs: coldEvePairs.map(c => c.p)
      });
    }

    stateResults.sort((a, b) => a.state.localeCompare(b.state));
    const rate2 = totalCount ? Math.round(carryCount2 / totalCount * 1000) / 10 : 0;
    const rate3 = totalCount ? Math.round(carryCount3 / totalCount * 1000) / 10 : 0;

    transitions.push({
      from_date: d1, to_date: d2, total_states: totalCount,
      carry_states: carryCount2, carry_states_3dp: carryCount3,
      no_carry_states: totalCount - carryCount2,
      rate: rate2, rate_3dp: rate3,
      signal_count: stateResults.filter(s => s.signal).length,
      cold_signal_count: stateResults.filter(s => s.cold_signal).length,
      eve_signal_count: stateResults.filter(s => s.eve_signal).length,
      cold_eve_signal_count: stateResults.filter(s => s.cold_eve_signal).length,
      window_3dp: THREE_DP_WINDOW, states: stateResults
    });
  }

  // Draws index
  const drawsIndex = {};
  for (const date of dates) {
    if (date < carryStartStr) continue;
    drawsIndex[date] = {};
    for (const st of Object.keys(byDateState[date])) {
      drawsIndex[date][st.toUpperCase()] = byDateState[date][st].map(d => d.num);
    }
  }

  writeFileSync(join(OUT_DIR, 'carry-data.json'), JSON.stringify(transitions));
  writeFileSync(join(OUT_DIR, 'recent-draws.json'), JSON.stringify(drawsIndex));

  const generated = now.toISOString().split('T')[0];
  const first = transitions[0]?.from_date || '?';
  const last = transitions[transitions.length - 1]?.to_date || '?';
  console.log(`Generated: ${transitions.length} transitions (${first} → ${last})`);
  console.log(`Signal events: ${transitions.reduce((s, t) => s + t.signal_count, 0)}`);
  console.log(`3DP carry avg: ${(transitions.reduce((s, t) => s + (t.rate_3dp || 0), 0) / transitions.length).toFixed(1)}%`);

  // Update the date range in index.html
  const { readFileSync } = await import('fs');
  const indexPath = join(OUT_DIR, 'index.html');
  let indexHtml = readFileSync(indexPath, 'utf8');
  const dateRangeRe = /Oct 1 – Nov \d+, 2026|[A-Z][a-z]+ \d+ – [A-Z][a-z]+ \d+, \d{4}/;
  const fmtMonth = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const startD = new Date(first + 'T12:00:00Z');
  const endD = new Date(last + 'T12:00:00Z');
  const rangeStr = `${fmtMonth[startD.getUTCMonth()]} ${startD.getUTCDate()} – ${fmtMonth[endD.getUTCMonth()]} ${endD.getUTCDate()}, ${endD.getUTCFullYear()}`;
  indexHtml = indexHtml.replace(dateRangeRe, rangeStr);
  writeFileSync(indexPath, indexHtml);
  console.log(`Updated date range in index.html: ${rangeStr}`);

  await client.close();
}

run().catch(e => { console.error(e); process.exit(1); });
