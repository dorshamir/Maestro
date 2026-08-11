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
const PRICING_ASOF = '2026-08-11';
const PRICING_DEFAULTS = {
  cacheWriteMult: 1.25,   // 5-minute cache write
  cacheWrite1hMult: 2.0,  // 1-hour cache write
  cacheReadMult: 0.1,
  models: {
    'claude-fable':  { in: 10, out: 50 },
    'claude-mythos': { in: 10, out: 50 },
    'claude-opus':   { in: 5,  out: 25 },
    'claude-sonnet': { in: 2,  out: 10 },
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
function rateFor(modelId, p) {
  const raw = String(modelId || '').toLowerCase();
  const fast = raw.endsWith('|fast');
  const id = fast ? raw.slice(0, -5) : raw;
  const table = fast ? { ...p.models, ...p.fastModels } : p.models;
  let best = null;
  for (const [key, val] of Object.entries(table)) {
    if (id.startsWith(key) && (!best || key.length > best.key.length)) best = { key, val };
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

module.exports = { PRICING_FILE, PRICING_ASOF, pricing, rateFor, priceUsage };
