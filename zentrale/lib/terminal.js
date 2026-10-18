'use strict';
// Terminal-Sitzungen (node-pty, Fallback ohne pty) – Verbindung per WebSocket
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');

let pty = null;
try { pty = require('node-pty'); } catch { /* Fallback auf einfache Pipes */ }

const MAX_BUFFER = 200 * 1024;

function defaultShell(settings) {
  if (settings.get().shell) return settings.get().shell;
  if (process.platform === 'win32') return process.env.COMSPEC || 'powershell.exe';
  return process.env.SHELL || '/bin/bash';
}

module.exports = function createTerminals({ settings, runEnv }) {
  const terms = new Map(); // id -> { id, title, proc, buffer, clients:Set, exited }

  function create({ cwd, title, command, args, env, input } = {}) {
    const id = crypto.randomBytes(4).toString('hex');
    const file = command || defaultShell(settings);
    const argv = args || [];
    const fullEnv = { ...runEnv(), ...(env || {}), TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    const dir = cwd || settings.get().projectsDir || os.homedir();
    const t = { id, title: title || file.split(/[\\/]/).pop(), cwd: dir, buffer: '', clients: new Set(), exited: null, created: Date.now() };

    const out = (data) => {
      t.buffer += data;
      if (t.buffer.length > MAX_BUFFER) t.buffer = t.buffer.slice(-MAX_BUFFER);
      for (const ws of t.clients) ws.send(JSON.stringify({ type: 'data', data }));
    };
    const exit = (code) => {
      t.exited = code ?? 0;
      out(`\r\n\x1b[90m[Prozess beendet: ${t.exited}]\x1b[0m\r\n`);
      for (const ws of t.clients) ws.send(JSON.stringify({ type: 'exit', code: t.exited }));
    };

    if (pty) {
      const p = pty.spawn(file, argv, { name: 'xterm-256color', cols: 100, rows: 30, cwd: dir, env: fullEnv });
      p.onData(out);
      p.onExit(({ exitCode }) => exit(exitCode));
      t.write = (d) => p.write(d);
      t.resize = (c, r) => { try { p.resize(c, r); } catch {} };
      t.kill = () => { try { p.kill(); } catch {} };
    } else {
      const p = spawn(file, argv.length ? argv : process.platform === 'win32' ? [] : ['-i'], { cwd: dir, env: fullEnv });
      p.stdout.on('data', (d) => out(d.toString()));
      p.stderr.on('data', (d) => out(d.toString()));
      p.on('close', exit);
      p.on('error', (e) => out(`\r\nFehler: ${e.message}\r\n`));
      t.write = (d) => p.stdin.write(d.replace(/\r/g, '\n'));
      t.resize = () => {};
      t.kill = () => p.kill();
      out('\x1b[33m[Einfaches Terminal ohne pty – node-pty installieren für volle Funktion]\x1b[0m\r\n');
    }
    terms.set(id, t);
    if (input) setTimeout(() => t.write(input), 300);
    return info(t);
  }

  function info(t) {
    return { id: t.id, title: t.title, cwd: t.cwd, exited: t.exited, created: t.created, clients: t.clients.size };
  }

  function attach(id, ws) {
    const t = terms.get(id);
    if (!t) { ws.send(JSON.stringify({ type: 'error', data: 'Terminal nicht gefunden' })); return ws.close(); }
    t.clients.add(ws);
    if (t.buffer) ws.send(JSON.stringify({ type: 'data', data: t.buffer }));
    if (t.exited !== null) ws.send(JSON.stringify({ type: 'exit', code: t.exited }));
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (t.exited !== null) return;
      if (m.type === 'input') t.write(m.data);
      if (m.type === 'resize' && m.cols > 0 && m.rows > 0) t.resize(m.cols, m.rows);
    });
    ws.on('close', () => t.clients.delete(ws));
  }

  function kill(id) {
    const t = terms.get(id);
    if (!t) return;
    if (t.exited === null) t.kill();
    for (const ws of t.clients) ws.close();
    terms.delete(id);
  }

  return {
    hasPty: !!pty,
    list: () => [...terms.values()].map(info),
    create, attach, kill,
    killAll: () => { for (const id of [...terms.keys()]) kill(id); },
  };
};
