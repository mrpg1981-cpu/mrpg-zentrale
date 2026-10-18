#!/usr/bin/env node
// MRPG Zentrale – Kern-Server
// Start:        node server.js                 -> Dashboard auf http://localhost:7777
// KI-Login:     node server.js login claude|codex|gemini
// Neues Modul:  node server.js new-module <id> "<Name>"
// Passwort neu: node server.js reset-password
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { sendJSON, readRaw, readBody, serveStatic, sse, readJSON, writeJSON, httpError } = require('./lib/util');

const ROOT = __dirname;
const VERSION = require('./package.json').version;
const DIRS = {
  ui: path.join(ROOT, 'ui'),
  core: path.join(ROOT, 'core'),
  modules: path.join(ROOT, 'modules'),
  runtime: path.join(ROOT, 'runtime'),
  data: path.resolve(process.env.ZENTRALE_DATA || path.join(ROOT, 'data')),
};
const PORT = Number(process.env.PORT || 7777);
const HOST = process.env.HOST || '127.0.0.1';
fs.mkdirSync(DIRS.data, { recursive: true });
if (process.env.HOME && process.env.HOME.startsWith(DIRS.data)) fs.mkdirSync(process.env.HOME, { recursive: true });

// ---------- Runtime: portable Programme vor dem System-PATH ----------
const SEP = process.platform === 'win32' ? ';' : ':';
const RUN_PATH = [
  path.join(DIRS.runtime, 'bin'),
  path.join(DIRS.runtime, 'node', 'bin'),
  path.join(DIRS.runtime, 'node'),
  path.join(DIRS.data, 'npm-global', 'bin'),
  path.join(DIRS.data, 'npm-global'), // Windows legt die Programme direkt im Prefix ab
  process.env.PATH,
].join(SEP);
const runEnv = () => ({ ...process.env, PATH: RUN_PATH });
function which(bin) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { env: runEnv(), encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

// ---------- Dienste ----------
const settings = require('./lib/settings')(DIRS.data);
const auth = require('./lib/auth')(settings);
const ki = require('./lib/ki')({ dataDir: DIRS.data, runEnv, which });
const files = require('./lib/files')(settings);
const system = require('./lib/system')({ root: ROOT, dataDir: DIRS.data, settings, runEnv });

// Event-Bus (Server-Sent Events)
const listeners = new Set();
function emit(type, payload, from = 'zentrale') {
  const msg = `data: ${JSON.stringify({ type, payload, from, ts: Date.now() })}\n\n`;
  for (const res of listeners) res.write(msg);
}
const procs = require('./lib/procs')({ runEnv, emit });
const terminals = require('./lib/terminal')({ settings, runEnv });
const library = require('./lib/library')({ root: ROOT, dataDir: DIRS.data });
const team = require('./lib/team')({ dataDir: DIRS.data, ki, emit, runEnv, library, resolveProject: (rel) => files.resolve(rel) });
const backends = require('./lib/backends')({ modulesDir: DIRS.modules, procs, runEnv });

// ---------- Module: core/ (eingebaut) und modules/ (deine Apps) ----------
function scan(dir, core) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
    .map((d) => {
      const m = readJSON(path.join(dir, d.name, 'module.json'), null);
      if (!m) return null;
      const base = core ? 'core' : 'modules';
      // Module mit eigenem Server laufen über den Proxy /m/<id>/
      const url = m.backend && m.backend.cmd ? `/m/${d.name}/` : `/${base}/${d.name}/${m.ui || 'index.html'}`;
      return { id: d.name, icon: '◇', order: 100, ui: 'index.html', group: core ? 'Zentrale' : 'Module', ...m, core, url };
    })
    .filter(Boolean);
}
const loadModules = () => [...scan(DIRS.core, true), ...scan(DIRS.modules, false)].sort((a, b) => a.order - b.order);

// Store pro Modul (data/store/<id>.json)
const storeFile = (id) => path.join(DIRS.data, 'store', id.replace(/[^\w-]/g, '') + '.json');

// Projekt-Ordner (relativ zum Projektordner) in absoluten Pfad umwandeln
const projectCwd = async (rel) => (rel ? files.resolve(rel) : path.resolve(settings.get().projectsDir));

// ---------- Routen ----------
const routes = [];
const route = (method, pattern, handler, opts = {}) => routes.push({ method, pattern, handler, ...opts });
const PUBLIC = { public: true };

