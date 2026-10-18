#!/usr/bin/env node
// MRPG Zentrale v4 – Kern-Server (ohne externe Abhängigkeiten)
// Start:   node server.js            -> Dashboard auf http://localhost:7777
// Login:   node server.js login claude|codex|gemini
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = __dirname;
const DIRS = {
  ui: path.join(ROOT, 'ui'),
  modules: path.join(ROOT, 'modules'),
  runtime: path.join(ROOT, 'runtime', 'bin'),
  data: process.env.ZENTRALE_DATA || path.join(ROOT, 'data'),
};
const PORT = Number(process.env.PORT || 7777);
const HOST = process.env.HOST || '127.0.0.1';
const VERSION = '4.0.0';

fs.mkdirSync(DIRS.data, { recursive: true });

// ---------- Runtime: portable Programme zuerst ----------
const SEP = process.platform === 'win32' ? ';' : ':';
const RUN_PATH = [DIRS.runtime, path.join(ROOT, 'runtime', 'node', 'bin'), process.env.PATH].join(SEP);

function which(bin) {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(cmd, [bin], { env: { ...process.env, PATH: RUN_PATH }, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

// ---------- KI-Hub: CLIs mit Abo-Login, keine API-Keys ----------
const authDir = (id) => path.join(DIRS.data, 'auth', id);
const PROVIDERS = {
  claude: {
    name: 'Claude', bin: 'claude',
    env: () => ({ CLAUDE_CONFIG_DIR: authDir('claude') }),
    args: (p, o) => ['-p', p, '--output-format', 'stream-json', '--verbose', ...(o.model ? ['--model', o.model] : [])],
    parse: 'claude-json',
    login: [],
  },
  codex: {
    name: 'Codex', bin: 'codex',
    env: () => ({ CODEX_HOME: authDir('codex') }),
    args: (p, o) => ['exec', '--skip-git-repo-check', ...(o.model ? ['-m', o.model] : []), p],
    parse: 'text',
    login: ['login'],
  },
  gemini: {
    name: 'Gemini', bin: 'gemini',
    env: () => ({ HOME: authDir('gemini'), USERPROFILE: authDir('gemini') }),
    args: (p, o) => [...(o.model ? ['-m', o.model] : []), '-p', p],
    parse: 'text',
    login: [],
  },
  ollama: {
    name: 'Ollama (lokal)', bin: 'ollama',
    env: () => ({}),
    args: (p, o) => ['run', o.model || 'llama3.2', p],
    parse: 'text',
    login: null,
  },
};

function providerStatus() {
  return Object.entries(PROVIDERS).map(([id, p]) => {
    const bin = which(p.bin);
    let loggedIn = null;
    if (p.login) {
      const d = authDir(id);
      loggedIn = fs.existsSync(d) && fs.readdirSync(d).length > 0;
    }
    return { id, name: p.name, installed: !!bin, path: bin, loggedIn };
  });
}

function runProvider(id, prompt, opts = {}) {
  const p = PROVIDERS[id];
  if (!p) throw new Error('Unbekanntes Modell: ' + id);
  if (id !== 'ollama') fs.mkdirSync(authDir(id), { recursive: true });
  return spawn(p.bin, p.args(prompt, opts), {
    cwd: opts.cwd || DIRS.data,
    env: { ...process.env, PATH: RUN_PATH, ...p.env(), NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
}

// Claude stream-json -> reiner Text
function claudeChunk(line) {
  try {
    const m = JSON.parse(line);
    if (m.type === 'assistant' && m.message && Array.isArray(m.message.content)) {
      return m.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
    }
    if (m.type === 'result' && m.is_error) return '\n[Fehler] ' + (m.result || '');
  } catch { /* keine JSON-Zeile */ }
  return '';
}

// ---------- Module ----------
function loadModules() {
  if (!fs.existsSync(DIRS.modules)) return [];
  return fs.readdirSync(DIRS.modules, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const f = path.join(DIRS.modules, d.name, 'module.json');
      if (!fs.existsSync(f)) return null;
      try {
        const m = JSON.parse(fs.readFileSync(f, 'utf8'));
        return { id: d.name, icon: '◇', order: 100, ui: 'index.html', ...m, url: `/modules/${d.name}/${m.ui || 'index.html'}` };
      } catch (e) {
        console.warn('Modul fehlerhaft:', d.name, e.message);
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.order - b.order);
}

// ---------- Event-Bus (Server-Sent Events) ----------
const listeners = new Set();
function emit(type, payload, from = 'zentrale') {
  const msg = `data: ${JSON.stringify({ type, payload, from, ts: Date.now() })}\n\n`;
  for (const res of listeners) res.write(msg);
}

// ---------- Store (einfacher Key-Value pro Modul) ----------
const storeFile = (mod) => path.join(DIRS.data, 'store', mod.replace(/[^a-z0-9_-]/gi, '') + '.json');
function readStore(mod) {
  try { return JSON.parse(fs.readFileSync(storeFile(mod), 'utf8')); } catch { return {}; }
}
function writeStore(mod, obj) {
  fs.mkdirSync(path.dirname(storeFile(mod)), { recursive: true });
  fs.writeFileSync(storeFile(mod), JSON.stringify(obj, null, 2));
}

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  });
}

function serveStatic(res, base, rel) {
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base)) return sendJSON(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return sendJSON(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  try {
    if (p === '/api/info') return sendJSON(res, 200, { version: VERSION, platform: process.platform, docker: fs.existsSync('/.dockerenv'), data: DIRS.data });
    if (p === '/api/modules') return sendJSON(res, 200, loadModules());
    if (p === '/api/ki/status') return sendJSON(res, 200, providerStatus());

    if (p === '/api/ki/ask' && req.method === 'POST') {
      const { provider = 'claude', prompt, model } = await readBody(req);
      if (!prompt) return sendJSON(res, 400, { error: 'prompt fehlt' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
      let child;
      try { child = runProvider(provider, prompt, { model }); } catch (e) { send('error', e.message); return res.end(); }
      const mode = PROVIDERS[provider].parse;
      let buf = '';
      child.stdout.on('data', (d) => {
        if (mode === 'text') return send('chunk', d.toString());
        buf += d.toString();
        const lines = buf.split('\n'); buf = lines.pop();
        for (const l of lines) { const t = claudeChunk(l); if (t) send('chunk', t); }
      });
      child.stderr.on('data', (d) => send('log', d.toString()));
      child.on('error', (e) => { send('error', e.code === 'ENOENT' ? `${provider} CLI nicht gefunden – in runtime/bin ablegen oder installieren.` : e.message); res.end(); });
      child.on('close', (code) => { if (buf) { const t = claudeChunk(buf); if (t) send('chunk', t); } send('done', { code }); res.end(); });
      req.on('close', () => child.kill());
      return;
    }

    if (p === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': ok\n\n');
      listeners.add(res);
      req.on('close', () => listeners.delete(res));
      return;
    }
    if (p === '/api/events' && req.method === 'POST') {
      const { type, payload, from } = await readBody(req);
      emit(type, payload, from);
      return sendJSON(res, 200, { ok: true });
    }

    const sm = p.match(/^\/api\/store\/([\w-]+)$/);
    if (sm && req.method === 'GET') return sendJSON(res, 200, readStore(sm[1]));
    if (sm && req.method === 'PUT') { writeStore(sm[1], await readBody(req)); return sendJSON(res, 200, { ok: true }); }

    if (p.startsWith('/modules/')) return serveStatic(res, DIRS.modules, p.slice('/modules/'.length));
    if (p === '/zentrale-sdk.js') return serveStatic(res, DIRS.ui, 'zentrale-sdk.js');
    return serveStatic(res, DIRS.ui, p === '/' ? 'index.html' : p.slice(1));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJSON(res, 500, { error: e.message });
  }
});

// ---------- CLI ----------
const [cmd, arg] = process.argv.slice(2);
if (cmd === 'login') {
  const p = PROVIDERS[arg];
  if (!p || !p.login) { console.log('Nutzung: node server.js login claude|codex|gemini'); process.exit(1); }
  fs.mkdirSync(authDir(arg), { recursive: true });
  console.log(`> Anmeldung bei ${p.name} – Daten landen in ${authDir(arg)}`);
  const c = spawn(p.bin, p.login, { stdio: 'inherit', env: { ...process.env, PATH: RUN_PATH, ...p.env() }, shell: process.platform === 'win32' });
  c.on('error', () => { console.error(`${p.bin} nicht gefunden.`); process.exit(1); });
  c.on('close', (code) => process.exit(code || 0));
} else {
  server.listen(PORT, HOST, () => {
    const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
    console.log(`〄 MRPG Zentrale ${VERSION} läuft auf ${url}`);
    if (!process.env.NO_BROWSER && !fs.existsSync('/.dockerenv')) {
      const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
      spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    }
  });
}
