'use strict';
// Aufräum-Engine: scannen, analysieren, Dubletten finden, Sortier-Plan erstellen, ausführen, rückgängig machen.
// Grundregeln: NIE löschen (Dubletten -> Quarantäne), jede Verschiebung im Journal, Projekte bleiben ganz.
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// ---------- Kategorien ----------
const CATS = {
  Bilder: 'jpg jpeg png gif webp heic heif bmp tif tiff raw cr2 cr3 nef arw dng svg psd xcf ico',
  Videos: 'mp4 mov mkv avi wmv webm m4v mpg mpeg 3gp mts',
  Musik: 'mp3 wav flac aac ogg m4a wma opus aiff mid midi',
  Dokumente: 'pdf doc docx odt rtf txt md pages tex epub',
  Tabellen: 'xls xlsx xlsm ods csv numbers',
  Präsentationen: 'ppt pptx odp key',
  Archive: 'zip rar 7z tar gz bz2 xz tgz iso dmg',
  Programme: 'exe msi deb rpm appimage apk pkg bat cmd sh',
  Code: 'js ts jsx tsx py java c cpp h cs go rs php rb html htm css scss json xml yml yaml sql ps1 vue svelte kt swift',
  Schriften: 'ttf otf woff woff2',
  'E-Mails': 'eml msg mbox pst',
  '3D & CAD': 'stl obj fbx blend dwg dxf step stp 3mf gcode',
};
const EXT2CAT = {};
for (const [cat, list] of Object.entries(CATS)) for (const e of list.split(' ')) EXT2CAT[e] = cat;
const catOf = (name) => EXT2CAT[path.extname(name).slice(1).toLowerCase()] || 'Sonstiges';

const PROJECT_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'composer.json', 'CMakeLists.txt', '.sln', 'Makefile', 'docker-compose.yml', '.venv'];
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', '.npm', '.cargo', '.rustup', '__pycache__', '.venv', 'venv', '.Trash', '$RECYCLE.BIN', 'System Volume Information', 'AppData', 'Library', '.local', '.config', 'snap', '.steam', '.wine']);

function defaultRoots() {
  const h = os.homedir();
  const names = ['Downloads', 'Dokumente', 'Documents', 'Bilder', 'Pictures', 'Schreibtisch', 'Desktop', 'Videos', 'Musik', 'Music'];
  return names.map((n) => path.join(h, n)).filter((p) => fs.existsSync(p));
}

const DEFAULT_CONFIG = () => ({
  roots: defaultRoots(),
  target: path.join(os.homedir(), 'Sortiert'),
  exclude: [],
  minDupSize: 1024,          // kleinere Dateien bei Dubletten ignorieren
  sortFiles: true,           // Dateien nach Kategorie/Jahr einsortieren
  handleDuplicates: true,    // Dubletten in Quarantäne
  keepRule: 'oldest',        // welche Kopie bleibt: oldest | shortest | newest
  byMonthFor: ['Bilder', 'Videos'], // diese Kategorien zusätzlich nach Monat
  autopilotConfirmed: false,
});