// Anmeldung
route('GET', '/api/auth/state', (req) => ({ setup: auth.isSetup(), authed: auth.isAuthed(req) }), PUBLIC);
route('POST', '/api/auth/setup', async (req, res) => { auth.setup((await readBody(req)).password, res); return { ok: true }; }, PUBLIC);
route('POST', '/api/auth/login', async (req, res) => { auth.login((await readBody(req)).password, req, res); return { ok: true }; }, PUBLIC);
route('POST', '/api/auth/logout', (req, res) => { auth.logout(req, res); return { ok: true }; });
route('POST', '/api/auth/change', async (req, res) => { const b = await readBody(req); auth.change(b.old, b.new, res); return { ok: true }; });

// Allgemein
route('GET', '/api/info', () => ({ version: VERSION, platform: process.platform, docker: fs.existsSync('/.dockerenv'), data: DIRS.data, projectsDir: settings.get().projectsDir, pty: terminals.hasPty }));
route('GET', '/api/modules', () => loadModules());
route('GET', '/api/settings', () => settings.public());
route('PUT', '/api/settings', async (req) => { const s = settings.update(await readBody(req)); emit('settings.changed', s); return s; });

// KI
route('GET', '/api/ki/status', () => ki.status());
route('GET', '/api/ki/usage', (req, res, url) => ki.usage(Number(url.searchParams.get('days')) || 30));
route('POST', '/api/ki/ask', async (req, res) => {
  const b = await readBody(req);
  const cwd = b.project != null ? await projectCwd(b.project) : undefined;
  const send = sse(res);
  let child;
  try {
    // Agent und Skills in den Prompt einbauen – funktioniert mit jeder KI
    const c = library.compose({ prompt: b.prompt, skills: b.skills, agent: b.agent, provider: b.provider, model: b.model, mode: b.mode });
    child = ki.ask({ ...b, prompt: c.prompt, provider: c.provider || 'claude', model: c.model, mode: c.mode || 'chat', cwd }, send);
  } catch (e) { send('error', e.message); return res.end(); }
  child.on('close', () => res.end());
  child.on('error', () => res.end());
  res.on('close', () => { if (child.exitCode === null) child.kill(); });
}, { stream: true });
route('POST', '/api/ki/login', async (req) => {
  const { provider } = await readBody(req);
  const c = ki.loginCommand(provider);
  if (!c) throw httpError(400, 'Für dieses Modell ist kein Login nötig');
  if (!which(c.bin)) throw httpError(404, `${c.name}-CLI nicht gefunden`);
  return terminals.create({ title: `Login ${c.name}`, command: c.bin, args: c.args, env: c.env });
});

route('POST', '/api/ki/install', async (req) => {
  const { provider } = await readBody(req);
  const cmd = ki.installCommand(provider);
  if (!cmd) throw httpError(400, 'Für dieses Modell nicht möglich');
  return procs.start({ name: `${provider} installieren`, cmd, cwd: DIRS.data });
});
route('POST', '/api/ki/logout', async (req) => { ki.logout((await readBody(req)).provider); return { ok: true }; });

// Skills & Agenten
route('GET', '/api/skills', () => library.listSkills());
route('PUT', '/api/skills', async (req) => library.saveSkill(await readBody(req)));
route('DELETE', /^\/api\/skills\/([\w-]+)$/, (req, res, url, m) => { library.deleteSkill(m[1]); return { ok: true }; });
route('GET', '/api/agents', () => library.listAgents());
route('PUT', '/api/agents', async (req) => library.saveAgent(await readBody(req)));
route('DELETE', /^\/api\/agents\/([\w-]+)$/, (req, res, url, m) => { library.deleteAgent(m[1]); return { ok: true }; });
route('POST', /^\/api\/modules\/([\w-]+)\/restart$/, async (req, res, url, m) => {
  const mod = loadModules().find((x) => x.id === m[1] && x.backend);
  if (!mod) throw httpError(404, 'Modul ohne eigenen Server');
  backends.stop(mod.id);
  await backends.ensure(mod);
  return { ok: true };
});

// KI-Team
route('GET', '/api/team/recipes', () => team.RECIPES);
route('GET', '/api/team', () => team.list());
route('POST', '/api/team', async (req) => team.start(await readBody(req)));
route('POST', /^\/api\/team\/(\w+)\/stop$/, (req, res, url, m) => { team.stop(m[1]); return { ok: true }; });
route('DELETE', /^\/api\/team\/(\w+)$/, (req, res, url, m) => { team.remove(m[1]); return { ok: true }; });
route('GET', /^\/api\/team\/(\w+)\/stream$/, (req, res, url, m) => {
  const send = sse(res);
  const off = team.subscribe(m[1], send);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { off(); clearInterval(ping); });
}, { stream: true });

