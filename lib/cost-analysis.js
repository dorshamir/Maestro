/*
 * Per-folder cost trend detection: flags a project whose spend jumped
 * because sessions quietly started running a pricier model - built on
 * digests.js's per-transcript byDay (the same data the Usage panel's
 * global 7/30-day windows already use) and pricing.js's rate table. A new
 * file rather than an addition to sessions.js/digests.js/pricing.js:
 * requiring lib/sessions.js from either of those would be a circular
 * require (sessions.js already requires both of them for its own rollup).
 */
'use strict';

const { scanSessions } = require('./sessions');
const { getDigest, dayKey } = require('./digests');
const { priceUsage, totalUsd, pricing } = require('./pricing');

// Sums a group of transcripts' own byDay onto one per-day {usd, models}
// series. Testable directly with temp transcript files - getDigest()
// computes fresh from the file itself when it is not already cached, and
// never writes its cache back to disk on its own (same contract the
// existing digest tests already rely on).
function dailyCost(files) {
  const p = pricing();
  const byDay = {};
  for (const file of files) {
    const dg = getDigest(file);
    if (!dg || !dg.byDay) continue;
    for (const [day, d] of Object.entries(dg.byDay)) {
      const entry = byDay[day] || (byDay[day] = { usd: 0, models: {} });
      entry.usd += totalUsd(d.reported, d.multi, d.models, p);
      for (const [m, u] of Object.entries(d.models || {})) {
        entry.models[m] = (entry.models[m] || 0) + priceUsage({ [m]: u }, p);
      }
    }
  }
  return byDay;
}

function shiftDay(day, delta) {
  const [y, m, d] = day.split('-').map(Number);
  return dayKey(new Date(y, m - 1, d + delta).getTime());
}

function windowSum(byDay, days) {
  let usd = 0;
  const models = {};
  for (const d of days) {
    const entry = byDay[d];
    if (!entry) continue;
    usd += entry.usd;
    for (const [m, c] of Object.entries(entry.models)) models[m] = (models[m] || 0) + c;
  }
  return { usd, models };
}

function topModel(models) {
  let best = null, bestUsd = 0;
  for (const [m, c] of Object.entries(models)) if (c > bestUsd) { bestUsd = c; best = m; }
  return best;
}

const MIN_SESSIONS = 4;      // fewer priced sessions than this and a "jump" is just noise
const JUMP_THRESHOLD = 1.6;  // trailing 7-day mean must be at least 60% above the prior 7-day mean

// Pure and deterministic - `today` is a 'YYYY-MM-DD' string passed in
// rather than read from the clock, so this is directly testable. Compares
// the trailing 7 calendar days against the 7 before that; a prior window
// with no spend at all is "new spending," not a regression, so it is not
// flagged - there is nothing to have jumped from.
function detectRegression(byDay, today, totalSessions) {
  if (totalSessions < MIN_SESSIONS) return null;
  const trailingDays = [...Array(7)].map((_, i) => shiftDay(today, -i));
  const priorDays = [...Array(7)].map((_, i) => shiftDay(today, -7 - i));
  const trailing = windowSum(byDay, trailingDays);
  const prior = windowSum(byDay, priorDays);
  if (prior.usd <= 0) return null;
  const ratio = trailing.usd / prior.usd;
  if (ratio < JUMP_THRESHOLD) return null;
  return {
    trailingUsd: trailing.usd, priorUsd: prior.usd, ratio,
    trailingTopModel: topModel(trailing.models), priorTopModel: topModel(prior.models),
  };
}

// Orchestration: HOME-dependent via scanSessions(), so validated live
// rather than unit tested - same boundary as findNearMisses/findGuardGaps
// in lib/guardrail-analysis.js.
function findCostRegressions() {
  const today = dayKey(Date.now());
  const results = [];
  for (const proj of scanSessions()) {
    if (!proj.cwd) continue;
    const byDay = dailyCost(proj.sessions.map((s) => s.file));
    const r = detectRegression(byDay, today, proj.sessions.length);
    if (r) results.push({ cwd: proj.cwd, ...r });
  }
  results.sort((a, b) => b.ratio - a.ratio);
  return results;
}

module.exports = { dailyCost, detectRegression, findCostRegressions };
