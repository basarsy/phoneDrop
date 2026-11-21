// Builds dist/PhoneDrop.exe (or dist/PhoneDrop on macOS/Linux) as a Node.js single executable application.
// Usage: npm run build   (requires the official Node.js binary, v20+; downloads postject via npx)

const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const blob = path.join(dist, 'sea-prep.blob');
const exe = path.join(dist, process.platform === 'win32' ? 'PhoneDrop.exe' : 'PhoneDrop');
const run = (cmd, args) => execSync([cmd, ...args].map(a => /[\s"]/.test(a) ? JSON.stringify(a) : a).join(' '), { cwd: root, stdio: 'inherit' });

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

console.log('> Generating SEA blob');
execFileSync(process.execPath, ['--experimental-sea-config', 'sea-config.json'], { cwd: root, stdio: 'inherit' });

console.log('> Copying node binary');
fs.copyFileSync(process.execPath, exe);

console.log('> Injecting blob');
const args = ['--yes', 'postject@1.0.0-alpha.6', exe, 'NODE_SEA_BLOB', blob,
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
run('npx', args);

fs.rmSync(blob);
console.log(`\nBuilt ${path.relative(root, exe)}`);
