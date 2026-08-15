/*
 * settings.json across the three scopes, and the merged "effective config"
 * view with per-key provenance.
 */
'use strict';

const path = require('path');
const { CLAUDE_DIR } = require('./constants');
const { readJsonSafe } = require('./util');

function settingsPath(scope, dir) {
  if (scope === 'user') return path.join(CLAUDE_DIR, 'settings.json');
  if (!dir || !path.isAbsolute(dir)) throw new Error('project directory required for this scope');
  if (scope === 'project') return path.join(dir, '.claude', 'settings.json');
  if (scope === 'local') return path.join(dir, '.claude', 'settings.local.json');
  throw new Error('unknown scope');
}

function mergeEffective(dir) {
  const layers = [];
  const order = [['user', null], ['project', dir], ['local', dir]]; // lowest → highest precedence
  for (const [scope, d] of order) {
    let file;
    try { file = settingsPath(scope, d); } catch { continue; }
    const json = readJsonSafe(file);
    if (json) layers.push({ scope, file, json });
  }

  const merged = {};
  const sources = {};
  const ruleSources = { allow: [], ask: [], deny: [] };
  // Every value a key was ever given, lowest precedence first. `sources` says
  // which scope won; on its own that does not answer the question people
  // actually arrive with, which is "I set this in User - why isn't it what I
  // set?". Only keys that plain-replace are tracked: permissions, hooks and env
  // merge rather than overwrite, so nothing there is shadowed to report.
  const history = {};
  const record = (key, scope, value) => {
    (history[key] = history[key] || []).push({ scope, value });
  };

  for (const layer of layers) {
    for (const [key, val] of Object.entries(layer.json)) {
      if (key === 'permissions' && val && typeof val === 'object') {
        merged.permissions = merged.permissions || {};
        for (const [pk, pv] of Object.entries(val)) {
          if (['allow', 'ask', 'deny'].includes(pk) && Array.isArray(pv)) {
            merged.permissions[pk] = merged.permissions[pk] || [];
            for (const rule of pv) {
              if (!merged.permissions[pk].includes(rule)) {
                merged.permissions[pk].push(rule);
                ruleSources[pk].push({ rule, scope: layer.scope });
              }
            }
          } else {
            merged.permissions[pk] = pv;
            sources[`permissions.${pk}`] = layer.scope;
            record(`permissions.${pk}`, layer.scope, pv);
          }
        }
        sources.permissions = sources.permissions || layer.scope;
      } else if (key === 'hooks' && val && typeof val === 'object') {
        merged.hooks = merged.hooks || {};
        for (const [event, matchers] of Object.entries(val)) {
          merged.hooks[event] = (merged.hooks[event] || []).concat(matchers);
        }
        sources.hooks = sources.hooks ? `${sources.hooks}+${layer.scope}` : layer.scope;
      } else if (key === 'env' && val && typeof val === 'object') {
        merged.env = Object.assign(merged.env || {}, val);
        sources.env = sources.env ? `${sources.env}+${layer.scope}` : layer.scope;
      } else {
        merged[key] = val;
        sources[key] = layer.scope;
        record(key, layer.scope, val);
      }
    }
  }

  // Only the contested keys are worth showing: the winner plus what it beat.
  const overridden = {};
  for (const [key, entries] of Object.entries(history)) {
    if (entries.length < 2) continue;
    overridden[key] = {
      winner: entries[entries.length - 1],
      beat: entries.slice(0, -1).reverse(),   // nearest loser first
    };
  }

  return {
    merged, sources, ruleSources, overridden,
    layers: layers.map((l) => ({ scope: l.scope, file: l.file })),
  };
}

module.exports = { settingsPath, mergeEffective };
