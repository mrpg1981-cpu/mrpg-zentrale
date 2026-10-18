// Baut portable Versionen nach dist/: eine Datei mrpg-commander.js (braucht nur Node)
// und – wenn node-Binaries in build-bin/ liegen – fertige EXE/Binaries ohne Installation.
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
const dist = path.join(__dirname, 'dist'); fs.mkdirSync(dist, { recursive: true });
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
require('esbuild').buildSync({
  entryPoints: [path.join(__dirname, 'server.js')], bundle: true, platform: 'node', target: 'node22',
  outfile: path.join(dist, 'mrpg-commander.js'), define: { __HTML__: JSON.stringify(html) },
  external: ['cpu-features', '*.node'], minify: true, legalComments: 'none', logLevel: 'error',
});
fs.writeFileSync(path.join(dist, 'sea.json'), JSON.stringify({ main: path.join(dist, 'mrpg-commander.js'),
  output: path.join(dist, 'sea.blob'), disableExperimentalSEAWarning: true }));
execSync(`node --experimental-sea-config ${path.join(dist, 'sea.json')}`, { stdio: 'inherit' });
const targets = [['node.exe', 'MRPG-Commander.exe'], ['node-linux', 'MRPG-Commander-linux']];
for (const [src, out] of targets) {
  const bin = path.join(__dirname, 'build-bin', src);
  if (!fs.existsSync(bin)) continue;
  const o = path.join(dist, out); fs.copyFileSync(bin, o); fs.chmodSync(o, 0o755);
  execSync(`npx postject "${o}" NODE_SEA_BLOB "${path.join(dist, 'sea.blob')}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`, { stdio: 'inherit', cwd: __dirname });
  console.log('✔', out);
}
fs.rmSync(path.join(dist, 'sea.json')); fs.rmSync(path.join(dist, 'sea.blob'));
