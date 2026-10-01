// Electron wrapper for Saffron POS.
//
// This does NOT reimplement the app -- it starts the exact same Express
// server (server/index.js) that `npm start` runs, in-process, and opens a
// normal Chromium window pointed at http://localhost:<PORT>. The web app
// itself (public/) is completely unchanged and still just talks to /api/*
// on its own origin, exactly like it does in a browser tab today. That
// means this file is the only Saffron-specific Electron code that exists.
//
// Database credentials, two ways:
//  1. Bundled .env -- if whoever ran `npm run dist:win` had a real .env
//     sitting in the project root, electron-builder packages it straight
//     into the installer (see package.json "build.files"). Every install
//     then just works immediately, no setup screen at all. This is meant
//     for trusted/internal distribution (e.g. your own store registers) --
//     anyone with the installer file could in principle extract that
//     connection string, so don't hand it out beyond devices you control.
//  2. Per-device settings file -- if no .env was bundled, we fall back to
//     creating one in the user's app-data folder (survives reinstalls) and
//     ask them to fill it in once, same as before.

const { app, BrowserWindow, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const isPackaged = app.isPackaged;
// Unpackaged (dev, `npm run electron`): project root is one level up from
// this file. Packaged: everything ships unpacked under resources/app
// (see package.json "build.asar": false).
const appRoot = isPackaged ? path.join(process.resourcesPath, 'app') : path.join(__dirname, '..');

const bundledEnvPath = path.join(appRoot, '.env');
const perUserEnvPath = path.join(app.getPath('userData'), '.env');
const usingBundledEnv = fs.existsSync(bundledEnvPath);
const envPath = usingBundledEnv ? bundledEnvPath : perUserEnvPath;
const envExamplePath = path.join(appRoot, '.env.example');
const iconPath = path.join(appRoot, 'public', 'icons', 'icon-512.png');

const PORT = process.env.PORT || 3000;
const SERVER_URL = `http://localhost:${PORT}`;

let mainWindow;

function createWindow(loadUrlImmediately) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 480,
    minHeight: 640,
    title: 'Saffron POS',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    backgroundColor: '#faf9f6',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  if (loadUrlImmediately) {
    loadWhenReady();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// The server starts listening asynchronously (it waits on the DB
// connection first), so the window may exist slightly before it's ready
// to serve anything. Show a small loading screen and poll until it answers.
const MAX_LOAD_ATTEMPTS = 120; // ~60s -- enough for a cold Supabase/Neon wake-up

function loadWhenReady(attempt = 0) {
  let settled = false;

  const req = http.get(SERVER_URL, (res) => {
    settled = true;
    res.resume(); // drain the response, we don't need the body
    if (mainWindow) mainWindow.loadURL(SERVER_URL);
  });

  // A hung TCP connection (no response, no error) would otherwise freeze
  // the loading screen forever -- force it to fail so it can retry.
  req.setTimeout(2000, () => req.destroy(new Error('timeout')));

  req.on('error', () => {
    if (settled) return;
    if (attempt >= MAX_LOAD_ATTEMPTS) {
      dialog.showErrorBox(
        'Saffron POS could not start',
        `The app server never became ready after 60 seconds. Double-check your settings file:\n\n${envPath}`
      );
      return;
    }
    setTimeout(() => loadWhenReady(attempt + 1), 500);
  });

  req.end();
}

function showLoadingScreen() {
  createWindow(false);
  mainWindow.loadURL(
    'data:text/html;charset=utf-8,' +
      encodeURIComponent(`
      <html><body style="margin:0;height:100vh;display:flex;align-items:center;
        justify-content:center;background:#faf9f6;font-family:sans-serif;color:#8e8e93;">
        Starting Saffron POS&hellip;
      </body></html>
    `)
  );
}

function runFirstTimeSetup() {
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.copyFileSync(envExamplePath, envPath);

  const result = dialog.showMessageBoxSync({
    type: 'info',
    title: 'Set up Saffron POS',
    message: 'One-time setup needed',
    detail:
      `Saffron POS connects to a cloud database, so it needs a connection string the first time you run it.\n\n` +
      `We just created a settings file here:\n${envPath}\n\n` +
      `Open it, fill in DATABASE_URL (and set a real JWT_SECRET), save, then relaunch Saffron POS.`,
    buttons: ['Open Settings File', 'Quit'],
    defaultId: 0,
    cancelId: 1
  });

  if (result === 0) {
    shell.openPath(envPath);
    shell.showItemInFolder(envPath);
  }
  app.quit();
}

app.whenReady().then(() => {
  if (!usingBundledEnv && !fs.existsSync(perUserEnvPath)) {
    runFirstTimeSetup();
    return;
  }

  // override: true so the settings file always wins, even if a stale
  // DATABASE_URL/JWT_SECRET is already sitting in the environment (e.g.
  // left over from an earlier `set` in the same terminal session).
  require('dotenv').config({ path: envPath, override: true });

  // server/db.js and server/index.js console.error the real reason (bad
  // connection string, DNS failure, auth failure, etc.) right before calling
  // process.exit(1). Capture that so the dialog shows the actual cause
  // instead of a generic guess.
  let lastError = '';
  const originalConsoleError = console.error.bind(console);
  console.error = (...args) => {
    lastError = args.map((a) => (a && a.stack ? a.stack : String(a))).join(' ');
    originalConsoleError(...args);
  };

  // server/index.js calls process.exit(1) if it can't reach the database.
  // Turn that into a visible dialog instead of the app silently vanishing.
  const originalExit = process.exit.bind(process);
  process.exit = (code) => {
    dialog.showErrorBox(
      'Saffron POS could not start',
      `Could not connect to the database. Double-check DATABASE_URL in:\n${envPath}` +
        (lastError ? `\n\nDetails:\n${lastError}` : '')
    );
    originalExit(code);
  };

  showLoadingScreen();
  require(path.join(appRoot, 'server', 'index.js'));
  loadWhenReady();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(true);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
