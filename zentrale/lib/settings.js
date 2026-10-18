'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readJSON, writeJSON } = require('./util');

function defaultProjectsDir() {
  if (process.env.PROJEKTE_DIR) return process.env.PROJEKTE_DIR;
  if (fs.existsSync('/projekte')) return '/projekte';
  for (const name of ['Projekte', 'projects', 'Projects']) {
    const p = path.join(os.homedir(), name);
    if (fs.existsSync(p)) return p;
  }
  return path.join(os.homedir(), 'Projekte');
}

const DEFAULTS = {
  projectsDir: defaultProjectsDir(),
  defaultProvider: 'claude',
  defaultModel: '',
  theme: 'dark',
  accent: '#67f5ff',
  shell: '',
  notifications: true,
};

// Felder, die über die Einstellungen-Seite geändert werden dürfen
const EDITABLE = Object.keys(DEFAULTS);

module.exports = function createSettings(dataDir) {
  const file = path.join(dataDir, 'settings.json');
  let cache = { ...DEFAULTS, ...readJSON(file, {}) };

  return {
    get: () => cache,
    public() {
      const out = {};
      for (const k of EDITABLE) out[k] = cache[k];
      return out;
    },
    update(patch) {
      for (const k of EDITABLE) if (k in patch) cache[k] = patch[k];
      writeJSON(file, cache);
      return this.public();
    },
    // interne Felder (z. B. Passwort-Hash)
    setInternal(key, value) { cache[key] = value; writeJSON(file, cache); },
  };
};
