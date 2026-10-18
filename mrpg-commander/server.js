// MRPG Commander – lokaler Backend-Server fuer FTP/SFTP (laeuft nur auf 127.0.0.1)
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const SftpClient = require('ssh2-sftp-client');
const ftp = require('basic-ftp');

const PORT = process.env.PORT || 8021;
let remote = null; // { proto, client, info }

const send = (res, code, data) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
};
const body = req => new Promise((ok, fail) => {
  let s = '';
  req.on('data', c => (s += c));
  req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { fail(e); } });
});
const rjoin = (a, b) => (a.endsWith('/') ? a : a + '/') + b;

// ---------- Lokal ----------
const local = {
  async list(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const out = [];
    for (const e of entries) {
      try {
        const st = await fsp.stat(path.join(dir, e.name));
        out.push({ name: e.name, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs });
      } catch { /* kaputter Link o.ae. */ }
    }
    return out;
  },
  mkdir: p => fsp.mkdir(p, { recursive: true }),
  remove: p => fsp.rm(p, { recursive: true, force: true }),
  rename: (a, b) => fsp.rename(a, b),
};

// ---------- Remote ----------
async function connect({ proto, host, port, user, pass }) {
  await disconnect();
  if (proto === 'sftp') {
    const c = new SftpClient();
    await c.connect({ host, port: +port || 22, username: user, password: pass, readyTimeout: 15000 });
    remote = { proto, client: c, home: await c.cwd() };
  } else {
    const c = new ftp.Client(20000);
    await c.access({ host, port: +port || 21, user, password: pass, secure: proto === 'ftps' ? true : false,
      secureOptions: { rejectUnauthorized: false } });
    remote = { proto, client: c, home: await c.pwd() };
  }
  remote.info = `${proto}://${user}@${host}`;
  return remote.home;
}
async function disconnect() {
  if (!remote) return;
  try { remote.proto === 'sftp' ? await remote.client.end() : remote.client.close(); } catch {}
  remote = null;
}
const need = () => { if (!remote) throw new Error('Nicht verbunden'); return remote; };

const rem = {
  async list(dir) {
    const r = need();
    if (r.proto === 'sftp') {
      return (await r.client.list(dir)).map(f => ({ name: f.name, dir: f.type === 'd', size: f.size, mtime: f.modifyTime }));
    }
    return (await r.client.list(dir)).map(f => ({ name: f.name, dir: f.isDirectory, size: f.size, mtime: f.modifiedAt ? +f.modifiedAt : 0 }));
  },
  async isDir(p) {
    const r = need();
    if (r.proto === 'sftp') return (await r.client.exists(p)) === 'd';
    const parent = path.posix.dirname(p), name = path.posix.basename(p);
    return (await r.client.list(parent)).some(f => f.name === name && f.isDirectory);
  },
  async download(rp, lp) {
    const r = need();
    if (await this.isDir(rp)) {
      if (r.proto === 'sftp') return r.client.downloadDir(rp, lp);
      await fsp.mkdir(lp, { recursive: true });
      return r.client.downloadToDir(lp, rp);
    }
    return r.proto === 'sftp' ? r.client.fastGet(rp, lp) : r.client.downloadTo(lp, rp);
  },
  async upload(lp, rp) {
    const r = need();
    const st = await fsp.stat(lp);
    if (st.isDirectory()) {
      if (r.proto === 'sftp') return r.client.uploadDir(lp, rp);
      const back = await r.client.pwd();
      await r.client.ensureDir(rp); await r.client.uploadFromDir(lp); await r.client.cd(back);
      return;
    }
    return r.proto === 'sftp' ? r.client.fastPut(lp, rp) : r.client.uploadFrom(lp, rp);
  },
  async mkdir(p) {
    const r = need();
    if (r.proto === 'sftp') return r.client.mkdir(p, true);
    const back = await r.client.pwd(); await r.client.ensureDir(p); await r.client.cd(back);
  },
  async remove(p) {
    const r = need();
    const d = await this.isDir(p);
    if (r.proto === 'sftp') return d ? r.client.rmdir(p, true) : r.client.delete(p);
    return d ? r.client.removeDir(p) : r.client.remove(p);
  },
  rename: (a, b) => need().client.rename(a, b),
};

// ---------- API ----------
const routes = {
  'POST /api/connect': async b => ({ home: await connect(b) }),
  'POST /api/disconnect': async () => (await disconnect(), {}),
  'GET /api/status': async () => ({ connected: !!remote, info: remote && remote.info, home: remote && remote.home, localHome: os.homedir() }),
  'POST /api/list': async b => ({ files: await (b.side === 'remote' ? rem : local).list(b.path) }),
  'POST /api/mkdir': async b => (await (b.side === 'remote' ? rem : local).mkdir(b.path), {}),
  'POST /api/delete': async b => (await (b.side === 'remote' ? rem : local).remove(b.path), {}),
  'POST /api/rename': async b => (await (b.side === 'remote' ? rem : local).rename(b.from, b.to), {}),
  // Kopieren zwischen den Panels: names[] aus srcDir nach dstDir
  'POST /api/copy': async b => {
    for (const n of b.names) {
      if (b.dir === 'up') await rem.upload(path.join(b.src, n), rjoin(b.dst, n));
      else await rem.download(rjoin(b.src, n), path.join(b.dst, n));
    }
    return {};
  },
};

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
  }
  const h = routes[`${req.method} ${url}`];
  if (!h) return send(res, 404, { error: 'Unbekannt' });
  try { send(res, 200, await h(await body(req))); }
  catch (e) { send(res, 500, { error: e.message }); }
}).listen(PORT, '127.0.0.1', () => console.log(`MRPG Commander laeuft: http://127.0.0.1:${PORT}`));
