// MRPG Aufräumen – Backend (läuft als Modul der Zentrale oder eigenständig: node server.js)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const createEngine = require('./engine');

const PORT = process.env.PORT || 8031;
const DATA = process.env.MODULE_DATA || path.join(os.homedir(), '.mrpg-aufraeumen');
const engine = createEngine(DATA);

const send = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
const body = (req) => new Promise((ok, fail) => {
  let s = '';
  req.on('data', (c) => { s += c; if (s.length > 1e6) req.destroy(); });
  req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { fail(e); } });
});

const routes = {
  'GET /api/config': () => engine.config(),
  'PUT /api/config': (b) => engine.setConfig(b),
  'GET /api/defaults': () => engine.defaults(),
  'GET /api/status': () => engine.status(),
  'POST /api/analyze': () => { engine.startAnalyze(); return { ok: true }; },
  'POST /api/apply': () => { engine.startApply(); return { ok: true }; },
  'POST /api/autopilot': () => { engine.startAutopilot(); return { ok: true }; },
  'POST /api/cancel': () => { engine.cancel(); return { ok: true }; },
  'GET /api/analysis': () => engine.analysis(),
  'GET /api/duplicates': () => engine.duplicates(),
  'POST /api/keep': (b) => engine.setKeep(b.hash, b.keep),
  'GET /api/plan': (b, q) => {
    const p = engine.plan();
    if (!p) return null;
    const off = Math.max(0, +q.get('offset') || 0);
    const filter = q.get('filter') || '';
    const moves = filter ? p.moves.filter((m) => (filter === 'Dublette' ? m.reason === 'Dublette' : m.reason === filter)) : p.moves;
    return { ...p, moves: moves.slice(off, off + 300), filtered: moves.length };
  },
  'POST /api/plan/rebuild': () => engine.rebuildPlan(),
  'GET /api/journals': () => engine.journals(),
  'POST /api/undo': (b) => { engine.startUndo(String(b.id)); return { ok: true }; },
  'GET /api/home': () => ({ home: os.homedir(), sep: path.sep, platform: process.platform }),
  // Ordner prüfen (existiert? wie viele Einträge?)
  'POST /api/check': (b) => (b.paths || []).map((p) => {
    const abs = path.resolve(String(p).replace(/^~(?=$|[\\/])/, os.homedir()));
    try { return { path: p, abs, ok: fs.statSync(abs).isDirectory(), entries: fs.readdirSync(abs).length }; } catch { return { path: p, abs, ok: false }; }
  }),
};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
  }
  const h = routes[`${req.method} ${u.pathname}`];
  if (!h) return send(res, 404, { error: 'Unbekannt' });
  try { send(res, 200, await h(req.method === 'GET' ? {} : await body(req), u.searchParams)); }
  catch (e) { send(res, 400, { error: e.message }); }
});
server.listen(PORT, process.env.HOST || '127.0.0.1', () => console.log(`MRPG Aufräumen läuft auf http://127.0.0.1:${PORT}`));