module.exports = function createEngine(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const F = (n) => path.join(dataDir, n);
  const readJ = (n, d) => { try { return JSON.parse(fs.readFileSync(F(n), 'utf8')); } catch { return d; } };
  const writeJ = (n, o) => { const t = F(n) + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, F(n)); };

  let config = { ...DEFAULT_CONFIG(), ...readJ('config.json', {}) };
  const job = { phase: 'bereit', progress: 0, message: '', started: null, ended: null, error: null, cancel: false };
  const busy = () => !['bereit', 'fertig', 'fehler', 'abgebrochen'].includes(job.phase);
  const set = (phase, message, progress) => { Object.assign(job, { phase, message: message ?? job.message, progress: progress ?? job.progress }); };

  // ---------- Hilfen ----------
  const norm = (p) => path.resolve(String(p).replace(/^~(?=$|[\\/])/, os.homedir()));
  const inside = (p, dir) => p === dir || p.startsWith(dir + path.sep);
  const excluded = (p) => config.exclude.some((e) => e && inside(p, norm(e)));

  async function isProject(dir) {
    try {
      const names = await fsp.readdir(dir);
      return PROJECT_MARKERS.some((m) => names.includes(m) || (m.startsWith('.') && names.some((n) => n.endsWith(m))));
    } catch { return false; }
  }

  // ---------- 1. Scannen ----------
  async function scan() {
    const roots = config.roots.map(norm).filter((r) => fs.existsSync(r));
    if (!roots.length) throw new Error('Keine gültigen Ordner zum Scannen – bitte in den Einstellungen festlegen.');
    const target = norm(config.target);
    const files = [];
    const projects = [];
    const emptyDirs = [];
    let dirsSeen = 0;

    // inTarget: bereits einsortierte Dateien – nur für den Dubletten-Vergleich, werden nicht neu sortiert
    async function walk(dir, depth, inTarget = false) {
      if (job.cancel) throw new Error('abgebrochen');
      if (excluded(dir)) return;
      if (!inTarget && inside(dir, target)) return; // Ziel wird separat gescannt
      if (depth > 0 && await isProject(dir)) {
        let size = 0, count = 0;
        await sizeOf(dir, (s) => { size += s; count++; });
        projects.push({ path: dir, name: path.basename(dir), size, files: count });
        return;
      }
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      dirsSeen++;
      if (dirsSeen % 50 === 0) set('scannen', `${files.length} Dateien in ${dirsSeen} Ordnern …`);
      if (!entries.length && depth > 0) emptyDirs.push(dir);
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name) || (inTarget && e.name === '_Dubletten')) continue;
          await walk(full, depth + 1, inTarget);
        } else if (e.isFile()) {
          try {
            const st = await fsp.stat(full);
            files.push({ p: full, s: st.size, m: Math.round(st.mtimeMs), c: catOf(e.name), t: inTarget || undefined });
          } catch {}
        }
      }
    }
    async function sizeOf(dir, cb) {
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && !e.isSymbolicLink()) await sizeOf(full, cb);
        else if (e.isFile()) try { cb((await fsp.stat(full)).size); } catch {}
      }
    }

    set('scannen', 'Starte …', 0);
    for (const r of roots) await walk(r, 0);
    if (fs.existsSync(target)) await walk(target, 0, true);
    const index = { scanned: Date.now(), roots, files, projects, emptyDirs };
    writeJ('index.json', index);
    return index;
  }

  // ---------- 2. Dubletten ----------
  async function hashPart(file, size) {
    const h = crypto.createHash('sha1');
    const fd = await fsp.open(file, 'r');
    try {
      const n = Math.min(65536, size);
      const buf = Buffer.alloc(n);
      await fd.read(buf, 0, n, 0); h.update(buf);
      if (size > n) { await fd.read(buf, 0, n, Math.max(0, size - n)); h.update(buf); }
    } finally { await fd.close(); }
    h.update(String(size));
    return h.digest('hex');
  }
  const hashFull = (file) => new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });

  async function findDuplicates(index) {
    const bySize = new Map();
    for (const f of index.files) {
      if (f.s < config.minDupSize) continue;
      if (!bySize.has(f.s)) bySize.set(f.s, []);
      bySize.get(f.s).push(f);
    }
    const candidates = [...bySize.values()].filter((g) => g.length > 1);
    const total = candidates.reduce((a, g) => a + g.length, 0);
    let done = 0;
    const groups = [];
    for (const g of candidates) {
      if (job.cancel) throw new Error('abgebrochen');
      // Stufe 1: Anfang+Ende+Größe; Stufe 2: kompletter Inhalt (sha256)
      const quick = new Map();
      for (const f of g) {
        try { const k = await hashPart(f.p, f.s); if (!quick.has(k)) quick.set(k, []); quick.get(k).push(f); } catch {}
        done++;
        if (done % 25 === 0) set('dubletten', `Vergleiche Inhalte … ${done}/${total}`, total ? done / total : 0);
      }
      for (const q of quick.values()) {
        if (q.length < 2) continue;
        const full = new Map();
        for (const f of q) { try { const k = await hashFull(f.p); if (!full.has(k)) full.set(k, []); full.get(k).push(f); } catch {} }
        for (const [hash, list] of full) if (list.length > 1) groups.push({ hash, size: list[0].s, files: list.map((f) => f.p), keep: pickKeep(list).p, cat: list[0].c });
      }
    }
    groups.sort((a, b) => b.size * (b.files.length - 1) - a.size * (a.files.length - 1));
    writeJ('duplicates.json', { created: Date.now(), groups });
    return groups;
  }

  function pickKeep(list) {
    const target = norm(config.target);
    // Bereits einsortierte Kopie bevorzugen, sonst nach Regel
    const sorted = list.find((f) => inside(f.p, target) && !inside(f.p, path.join(target, '_Dubletten')));
    if (sorted) return sorted;
    const by = {
      oldest: (a, b) => a.m - b.m || a.p.length - b.p.length,
      newest: (a, b) => b.m - a.m || a.p.length - b.p.length,
      shortest: (a, b) => a.p.length - b.p.length || a.m - b.m,
    }[config.keepRule] || ((a, b) => a.m - b.m);
    return [...list].sort(by)[0];
  }

  // ---------- 3. Analyse ----------
  function analyze(index, groups) {
    const cats = {};
    const years = {};
    let size = 0;
    for (const f of index.files) {
      if (f.t) continue;
      size += f.s;
      const c = (cats[f.c] = cats[f.c] || { count: 0, size: 0 });
      c.count++; c.size += f.s;
      const y = new Date(f.m).getFullYear();
      years[y] = (years[y] || 0) + 1;
    }
    const wasted = groups.reduce((a, g) => a + g.size * (g.files.length - 1), 0);
    const yearAgo = Date.now() - 2 * 365 * 864e5;
    const analysis = {
      created: Date.now(), roots: index.roots, files: index.files.filter((f) => !f.t).length, sortedAlready: index.files.filter((f) => f.t).length, size,
      categories: Object.entries(cats).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.size - a.size),
      years: Object.entries(years).map(([y, n]) => ({ year: +y, count: n })).sort((a, b) => a.year - b.year),
      largest: index.files.filter((f) => !f.t).sort((a, b) => b.s - a.s).slice(0, 25).map((f) => ({ path: f.p, size: f.s, mtime: f.m })),
      old: index.files.filter((f) => !f.t && f.m < yearAgo && f.s > 50e6).sort((a, b) => b.s - a.s).slice(0, 25).map((f) => ({ path: f.p, size: f.s, mtime: f.m })),
      duplicates: { groups: groups.length, files: groups.reduce((a, g) => a + g.files.length - 1, 0), wasted },
      projects: index.projects, emptyDirs: index.emptyDirs.length,
    };
    writeJ('analysis.json', analysis);
    return analysis;
  }

  // ---------- 4. Plan ----------
  function buildPlan(index, groups) {
    const target = norm(config.target);
    const dupDir = path.join(target, '_Dubletten', new Date().toISOString().slice(0, 10));
    const moves = [];
    const taken = new Set();
    const dupLosers = new Set();
    const unique = (p) => {
      let q = p, i = 2;
      const ext = path.extname(p), base = p.slice(0, p.length - ext.length);
      while (taken.has(q) || fs.existsSync(q)) q = `${base} (${i++})${ext}`;
      taken.add(q);
      return q;
    };

    if (config.handleDuplicates) {
      for (const g of groups) for (const f of g.files) {
        if (f === g.keep) continue;
        dupLosers.add(f);
        const root = index.roots.find((r) => inside(f, r)) || path.dirname(f);
        const rel = path.relative(path.dirname(root), f); // Herkunft im Quarantäne-Ordner erkennbar lassen
        moves.push({ from: f, to: unique(path.join(dupDir, rel)), reason: 'Dublette', keep: g.keep, size: g.size });
      }
    }
    if (config.sortFiles) {
      for (const f of index.files) {
        if (dupLosers.has(f.p) || inside(f.p, target)) continue;
        const d = new Date(f.m);
        const parts = [target, f.c, String(d.getFullYear())];
        if (config.byMonthFor.includes(f.c)) parts.push(String(d.getMonth() + 1).padStart(2, '0'));
        const to = path.join(...parts, path.basename(f.p));
        if (to === f.p) continue;
        moves.push({ from: f.p, to: unique(to), reason: f.c, size: f.s });
      }
    }
    const plan = {
      id: Date.now().toString(36), created: Date.now(), target, moves,
      summary: {
        total: moves.length,
        duplicates: moves.filter((m) => m.reason === 'Dublette').length,
        sorted: moves.filter((m) => m.reason !== 'Dublette').length,
        bytes: moves.reduce((a, m) => a + (m.size || 0), 0),
        projectsUntouched: index.projects.length,
      },
    };
    writeJ('plan.json', plan);
    return plan;
  }

  // ---------- 5. Ausführen + Journal ----------
  async function moveFile(from, to) {
    await fsp.mkdir(path.dirname(to), { recursive: true });
    if (fs.existsSync(to)) throw new Error('Ziel existiert schon: ' + to);
    try { await fsp.rename(from, to); }
    catch (e) {
      if (e.code !== 'EXDEV') throw e;
      await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL); // anderes Laufwerk: kopieren, prüfen, dann Original entfernen
      const [a, b] = await Promise.all([fsp.stat(from), fsp.stat(to)]);
      if (a.size !== b.size) { await fsp.unlink(to); throw new Error('Kopie unvollständig: ' + from); }
      await fsp.unlink(from);
    }
  }

  async function removeEmptyDirs(dir, root) {
    if (dir !== root && await isProject(dir)) return; // Projekte nie anfassen
    let entries;
    try { entries = await fsp.readdir(dir); } catch { return; }
    for (const n of entries) { const p = path.join(dir, n); try { if ((await fsp.stat(p)).isDirectory()) await removeEmptyDirs(p, root); } catch {} }
    if (dir !== root) try { if (!(await fsp.readdir(dir)).length) await fsp.rmdir(dir); } catch {}
  }

  async function apply(plan) {
    if (!plan || !plan.moves) throw new Error('Kein Plan vorhanden');
    const journal = { id: plan.id, created: Date.now(), target: plan.target, done: [], failed: [], undone: false };
    const save = () => writeJ(`journal-${journal.id}.json`, journal);
    let i = 0;
    for (const m of plan.moves) {
      if (job.cancel) break;
      i++;
      if (i % 20 === 0) { set('ausführen', `Verschiebe … ${i}/${plan.moves.length}`, i / plan.moves.length); save(); }
      try {
        if (!fs.existsSync(m.from)) throw new Error('Quelle fehlt');
        await moveFile(m.from, m.to);
        journal.done.push({ from: m.from, to: m.to, reason: m.reason });
      } catch (e) { journal.failed.push({ from: m.from, to: m.to, error: e.message }); }
    }
    // leere Ordner in den gescannten Bereichen aufräumen (nicht in Projekten – die wurden nie angefasst)
    for (const r of config.roots.map(norm)) await removeEmptyDirs(r, r);
    journal.finished = Date.now();
    save();
    try { fs.unlinkSync(F('plan.json')); } catch {}
    return journal;
  }

  async function undo(id) {
    if (!/^[\w]+$/.test(id)) throw new Error('Ungültige ID');
    const journal = readJ(`journal-${id}.json`, null);
    if (!journal) throw new Error('Journal nicht gefunden');
    if (journal.undone) throw new Error('Wurde bereits rückgängig gemacht');
    const result = { restored: 0, failed: [] };
    const list = [...journal.done].reverse();
    let i = 0;
    for (const m of list) {
      i++;
      if (i % 20 === 0) set('rückgängig', `Stelle wieder her … ${i}/${list.length}`, i / list.length);
      try { await moveFile(m.to, m.from); result.restored++; }
      catch (e) { result.failed.push({ path: m.to, error: e.message }); }
    }
    await removeEmptyDirs(norm(journal.target), norm(journal.target));
    journal.undone = Date.now();
    journal.undoResult = result;
    writeJ(`journal-${id}.json`, journal);
    return result;
  }

  function journals() {
    return fs.readdirSync(dataDir).filter((f) => /^journal-\w+\.json$/.test(f)).map((f) => {
      const j = readJ(f, null);
      return j && { id: j.id, created: j.created, finished: j.finished, moved: j.done.length, failed: j.failed.length, undone: j.undone || false, duplicates: j.done.filter((d) => d.reason === 'Dublette').length };
    }).filter(Boolean).sort((a, b) => b.created - a.created);
  }

  // ---------- Abläufe (laufen im Hintergrund) ----------
  function run(name, fn) {
    if (busy()) throw new Error('Es läuft bereits ein Vorgang: ' + job.phase);
    Object.assign(job, { phase: name, progress: 0, message: '', started: Date.now(), ended: null, error: null, cancel: false, result: null });
    fn().then((r) => { Object.assign(job, { phase: 'fertig', progress: 1, ended: Date.now(), result: r }); })
      .catch((e) => { Object.assign(job, { phase: job.cancel ? 'abgebrochen' : 'fehler', error: e.message, ended: Date.now() }); });
  }

  async function analyzeAll() {
    const index = await scan();
    set('dubletten', 'Suche Dubletten …', 0);
    const groups = await findDuplicates(index);
    set('analyse', 'Werte aus …', 1);
    const a = analyze(index, groups);
    const plan = buildPlan(index, groups);
    return { analysis: a.files, plan: plan.summary };
  }

  return {
    config: () => config,
    setConfig(patch) {
      const allowed = Object.keys(DEFAULT_CONFIG());
      for (const k of allowed) if (k in patch) config[k] = patch[k];
      config.roots = (config.roots || []).map(String).filter(Boolean);
      config.exclude = (config.exclude || []).map(String).filter(Boolean);
      writeJ('config.json', config);
      return config;
    },
    status: () => ({ ...job, busy: busy() }),
    cancel: () => { job.cancel = true; },
    startAnalyze: () => run('scannen', analyzeAll),
    startApply: () => {
      const plan = readJ('plan.json', null);
      if (!plan) throw new Error('Kein Plan vorhanden – erst analysieren');
      run('ausführen', () => apply(plan));
    },
    // Autopilot: alles in einem Rutsch – nur nach einmaliger Freigabe
    startAutopilot: () => {
      if (!config.autopilotConfirmed) throw new Error('Autopilot muss einmal freigegeben werden');
      run('scannen', async () => { await analyzeAll(); const plan = readJ('plan.json', null); set('ausführen', 'Führe Plan aus …', 0); return apply(plan); });
    },
    startUndo: (id) => run('rückgängig', () => undo(id)),
    analysis: () => readJ('analysis.json', null),
    duplicates: () => readJ('duplicates.json', { groups: [] }),
    plan: () => readJ('plan.json', null),
    journals,
    journal: (id) => (/^\w+$/.test(id) ? readJ(`journal-${id}.json`, null) : null),
    setKeep(hash, keep) {
      const d = readJ('duplicates.json', { groups: [] });
      const g = d.groups.find((x) => x.hash === hash);
      if (!g || !g.files.includes(keep)) throw new Error('Unbekannte Datei');
      g.keep = keep;
      writeJ('duplicates.json', d);
      const index = readJ('index.json', null);
      if (index) buildPlan(index, d.groups);
      return g;
    },
    rebuildPlan() {
      const index = readJ('index.json', null);
      if (!index) throw new Error('Erst analysieren');
      return buildPlan(index, readJ('duplicates.json', { groups: [] }).groups).summary;
    },
    defaults: DEFAULT_CONFIG,
  };
};