// Dateien
route('GET', '/api/fs/list', (req, res, url) => files.list(url.searchParams.get('path') || ''));
route('GET', '/api/fs/read', (req, res, url) => files.read(url.searchParams.get('path')));
route('GET', '/api/fs/raw', async (req, res, url) => {
  const f = await files.resolve(url.searchParams.get('path'));
  serveStatic(res, path.dirname(f), path.basename(f));
}, { stream: true });
route('PUT', '/api/fs/write', async (req) => { const b = await readBody(req); const r = await files.write(b.path, b.content); emit('fs.changed', { path: r.path }); return r; });
route('POST', '/api/fs/mkdir', async (req) => files.mkdir((await readBody(req)).path));
route('POST', '/api/fs/rename', async (req) => { const b = await readBody(req); return files.rename(b.from, b.to); });
route('DELETE', '/api/fs', (req, res, url) => files.remove(url.searchParams.get('path')));

// Prozesse
route('GET', '/api/procs', () => procs.list());
route('POST', '/api/procs', async (req) => { const b = await readBody(req); return procs.start({ name: b.name, cmd: b.cmd, cwd: await projectCwd(b.project) }); });
route('POST', /^\/api\/procs\/(\w+)\/stop$/, (req, res, url, m) => procs.stop(m[1]));
route('DELETE', /^\/api\/procs\/(\w+)$/, (req, res, url, m) => { procs.remove(m[1]); return { ok: true }; });
route('GET', /^\/api\/procs\/(\w+)\/stream$/, (req, res, url, m) => {
  const off = procs.subscribe(m[1], sse(res));
  req.on('close', off);
}, { stream: true });

// Terminal
route('GET', '/api/terminals', () => terminals.list());
route('POST', '/api/terminals', async (req) => { const b = await readBody(req); return terminals.create({ cwd: await projectCwd(b.project), title: b.title, input: b.input }); });
route('DELETE', /^\/api\/terminals\/(\w+)$/, (req, res, url, m) => { terminals.kill(m[1]); return { ok: true }; });

// System & Projekte
route('GET', '/api/system', () => system.info());
route('GET', '/api/projects', () => system.projects());
route('POST', '/api/projects', async (req) => {
  const { name, clone } = await readBody(req);
  if (!name || !/^[\w.-]+$/.test(name)) throw httpError(400, 'Ungültiger Projektname');
  if (clone && !/^(https?:\/\/|git@)[\w.@:/~+-]+$/.test(clone)) throw httpError(400, 'Ungültige Git-URL');
  if (clone) return procs.start({ name: `git clone ${name}`, cmd: `git clone ${JSON.stringify(clone)} ${JSON.stringify(name)}`, cwd: await projectCwd('') });
  return files.mkdir(name);
});
route('GET', '/api/backup', (req, res, url) => system.backup(res, { withAuth: url.searchParams.get('auth') === '1' }), { stream: true });
route('POST', '/api/restore', async (req) => { await system.restore(await readRaw(req, 500e6)); return { ok: true, hint: 'Neustart empfohlen' }; });
route('GET', '/api/update', () => system.updateCheck());
route('POST', '/api/update', () => system.updatePull());

// Event-Bus
route('GET', '/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(': ok\n\n');
  listeners.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { listeners.delete(res); clearInterval(ping); });
}, { stream: true });
route('POST', '/api/events', async (req) => { const { type, payload, from } = await readBody(req); if (!type) throw httpError(400, 'type fehlt'); emit(type, payload, from); return { ok: true }; });

// Store
route('GET', /^\/api\/store\/([\w-]+)$/, (req, res, url, m) => readJSON(storeFile(m[1]), {}));
route('PUT', /^\/api\/store\/([\w-]+)$/, async (req, res, url, m) => { writeJSON(storeFile(m[1]), await readBody(req)); emit('store.changed', { id: m[1] }); return { ok: true }; });

