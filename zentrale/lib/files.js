'use strict';
// Datei-Dienst: Zugriff nur innerhalb des Projektordners
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { httpError } = require('./util');

module.exports = function createFiles(settings) {
  const root = () => path.resolve(settings.get().projectsDir);

  // Relativen Pfad sicher in einen absoluten Pfad unterhalb des Projektordners umwandeln
  async function resolve(rel = '') {
    const base = root();
    const abs = path.resolve(base, '.' + path.sep + String(rel).replace(/^[/\\]+/, ''));
    if (abs !== base && !abs.startsWith(base + path.sep)) throw httpError(403, 'Pfad außerhalb des Projektordners');
    // Symlinks dürfen nicht aus dem Ordner herausführen
    try {
      const real = await fsp.realpath(abs);
      const realBase = await fsp.realpath(base);
      if (real !== realBase && !real.startsWith(realBase + path.sep)) throw httpError(403, 'Link zeigt außerhalb des Projektordners');
    } catch (e) {
      if (e.status) throw e; // nicht vorhandene Dateien sind ok (z. B. beim Anlegen)
    }
    return abs;
  }
  const relOf = (abs) => path.relative(root(), abs).split(path.sep).join('/');

  async function list(rel) {
    const dir = await resolve(rel);
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const out = await Promise.all(entries.map(async (e) => {
      const full = path.join(dir, e.name);
      let st = null;
      try { st = await fsp.stat(full); } catch {}
      return { name: e.name, path: relOf(full), dir: st ? st.isDirectory() : e.isDirectory(), size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0 };
    }));
    return out.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
  }

  async function read(rel) {
    const f = await resolve(rel);
    const st = await fsp.stat(f);
    if (st.size > 5e6) throw httpError(413, 'Datei zu groß zum Bearbeiten (> 5 MB)');
    return { path: relOf(f), content: await fsp.readFile(f, 'utf8'), mtime: st.mtimeMs };
  }

  async function write(rel, content) {
    const f = await resolve(rel);
    await fsp.mkdir(path.dirname(f), { recursive: true });
    await fsp.writeFile(f, content ?? '');
    return { path: relOf(f) };
  }

  async function mkdir(rel) {
    const f = await resolve(rel);
    await fsp.mkdir(f, { recursive: true });
    return { path: relOf(f) };
  }

  async function remove(rel) {
    const f = await resolve(rel);
    if (f === root()) throw httpError(400, 'Projektordner selbst kann nicht gelöscht werden');
    await fsp.rm(f, { recursive: true, force: true });
    return { ok: true };
  }

  async function rename(from, to) {
    const a = await resolve(from);
    const b = await resolve(to);
    await fsp.mkdir(path.dirname(b), { recursive: true });
    await fsp.rename(a, b);
    return { path: relOf(b) };
  }

  return { root, resolve, list, read, write, mkdir, remove, rename };
};
