'use strict';
// Systeminfo, Projekte, Backup und Updates
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 15000, maxBuffer: 10e6, ...opts }, (err, stdout, stderr) => {
    resolve({ ok: !err, code: err ? err.code : 0, stdout: String(stdout || ''), stderr: String(stderr || (err && err.message) || '') });
  });
});

module.exports = function createSystem({ root, dataDir, settings, runEnv }) {
  // ---------- CPU-Auslastung aus zwei Messpunkten ----------
  let last = os.cpus();
  let cpuPercent = 0;
  setInterval(() => {
    const now = os.cpus();
    let idle = 0, total = 0;
    now.forEach((c, i) => {
      const a = c.times, b = (last[i] || c).times;
      const t = (a.user - b.user) + (a.nice - b.nice) + (a.sys - b.sys) + (a.irq - b.irq) + (a.idle - b.idle);
      total += t; idle += a.idle - b.idle;
    });
    cpuPercent = total ? Math.round((1 - idle / total) * 100) : 0;
    last = now;
  }, 2000).unref();

  async function disks() {
    if (process.platform === 'win32') return [];
    const r = await run('df', ['-kP']);
    return r.stdout.split('\n').slice(1).filter(Boolean).map((l) => {
      const p = l.split(/\s+/);
      return { fs: p[0], size: +p[1] * 1024, used: +p[2] * 1024, mount: p[5] };
    }).filter((d) => d.size > 1e9 && !/^(tmpfs|devtmpfs|overlay|shm|none)$/.test(d.fs) || d.mount === '/');
  }

  async function docker() {
    const r = await run('docker', ['ps', '-a', '--format', '{{json .}}']);
    if (!r.ok) return null;
    return r.stdout.split('\n').filter(Boolean).map((l) => {
      try { const c = JSON.parse(l); return { id: c.ID, name: c.Names, image: c.Image, state: c.State, status: c.Status, ports: c.Ports }; } catch { return null; }
    }).filter(Boolean);
  }

  async function info() {
    return {
      host: os.hostname(), platform: process.platform, release: os.release(), arch: os.arch(),
      uptime: os.uptime(), load: os.loadavg(), cpus: os.cpus().length, cpuModel: (os.cpus()[0] || {}).model,
      cpu: cpuPercent, memTotal: os.totalmem(), memFree: os.freemem(),
      disks: await disks(), docker: await docker(),
      node: process.version, inDocker: fs.existsSync('/.dockerenv'),
    };
  }

  // ---------- Projekte ----------
  async function projectInfo(dir) {
    const name = path.basename(dir);
    const has = (f) => fs.existsSync(path.join(dir, f));
    const p = { name, path: name, git: null, type: [], scripts: {} };
    if (has('package.json')) {
      p.type.push('node');
      try { p.scripts = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8')).scripts || {}; } catch {}
    }
    if (has('requirements.txt') || has('pyproject.toml')) p.type.push('python');
    if (has('Dockerfile') || has('docker-compose.yml') || has('compose.yml')) p.type.push('docker');
    if (has('index.html')) p.type.push('web');
    if (has('Cargo.toml')) p.type.push('rust');
    if (has('go.mod')) p.type.push('go');
    if (has('.git')) {
      const [st, lg, rm] = await Promise.all([
        run('git', ['-C', dir, 'status', '--porcelain=v1', '-b']),
        run('git', ['-C', dir, 'log', '-1', '--format=%h%x09%s%x09%cr']),
        run('git', ['-C', dir, 'remote', 'get-url', 'origin']),
      ]);
      const lines = st.stdout.split('\n').filter(Boolean);
      const head = (lines.shift() || '').replace(/^## /, '');
      const m = head.match(/^([^.\s]+)(?:\.\.\.\S+)?(?: \[(.*)\])?/) || [];
      const [hash, subject, when] = lg.stdout.trim().split('\t');
      p.git = {
        branch: m[1] || head, tracking: m[2] || '', changes: lines.length,
        ahead: +((m[2] || '').match(/ahead (\d+)/) || [0, 0])[1], behind: +((m[2] || '').match(/behind (\d+)/) || [0, 0])[1],
        last: hash ? { hash, subject, when } : null, remote: rm.stdout.trim(),
      };
    }
    try { p.mtime = (await fsp.stat(dir)).mtimeMs; } catch {}
    return p;
  }

  async function projects() {
    const base = path.resolve(settings.get().projectsDir);
    if (!fs.existsSync(base)) return { base, exists: false, items: [] };
    const entries = (await fsp.readdir(base, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith('.'));
    const items = await Promise.all(entries.map((e) => projectInfo(path.join(base, e.name))));
    return { base, exists: true, items: items.sort((a, b) => (b.mtime || 0) - (a.mtime || 0)) };
  }

  // ---------- Backup von data/ (ohne Logins, außer gewünscht) ----------
  function backup(res, { withAuth = false } = {}) {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="zentrale-backup-${stamp}.tar.gz"` });
    const args = ['-czf', '-', ...(withAuth ? [] : ['--exclude=./auth']), '-C', dataDir, '.'];
    const tar = spawn('tar', args);
    tar.stdout.pipe(res);
    tar.on('error', () => res.end());
  }

  function restore(buf) {
    return new Promise((resolve, reject) => {
      const tar = spawn('tar', ['-xzf', '-', '-C', dataDir]);
      let err = '';
      tar.stderr.on('data', (d) => { err += d; });
      tar.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err || 'Wiederherstellen fehlgeschlagen'))));
      tar.on('error', reject);
      tar.stdin.end(buf);
    });
  }

  // ---------- Update per git pull ----------
  async function updateCheck() {
    const r = await run('git', ['-C', root, 'rev-parse', '--show-toplevel']);
    if (!r.ok) return { git: false };
    await run('git', ['-C', root, 'fetch', '--quiet'], { timeout: 30000, env: runEnv() });
    const [st, head] = await Promise.all([
      run('git', ['-C', root, 'status', '-sb']),
      run('git', ['-C', root, 'log', '-1', '--format=%h %s (%cr)']),
    ]);
    const first = st.stdout.split('\n')[0] || '';
    return { git: true, status: first.replace(/^## /, ''), behind: +((first.match(/behind (\d+)/) || [0, 0])[1]), current: head.stdout.trim() };
  }

  async function updatePull() {
    const r = await run('git', ['-C', root, 'pull', '--ff-only'], { timeout: 60000, env: runEnv() });
    return { ok: r.ok, output: (r.stdout + r.stderr).trim() };
  }

  return { info, projects, backup, restore, updateCheck, updatePull, run };
};