// ---------- HTTP-Server ----------
const PUBLIC_FILES = new Set(['/login.html', '/theme.css', '/icon.svg', '/manifest.webmanifest', '/sw.js']);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');

  try {
    if (p.startsWith('/api/')) {
      const r = routes.find((x) => x.method === req.method && (typeof x.pattern === 'string' ? x.pattern === p : x.pattern.test(p)));
      if (!r) return sendJSON(res, 404, { error: 'Unbekannte API' });
      if (!r.public && !auth.isAuthed(req)) return sendJSON(res, 401, { error: 'Nicht angemeldet' });
      const m = typeof r.pattern === 'string' ? null : p.match(r.pattern);
      const out = await r.handler(req, res, url, m);
      if (!r.stream && !res.headersSent) sendJSON(res, 200, out ?? { ok: true });
      return;
    }

    if (PUBLIC_FILES.has(p)) return serveStatic(res, DIRS.ui, p.slice(1));
    if (!auth.isAuthed(req)) {
      res.writeHead(302, { Location: '/login.html' });
      return res.end();
    }
    if (p.startsWith('/m/')) {
      const [, id] = p.match(/^\/m\/([\w-]+)/) || [];
      const mod = id && loadModules().find((x) => x.id === id && x.backend);
      if (!mod) return sendJSON(res, 404, { error: 'Modul nicht gefunden' });
      if (p === `/m/${id}`) { res.writeHead(301, { Location: `/m/${id}/` }); return res.end(); }
      return await backends.proxy(mod, req, res, req.url.slice(`/m/${id}`.length));
    }
    if (p.startsWith('/core/')) return serveStatic(res, DIRS.core, p.slice(6));
    if (p.startsWith('/modules/')) return serveStatic(res, DIRS.modules, p.slice(9));
    if (p.startsWith('/vendor/xterm/')) return serveStatic(res, path.join(ROOT, 'node_modules', '@xterm', 'xterm'), p.slice(14), { 'Cache-Control': 'max-age=86400' });
    if (p.startsWith('/vendor/xterm-fit/')) return serveStatic(res, path.join(ROOT, 'node_modules', '@xterm', 'addon-fit'), p.slice(18), { 'Cache-Control': 'max-age=86400' });
    return serveStatic(res, DIRS.ui, p === '/' ? 'index.html' : p.slice(1));
  } catch (e) {
    if (!e.status) console.error(e);
    const code = e.status || (e.code === 'ENOENT' ? 404 : e.code === 'EACCES' ? 403 : 500);
    const msg = e.code === 'ENOENT' ? 'Nicht gefunden' : e.message;
    if (!res.headersSent) sendJSON(res, code, { error: msg });
    else res.end();
  }
});

// WebSocket für Terminals
let WebSocketServer = null;
try { ({ WebSocketServer } = require('ws')); } catch { console.warn('Paket "ws" fehlt – Terminal deaktiviert (npm install).'); }
if (WebSocketServer) {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const m = req.url.match(/^\/ws\/terminal\/(\w+)/);
    const origin = req.headers.origin;
    const sameOrigin = !origin || new URL(origin).host === req.headers.host;
    if (!m || !auth.isAuthed(req) || !sameOrigin) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, (ws) => terminals.attach(m[1], ws));
  });
}

// ---------- Kommandozeile ----------
const [cmd, arg, arg2] = process.argv.slice(2);

if (cmd === 'login') {
  const c = ki.loginCommand(arg);
  if (!c) { console.log('Nutzung: node server.js login claude|codex|gemini'); process.exit(1); }
  console.log(`> Anmeldung bei ${c.name} – Daten landen in ${ki.authDir(arg)}`);
  const child = spawn(c.bin, c.args, { stdio: 'inherit', env: { ...runEnv(), ...c.env }, shell: process.platform === 'win32' });
  child.on('error', () => { console.error(`${c.bin} nicht gefunden.`); process.exit(1); });
  child.on('close', (code) => process.exit(code || 0));
} else if (cmd === 'new-module') {
  if (!arg || !/^[a-z0-9-]+$/.test(arg)) { console.log('Nutzung: node server.js new-module <id> "<Name>"   (id: klein, z. B. mein-tool)'); process.exit(1); }
  const dst = path.join(DIRS.modules, arg);
  if (fs.existsSync(dst)) { console.error('Modul existiert schon:', dst); process.exit(1); }
  fs.cpSync(path.join(DIRS.modules, '_vorlage'), dst, { recursive: true });
  const mj = path.join(dst, 'module.json');
  writeJSON(mj, { ...readJSON(mj, {}), name: arg2 || arg });
  console.log('✓ Modul angelegt:', dst);
} else if (cmd === 'reset-password') {
  settings.setInternal('passwordHash', null);
  console.log('✓ Passwort gelöscht – beim nächsten Öffnen wird ein neues gesetzt.');
} else {
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`✕ Port ${PORT} ist schon belegt – läuft die Zentrale bereits? Anderen Port: PORT=7778 ./start.sh`);
    else console.error(e);
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
    console.log(`〄 MRPG Zentrale ${VERSION} läuft auf ${url}`);
    console.log(`  Projekte: ${settings.get().projectsDir}`);
    console.log(`  Daten:    ${DIRS.data}`);
    if (!terminals.hasPty) console.log('  Hinweis: node-pty fehlt – Terminal läuft im einfachen Modus.');
    if (!process.env.NO_BROWSER && !fs.existsSync('/.dockerenv')) {
      const o = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
      spawn(o[0], o[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    }
  });
  const shutdown = () => { team.stopAll(); procs.stopAll(); terminals.killAll(); setTimeout(() => process.exit(0), 300); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
