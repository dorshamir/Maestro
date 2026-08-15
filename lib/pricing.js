/*
 * What a session would have cost on the API, per model.
 */
'use strict';

const path = require('path');
const { CLAUDE_DIR } = require('./constants');
const { readJsonSafe } = require('./util');

// Rates are keyed by model-FAMILY prefix, not by exact model id. That is the
// whole trick that keeps this table from being a maintenance treadmill: every
// Opus point release starts with "claude-opus-", so a new one is priced
// correctly the day it ships without anyone editing this file. Only a new tier
// (or an actual price change) needs a line here.
//
// USD per million tokens, list price. Anyone on a Pro/Max plan is not billed
// these amounts - the figure is "what this conversation would have cost on the
// API", which is still the only cross-model way to compare two sessions.
const PRICING_FILE = path.join(CLAUDE_DIR, '.maestro-pricing.json');
const PRICING_ASOF = '2026-08-14';
const PRICING_DEFAULTS = {
  cacheWriteMult: 1.25,   // 5-minute cache write
  cacheWrite1hMult: 2.0,  // 1-hour cache write
  cacheReadMult: 0.1,
  models: {
    'claude-fable':  { in: 10, out: 50 },
    'claude-mythos': { in: 10, out: 50 },
    'claude-opus':   { in: 5,  out: 25 },
    // Sonnet 5 launched at an introductory $2/$10 that lapses 2026-08-31 (back
    // to the $3/$15 every other Sonnet - 4.6, 4.5, 4.0 - already charges); a
    // flat 'claude-sonnet' prefix billed all of them at the introductory rate
    // forever, undercharging every non-5 Sonnet by a third. `until` makes
    // rateFor() skip this entry once the intro window closes, falling through
    // to the family rate below - remove the line instead of editing it once
    // that happens, the same as any other tier whose price changes.
    'claude-sonnet-5': { in: 2, out: 10, until: '2026-08-31' },
    'claude-sonnet': { in: 3,  out: 15 },
    'claude-haiku':  { in: 1,  out: 5  },
  },
  // Fast mode runs the same model at premium rates; transcripts record it as
  // usage.speed === 'fast'. Only Opus-tier offers it today.
  fastModels: {
    'claude-opus': { in: 10, out: 50 },
  },
};

let pricingCache = { ts: 0, data: null };
function pricing() {
  const now = Date.now();
  if (pricingCache.data && now - pricingCache.ts < 10_000) return pricingCache.data;
  // A user file overrides per model, it does not replace the table - so pinning
  // one model's price does not silently un-price every other model.
  const override = readJsonSafe(PRICING_FILE) || {};
  const p = {
    ...PRICING_DEFAULTS,
    ...override,
    models: { ...PRICING_DEFAULTS.models, ...(override.models || {}) },
    fastModels: { ...PRICING_DEFAULTS.fastModels, ...(override.fastModels || {}) },
    custom: !!Object.keys(override).length,
  };
  pricingCache = { ts: now, data: p };
  return p;
}

// Model IDs carry dates and point releases; match the longest configured
// prefix. A "|fast" suffix marks fast-mode usage and selects the premium table.
// `now` is only ever overridden by tests - real callers take the wall clock.
function rateFor(modelId, p, now = Date.now()) {
  const raw = String(modelId || '').toLowerCase();
  const fast = raw.endsWith('|fast');
  const id = fast ? raw.slice(0, -5) : raw;
  const table = fast ? { ...p.models, ...p.fastModels } : p.models;
  let best = null;
  for (const [key, val] of Object.entries(table)) {
    if (!id.startsWith(key)) continue;
    // A time-boxed override (e.g. introductory pricing) stops matching once
    // it lapses, so the family rate below it takes over automatically rather
    // than quietly overcharging - sorry, undercharging - forever.
    if (val.until && now > Date.parse(val.until + 'T23:59:59Z')) continue;
    if (!best || key.length > best.key.length) best = { key, val };
  }
  return best ? best.val : null;
}

// The cache multipliers are NOT per-model constants. Anthropic prices cache
// traffic as a fixed ratio of whatever that model's own input rate is - a cache
// read is 0.1x input, a 5-minute cache write 1.25x, a 1-hour write 2x - and
// that ratio is the same for Haiku and for Fable. Expressing them as
// multipliers of r.in rather than as absolute dollar figures is what keeps them
// off the maintenance list: they follow the input rate automatically, so a new
// model needs its two headline rates and nothing else.
//
// A model may still override any multiplier for itself (via the user's pricing
// file) in case that ever stops being true for one tier.
function priceUsage(byModel, p) {
  let usd = 0;
  for (const [model, u] of Object.entries(byModel || {})) {
    const r = rateFor(model, p);
    if (!r) continue;
    const wMult = r.cacheWriteMult ?? p.cacheWriteMult ?? 1.25;
    const w1Mult = r.cacheWrite1hMult ?? p.cacheWrite1hMult ?? 2;
    const rMult = r.cacheReadMult ?? p.cacheReadMult ?? 0.1;
    usd += (u.in || 0) / 1e6 * r.in
         + (u.out || 0) / 1e6 * r.out
         + (u.cacheW || 0) / 1e6 * r.in * wMult
         + (u.cacheW1h || 0) / 1e6 * r.in * w1Mult
         + (u.cacheR || 0) / 1e6 * r.in * rMult;
  }
  return usd;
}

// Total cost for one session or one calendar day of usage. Prefers Claude
// Code's own reported cost over the rate-table estimate when it is available
// - it is the real bill, not a guess - EXCEPT when any response in scope
// batched more than one billed attempt (an advisor consultation, a retried
// model). costUSD is written from the same top-level usage object that
// digests.js's own comment says "describes only the attempt that produced
// the returned message" - so a multi-attempt response's reported cost never
// covers its advisor/retry attempts, and trusting it there would silently
// drop them from the total exactly as it did before the token counts were
// fixed to include them. `multiAttempt` is true for a session/day the moment
// any response there had more than one entry in usage.iterations.
function totalUsd(reported, multiAttempt, byModel, p) {
  return (reported > 0 && !multiAttempt) ? reported : priceUsage(byModel, p);
}

module.exports = { PRICING_FILE, PRICING_ASOF, pricing, rateFor, priceUsage, totalUsd };
