'use strict';
// Module mit eigenem Server (z. B. MRPG Commander):
// Die Zentrale startet den Server bei Bedarf auf einem freien Port und leitet /m/<id>/… dorthin weiter.
// module.json: { "backend": { "cmd": "node server.js", "env": { … } } }
// Der Server muss PORT aus der Umgebung lesen und relative URLs nutzen (fetch('api/…') statt '/api/…').
const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.unref();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const waitForPort = (port, ms = 20000) => new Promise((resolve, reject) => {
  const until = Date.now() + ms;
  const tryOnce = () => {
    const c = net.connect(port, '127.0.0.1');
    c.on('connect', () => { c.destroy(); resolve(); });
    c.on('error', () => { c.destroy(); if (Date.now() > until) reject(new Error('Modul-Server antwortet nicht')); else setTimeout(tryOnce, 250); });
  };
  tryOnce();
});

module.exports = function createBackends({ modulesDir, procs, runEnv }) {
  const running = new Map(); // id -> { port, procId, ready: Promise }

  function npmInstall(cwd) {
    return new Promise((resolve, reject) => {
      const p = spawn('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd, env: runEnv(), shell: process.platform === 'win32', stdio: 'ignore' });
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('npm install für das Modul fehlgeschlagen'))));
      p.on('error', reject);
    });
  }

  async function start(mod) {
    const cwd = path.join(modulesDir, mod.id);
    if (fs.existsSync(path.join(cwd, 'package.json')) && !fs.existsSync(path.join(cwd, 'node_modules'))) await npmInstall(cwd);
    const port = await freePort();
    const env = { ...(mod.backend.env || {}), PORT: String(port), HOST: '127.0.0.1', NO_BROWSER: '1', ZENTRALE: '1' };
    const p = procs.start({ name: `Modul: ${mod.name}`, cmd: mod.backend.cmd, cwd, env, module: mod.id });
    await waitForPort(port);
    return { port, procId: p.id };
  }

  // Server des Moduls sicherstellen (startet beim ersten Aufruf, nach Absturz neu)
  function ensure(mod) {
    const cur = running.get(mod.id);
    if (cur) {
      const info = procs.list().find((p) => p.id === cur.procId);
      if (!info || info.status === 'läuft') return cur.ready;
      running.delete(mod.id); // abgestürzt -> neu starten
    }
    const entry = {};
    entry.ready = start(mod).then((r) => Object.assign(entry, r)).catch((e) => { running.delete(mod.id); throw e; });
    running.set(mod.id, entry);
    return entry.ready;
  }

  // Anfrage an den Modul-Server weiterreichen
  async function proxy(mod, req, res, rest) {
    const { port } = await ensure(mod);
    const headers = { ...req.headers, host: `127.0.0.1:${port}` };
    delete headers.cookie; // Zentrale-Sitzung nicht an Module weitergeben
    delete headers.authorization;
    const up = http.request({ host: '127.0.0.1', port, method: req.method, path: rest || '/', headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', (e) => { if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); } res.end('Modul-Server nicht erreichbar: ' + e.message); });
    req.pipe(up);
  }

  function stop(id) {
    const cur = running.get(id);
    if (cur && cur.procId) try { procs.stop(cur.procId); } catch {}
    running.delete(id);
  }

  return { ensure, proxy, stop, status: () => [...running.entries()].map(([id, r]) => ({ id, port: r.port, procId: r.procId })) };
};
