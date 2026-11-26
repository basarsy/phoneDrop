// PhoneDrop desktop app: runs the PhoneDrop server inside Electron and shows the PC page in its own window,
// with a tray icon that keeps it running in the background and notifications for anything received.

const { app, BrowserWindow, Tray, Menu, Notification, dialog, shell, nativeImage, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const { start, DEFAULT_DIR } = require('../server');

const APP_ID = 'com.basarsy.phonedrop';
const startHidden = process.argv.includes('--hidden'); // used when launched at Windows sign-in
if (process.env.PHONEDROP_USER_DATA) app.setPath('userData', process.env.PHONEDROP_USER_DATA); // for testing

let win = null;
let tray = null;
let server = null; // result of start(): { port, saveDir, events, close }
let quitting = false;
let restarting = false;
let trayHintShown = false;

// ---------- settings (userData/config.json) ----------

const configFile = () => path.join(app.getPath('userData'), 'config.json');
function readConfig() {
  try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch { return {}; }
}
function writeConfig(patch) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify({ ...readConfig(), ...patch }, null, 2));
}

// The pairing token lives in userData so phones stay paired when the save folder changes.
// Reuse the token from a previous PhoneDrop.exe / `node server.js` install so existing phones keep working.
function tokenFile() {
  const file = path.join(app.getPath('userData'), 'token');
  if (!fs.existsSync(file)) {
    const legacy = path.join(DEFAULT_DIR, '.phonedrop', 'token');
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.copyFileSync(legacy, file);
    } catch {}
  }
  return file;
}

// ---------- server ----------

async function startServer(saveDir) {
  const s = await start({
    saveDir,
    tokenFile: tokenFile(),
    openFolder: dir => shell.openPath(dir),
    chooseFolder: () => chooseFolder(),
  });
  s.events.on('file', f => {
    if (f.from === 'PC') return;
    notify(`${f.from} sent a file`, f.name, () => showWindow());
  });
  s.events.on('message', m => {
    if (m.from === 'PC') return;
    notify(`Message from ${m.from}`, m.text.length > 200 ? m.text.slice(0, 200) + '…' : m.text, () => showWindow());
  });
  return s;
}

async function chooseFolder() {
  if (restarting) return;
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Choose where PhoneDrop saves received files',
    defaultPath: server.saveDir,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths[0] || path.resolve(filePaths[0]) === server.saveDir) return;

  restarting = true;
  const previous = server.saveDir;
  try {
    await server.close();
    try {
      server = await startServer(filePaths[0]);
      writeConfig({ saveDir: server.saveDir });
    } catch (err) {
      dialog.showErrorBox('PhoneDrop', `Could not use that folder:\n${err.message}`);
      server = await startServer(previous);
    }
  } finally {
    restarting = false;
  }
  if (win) win.reload();
  buildTrayMenu();
}

// ---------- UI ----------

function notify(title, body, onClick) {
  if (!Notification.isSupported() || (win && win.isVisible() && win.isFocused())) return;
  const n = new Notification({ title, body, icon: path.join(__dirname, 'icon.png') });
  n.on('click', onClick);
  n.show();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 420,
    minHeight: 500,
    title: 'PhoneDrop',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f4f5f7',
    show: false,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.removeMenu();

  // Load over HTTP from 127.0.0.1 so the page is treated as the PC (host) by the server.
  const origin = `http://127.0.0.1:${server.port}`;
  win.loadURL(origin + '/');

  // "Open" on a received file opens it with its default app; other links open in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.origin === origin && u.pathname.startsWith('/files/')) {
        const name = path.basename(decodeURIComponent(u.pathname.slice('/files/'.length)));
        if (name && !name.startsWith('.')) shell.openPath(path.join(server.saveDir, name));
      } else if (u.protocol === 'http:' || u.protocol === 'https:') {
        shell.openExternal(url);
      }
    } catch {}
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(origin + '/')) { e.preventDefault(); shell.openExternal(url); }
  });

  win.once('ready-to-show', () => { if (!startHidden) win.show(); });

  // Closing the window keeps PhoneDrop running in the tray so phones can still send files.
  win.on('close', e => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!trayHintShown && Notification.isSupported()) {
      trayHintShown = true;
      new Notification({
        title: 'PhoneDrop is still running',
        body: 'It keeps receiving files in the background. Use the tray icon to open or quit it.',
        icon: path.join(__dirname, 'icon.png'),
      }).show();
    }
  });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function buildTrayMenu() {
  if (!tray) return;
  const items = [
    { label: 'Open PhoneDrop', click: showWindow },
    { label: 'Open received folder', click: () => shell.openPath(server.saveDir) },
    { label: 'Change folder…', click: () => chooseFolder() },
    { type: 'separator' },
  ];
  if (app.isPackaged) {
    items.push({
      label: 'Start with Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: item => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
    }, { type: 'separator' });
  }
  items.push({ label: 'Quit PhoneDrop', click: () => { quitting = true; app.quit(); } });
  tray.setContextMenu(Menu.buildFromTemplate(items));
  tray.setToolTip(`PhoneDrop — saving to ${server.saveDir}`);
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'tray.png')));
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  buildTrayMenu();
}

// ---------- lifecycle ----------

if (!app.requestSingleInstanceLock()) {
  app.quit(); // another PhoneDrop window is already running; it will be focused via 'second-instance'
} else {
  app.on('second-instance', showWindow);
  app.setAppUserModelId(APP_ID);

  app.whenReady().then(async () => {
    try {
      server = await startServer(readConfig().saveDir || DEFAULT_DIR);
    } catch (err) {
      dialog.showErrorBox('PhoneDrop failed to start', err.message || String(err));
      app.exit(1);
      return;
    }
    createWindow();
    createTray();
  });

  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => {}); // stay alive in the tray
  app.on('will-quit', () => { if (server) server.close(); });
}
