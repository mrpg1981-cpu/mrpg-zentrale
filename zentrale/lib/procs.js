'use strict';
// Prozess-Manager: Dev-Server, Builds, Skripte starten/stoppen mit Live-Log
const { spawn } = require('child_process');
const crypto = require('crypto');

const MAX_LOG = 2000; // Zeilen pro Prozess

module.exports = function createProcs({ runEnv, emit }) {
  const procs = new Map(); // id -> { id, name, cmd, cwd, pid, status, code, started, ended, log[], subs:Set, child }

  function info(p) {
    const { child, subs, log, ...rest } = p;
    return rest;
  }

  function push(p, stream, text) {
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      const entry = { t: Date.now(), s: stream, line };
      p.log.push(entry);
      if (p.log.length > MAX_LOG) p.log.shift();
      for (const fn of p.subs) fn('line', entry);
    }
  }

  function start({ name, cmd, cwd }) {
    if (!cmd) throw Object.assign(new Error('Befehl fehlt'), { status: 400 });
    const id = crypto.randomBytes(4).toString('hex');
    const child = spawn(cmd, {
      cwd, shell: true, env: { ...runEnv(), FORCE_COLOR: '0' },
      detached: process.platform !== 'win32', // eigene Prozessgruppe -> ganzen Baum stoppen
    });
    const p = { id, name: name || cmd, cmd, cwd, pid: child.pid, status: 'läuft', code: null, started: Date.now(), ended: null, log: [], subs: new Set(), child };
    procs.set(id, p);
    child.stdout.on('data', (d) => push(p, 'out', d.toString()));
    child.stderr.on('data', (d) => push(p, 'err', d.toString()));
    child.on('error', (e) => push(p, 'err', e.message));
    child.on('close', (code) => {
      p.status = p.status === 'gestoppt' ? 'gestoppt' : code === 0 ? 'fertig' : 'fehler';
      p.code = code; p.ended = Date.now();
      for (const fn of p.subs) fn('status', info(p));
      emit('proc.exit', info(p));
    });
    emit('proc.start', info(p));
    return info(p);
  }

  function stop(id) {
    const p = procs.get(id);
    if (!p) throw Object.assign(new Error('Prozess nicht gefunden'), { status: 404 });
    if (p.status !== 'läuft') return info(p);
    p.status = 'gestoppt';
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(p.pid), '/t', '/f']);
      else process.kill(-p.pid, 'SIGTERM');
    } catch { try { p.child.kill('SIGTERM'); } catch {} }
    setTimeout(() => { if (p.ended === null) try { process.kill(-p.pid, 'SIGKILL'); } catch {} }, 4000);
    return info(p);
  }

  function remove(id) {
    const p = procs.get(id);
    if (p && p.status === 'läuft') stop(id);
    procs.delete(id);
  }

  function subscribe(id, fn) {
    const p = procs.get(id);
    if (!p) throw Object.assign(new Error('Prozess nicht gefunden'), { status: 404 });
    for (const e of p.log) fn('line', e);
    fn('status', info(p));
    p.subs.add(fn);
    return () => p.subs.delete(fn);
  }

  function stopAll() { for (const p of procs.values()) if (p.status === 'läuft') stop(p.id); }

  return { list: () => [...procs.values()].map(info), start, stop, remove, subscribe, stopAll };
};
