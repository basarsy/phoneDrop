#!/usr/bin/env node
// PhoneDrop — send messages, photos and files from your phone to this PC over Wi-Fi.
// Zero dependencies: just run `node server.js`.

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');

const PORT = Number(process.env.PORT) || 8765;
const SAVE_DIR = path.resolve(process.env.PHONEDROP_DIR || path.join(os.homedir(), 'Downloads', 'PhoneDrop'));
const META_DIR = path.join(SAVE_DIR, '.phonedrop');
const MESSAGES_FILE = path.join(META_DIR, 'messages.json');
const TOKEN_FILE = path.join(META_DIR, 'token');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_MESSAGE_BYTES = 1024 * 1024;

// When packaged as a single executable (PhoneDrop.exe), the page is embedded as an asset.
let sea = null;
try { sea = require('node:sea'); if (!sea.isSea()) sea = null; } catch { sea = null; }
const loadIndexHtml = () => sea ? sea.getAsset('index.html', 'utf8') : fsp.readFile(path.join(PUBLIC_DIR, 'index.html'));

// If launched by double-clicking the exe, keep the window open on a fatal error so it can be read.
function fatal(err) {
  console.error('\n  PhoneDrop failed to start:', err && err.code === 'EADDRINUSE'
    ? `port ${PORT} is already in use (is PhoneDrop already running?)` : (err && err.message) || err);
  if (!sea) process.exit(1);
  console.error('\n  Press Enter to close.');
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(1));
}

fs.mkdirSync(META_DIR, { recursive: true });

// A persistent secret so only devices that scanned the QR code can use the app.
let TOKEN;
try { TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch {}
if (!TOKEN || TOKEN.length < 16) {
  TOKEN = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(TOKEN_FILE, TOKEN);
}

let messages = [];
try { messages = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8')); } catch {}
const saveMessages = () => fsp.writeFile(MESSAGES_FILE, JSON.stringify(messages, null, 2));

// ---------- helpers ----------

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      // Skip common virtual adapters (WSL, Hyper-V, VirtualBox, VMware, Docker).
      if (/vEthernet|VirtualBox|VMware|WSL|Docker|Loopback/i.test(name)) continue;
      out.push(a.address);
    }
  }
  // Prefer typical home-network ranges first.
  const rank = ip => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b));
}

const isLocal = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

const isAuthed = req => isLocal(req) || safeEqual(parseCookies(req).pd_token || '', TOKEN);

function sanitizeName(name) {
  let n = path.basename(String(name || '')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  n = n.replace(/^\.+/, '').slice(0, 200);
  return n || `file-${Date.now()}`;
}

async function uniqueName(name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 0; ; i++) {
    const candidate = i === 0 ? name : `${base} (${i})${ext}`;
    try { await fsp.access(path.join(SAVE_DIR, candidate)); } catch { return candidate; }
  }
}

// Resolve a requested file name to a path inside SAVE_DIR, or null.
function resolveSaved(name) {
  const n = path.basename(name);
  if (!n || n.startsWith('.') || n !== name) return null;
  return path.join(SAVE_DIR, n);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.heic': 'image/heic', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.zip': 'application/zip',
};
const mimeOf = f => MIME[path.extname(f).toLowerCase()] || 'application/octet-stream';

function send(res, status, body, headers = {}) {
  const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Too large'), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------- live updates (Server-Sent Events) ----------

const clients = new Set();
function broadcast(event) {
  for (const res of clients) res.write(`data: ${JSON.stringify(event)}\n\n`);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();

// ---------- items ----------

async function listItems() {
  const files = [];
  for (const ent of await fsp.readdir(SAVE_DIR, { withFileTypes: true })) {
    if (!ent.isFile() || ent.name.startsWith('.') || ent.name.endsWith('.part')) continue;
    const st = await fsp.stat(path.join(SAVE_DIR, ent.name));
    files.push({ type: 'file', id: ent.name, name: ent.name, size: st.size, time: st.mtimeMs, mime: mimeOf(ent.name) });
  }
  const items = [...files, ...messages.map(m => ({ type: 'message', ...m }))];
  return items.sort((a, b) => b.time - a.time);
}

function deviceLabel(req) {
  if (isLocal(req)) return 'PC';
  const ua = req.headers['user-agent'] || '';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android';
  return 'Device';
}

// ---------- routes ----------

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  // Pairing: the QR code points to /?k=TOKEN, which sets a long-lived cookie.
  if (req.method === 'GET' && p === '/' && url.searchParams.has('k')) {
    if (safeEqual(url.searchParams.get('k'), TOKEN)) {
      return send(res, 302, '', {
        Location: '/',
        'Set-Cookie': `pd_token=${TOKEN}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`,
      });
    }
    return send(res, 403, 'Invalid or expired link. Scan the QR code on your PC again.');
  }

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    if (!isAuthed(req)) {
      return send(res, 401, '<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">' +
        '<body style="font-family:system-ui;padding:32px;text-align:center"><h2>PhoneDrop</h2>' +
        '<p>Scan the QR code shown on your PC to connect this device.</p>', { 'Content-Type': 'text/html; charset=utf-8' });
    }
    const html = await loadIndexHtml();
    return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
  }

  if (!isAuthed(req)) return send(res, 401, { error: 'Not paired. Scan the QR code on your PC.' });

  if (req.method === 'GET' && p === '/api/info') {
    const info = { device: deviceLabel(req), isHost: isLocal(req), saveDir: isLocal(req) ? SAVE_DIR : undefined };
    if (isLocal(req)) {
      info.urls = lanAddresses().map(ip => `http://${ip}:${PORT}/?k=${TOKEN}`);
    }
    return send(res, 200, info);
  }

  if (req.method === 'GET' && p === '/api/items') return send(res, 200, await listItems());

  if (req.method === 'GET' && p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (req.method === 'POST' && p === '/api/message') {
    const body = JSON.parse((await readBody(req, MAX_MESSAGE_BYTES)).toString('utf8') || '{}');
    const text = String(body.text || '');
    if (!text.trim()) return send(res, 400, { error: 'Empty message' });
    const msg = { id: crypto.randomUUID(), text, from: deviceLabel(req), time: Date.now() };
    messages.push(msg);
    await saveMessages();
    broadcast({ kind: 'changed' });
    console.log(`  ✉  message from ${msg.from} (${text.length} chars)`);
    return send(res, 201, msg);
  }

  if (req.method === 'DELETE' && p.startsWith('/api/message/')) {
    const id = decodeURIComponent(p.slice('/api/message/'.length));
    messages = messages.filter(m => m.id !== id);
    await saveMessages();
    broadcast({ kind: 'changed' });
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && p === '/api/upload') {
    // Raw body upload (no multipart parsing): file name travels in the query string.
    const name = await uniqueName(sanitizeName(url.searchParams.get('name')));
    const final = path.join(SAVE_DIR, name);
    const tmp = `${final}.${crypto.randomBytes(4).toString('hex')}.part`;
    const out = fs.createWriteStream(tmp);
    let failed = false;
    const fail = async () => {
      if (failed) return; failed = true;
      out.destroy();
      await fsp.rm(tmp, { force: true });
    };
    req.on('close', () => { if (!req.complete) fail(); });
    req.pipe(out);
    out.on('error', async err => { await fail(); if (!res.headersSent) send(res, 500, { error: err.message }); });
    out.on('finish', async () => {
      if (failed) return;
      const finalName = await uniqueName(name); // re-check in case of a race with a parallel upload
      await fsp.rename(tmp, path.join(SAVE_DIR, finalName));
      const st = await fsp.stat(path.join(SAVE_DIR, finalName));
      console.log(`  ⬇  ${finalName} from ${deviceLabel(req)} (${(st.size / 1048576).toFixed(2)} MB)`);
      broadcast({ kind: 'changed' });
      send(res, 201, { name: finalName, size: st.size });
    });
    return;
  }

  if ((req.method === 'GET' || req.method === 'DELETE') && p.startsWith('/files/')) {
    const file = resolveSaved(decodeURIComponent(p.slice('/files/'.length)));
    if (!file) return send(res, 400, { error: 'Bad file name' });
    let st;
    try { st = await fsp.stat(file); } catch { return send(res, 404, { error: 'Not found' }); }

    if (req.method === 'DELETE') {
      await fsp.rm(file);
      broadcast({ kind: 'changed' });
      return send(res, 200, { ok: true });
    }

    const disp = url.searchParams.get('dl') === '1' ? 'attachment' : 'inline';
    res.writeHead(200, {
      'Content-Type': mimeOf(file),
      'Content-Length': st.size,
      'Content-Disposition': `${disp}; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
      'Cache-Control': 'private, max-age=60',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(file).pipe(res);
    return;
  }

  if (req.method === 'POST' && p === '/api/open-folder' && isLocal(req)) {
    const cmd = process.platform === 'win32' ? `explorer "${SAVE_DIR}"`
      : process.platform === 'darwin' ? `open "${SAVE_DIR}"` : `xdg-open "${SAVE_DIR}"`;
    exec(cmd);
    return send(res, 200, { ok: true });
  }

  send(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    console.error(err);
    if (!res.headersSent) send(res, err.status || 500, { error: err.message || 'Server error' });
    else res.end();
  });
});
server.requestTimeout = 0; // allow very large / slow uploads
server.on('error', fatal);

server.listen(PORT, '0.0.0.0', () => {
  const local = `http://localhost:${PORT}`;
  const ips = lanAddresses();
  console.log('\n  PhoneDrop is running\n');
  console.log(`  On this PC:   ${local}`);
  for (const ip of ips) console.log(`  Phone link:   http://${ip}:${PORT}/?k=${TOKEN}`);
  if (!ips.length) console.log('  (No Wi-Fi/LAN address found — is this PC connected to a network?)');
  console.log(`  Saving to:    ${SAVE_DIR}\n`);
  console.log('  Open the PC page and scan the QR code with your phone. Ctrl+C to stop.\n');
  if (!process.env.NO_OPEN) {
    const opener = process.platform === 'win32' ? `start "" "${local}"`
      : process.platform === 'darwin' ? `open "${local}"` : `xdg-open "${local}"`;
    exec(opener);
  }
});
