'use strict';

const ALLOWED_EXTERNAL = /^https:\/\/(drive\.treelife\.co)(\/|$)/;


const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  shell,
  ipcMain,
  nativeImage,
  Notification,
  dialog,
} = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ─── Lazy-require modules that depend on Electron being ready ────────────────
let Store;
let ApiClient;
let IndexCache;
let SyncEngine;
let FileWatcher;
let Notifications;
let overlayIcons;

function requireModules() {
  Store = require('electron-store');
  ApiClient = require('./src/api-client');
  IndexCache = require('./src/index-cache');
  SyncEngine = require('./src/sync-engine');
  FileWatcher = require('./src/file-watcher');
  ({ Notifications } = require('./src/notifications'));
  overlayIcons = require('./src/overlay-icons');
}

// ─── Constants ───────────────────────────────────────────────────────────────
const LOCAL_ROOT = path.join(os.homedir(), 'Treelife Drive');
const KEYTAR_SERVICE = 'treelife-drive';
const KEYTAR_ACCOUNT = 'pat';
const STORE_EMAIL_KEY = 'userEmail';
const ICON_PATH = path.join(__dirname, 'assets', 'icon.ico');

// ─── Single-instance lock ─────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// ─── State ────────────────────────────────────────────────────────────────────
let tray = null;
let rendererWindow = null;
let store = null;
let apiClient = null;
let indexCache = null;
let syncEngine = null;
let fileWatcher = null;
let notifications = null;

const appState = {
  online: true,
  syncing: false,
  paused: false,
  user: null,
  statusLabel: 'Idle',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ensureSyncFolder() {
  if (!fs.existsSync(LOCAL_ROOT)) {
    fs.mkdirSync(LOCAL_ROOT, { recursive: true });
  }
}

function loadTrayIcon() {
  try {
    if (fs.existsSync(ICON_PATH)) {
      const img = nativeImage.createFromPath(ICON_PATH);
      if (!img.isEmpty()) return img;
    }
  } catch (_) {}
  // Fallback: 1x1 green pixel — Tray() crashes if given an empty NativeImage
  return nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAABjE+ibYAAAAASUVORK5CYII='
  );
}

// ─── Keytar (optional native module) ─────────────────────────────────────────
// keytar may fail to load if native bindings are missing; wrap defensively.
let keytar = null;
try {
  keytar = require('keytar');
} catch (_) {
  // keytar unavailable; fall back to electron-store for PAT storage
}

async function storePAT(token) {
  if (keytar) {
    await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT, token);
  } else {
    store.set('pat', token);
  }
}

async function loadPAT() {
  if (keytar) {
    return keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
  }
  return store.get('pat', null);
}

async function deletePAT() {
  if (keytar) {
    await keytar.deletePassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
  } else {
    store.delete('pat');
  }
}

// ─── Tray menu ────────────────────────────────────────────────────────────────

function buildTrayMenu() {
  const pauseLabel = appState.paused ? 'Resume Sync' : 'Pause Sync';

  return Menu.buildFromTemplate([
    { label: 'Treelife Drive', enabled: false },
    { type: 'separator' },
    {
      label: 'Open Treelife Drive',
      click() {
        ALLOWED_EXTERNAL.test('https://drive.treelife.co') && shell.openExternal('https://drive.treelife.co');
      },
    },
    {
      label: 'Sync Status: ' + appState.statusLabel,
      enabled: false,
    },
    {
      label: pauseLabel,
      click() {
        if (appState.paused) {
          handleResume();
        } else {
          handlePause();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Settings',
      click() {
        openRendererWindow();
      },
    },
    {
      label: 'Sign Out',
      async click() {
        await handleSignOut();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click() {
        app.quit();
      },
    },
  ]);
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());
}

function setTrayStatus(label) {
  appState.statusLabel = label;
  if (tray) {
    tray.setToolTip('Treelife Drive — ' + label);
  }
  refreshTrayMenu();
  if (typeof pushStatusToRenderer === 'function') pushStatusToRenderer();
}

// ─── Renderer window ──────────────────────────────────────────────────────────

function openRendererWindow() {
  if (rendererWindow && !rendererWindow.isDestroyed()) {
    rendererWindow.focus();
    return;
  }

  rendererWindow = new BrowserWindow({
    width: 420,
    height: 560,
    resizable: false,
    title: 'Treelife Drive',
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  // Block navigation away from local file
  rendererWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
  // Block all new-window requests
  rendererWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Inject CSP
  rendererWindow.webContents.session.webRequest.onHeadersReceived((details, cb) => {
    cb({ responseHeaders: {
      ...details.responseHeaders,
      'Content-Security-Policy': [
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src https://drive.treelife.co; img-src 'self' data:; frame-src 'none'; object-src 'none'"
      ],
    }});
  });

  rendererWindow.setMenuBarVisibility(false);
  rendererWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  rendererWindow.on('closed', () => {
    rendererWindow = null;
  });
}

// ─── Sync engine wiring ───────────────────────────────────────────────────────

function wireEngineEvents() {
  if (!syncEngine) return;

  syncEngine.on('sync-start', () => {
    appState.syncing = true;
    setTrayStatus('Syncing');
  });

  syncEngine.on('sync-complete', () => {
    appState.syncing = false;
    if (!appState.paused && appState.online) setTrayStatus('Idle');
  });

  syncEngine.on('offline-confirmed', () => {
    appState.online = false;
    setTrayStatus('Offline');
    if (notifications) notifications.notifyOffline();
  });

  syncEngine.on('offline', () => {
    appState.online = false;
    setTrayStatus('Offline');
  });

  syncEngine.on('online', () => {
    appState.online = true;
    if (!appState.paused) {
      setTrayStatus('Idle');
    }
    if (notifications) notifications.notifyOnline();
  });

  syncEngine.on('upload-error', (info) => {
    const name = info && info.dropboxPath ? info.dropboxPath : String(info);
    const reason = info && info.reason ? info.reason : 'upload failed';
    if (notifications) {
      if (reason === 'permission') notifications.notifyNoAccess(name);
      else notifications.notifyUploadError(name, reason);
    }
  });

  syncEngine.on('conflict', (info) => {
    if (notifications && info) {
      notifications.notifyConflict(info.conflictPath || info.localPath || 'file');
    }
  });
}

function teardownSync() {
  if (fileWatcher) {
    fileWatcher.stop();
    fileWatcher = null;
  }
  if (syncEngine) {
    syncEngine.stop();
    syncEngine = null;
  }
  if (apiClient) {
    apiClient.stopLongpoll();
    apiClient = null;
  }
  indexCache = null;
}

async function initSync(token, email) {
  teardownSync();
  ensureSyncFolder();

  apiClient = new ApiClient(token);
  indexCache = new IndexCache(LOCAL_ROOT);
  syncEngine = new SyncEngine({
    apiClient,
    indexCache,
    localRoot: LOCAL_ROOT,
    onStatus: (label) => {
      if (typeof label !== 'string') return;
      const lower = label.toLowerCase();
      appState.syncing = lower.includes('uploading') || lower.includes('downloading') || lower.includes('initial sync');
      // Do not clobber the Offline/Paused tray labels with verbose progress text.
      if (!appState.paused && appState.online) {
        setTrayStatus(appState.syncing ? 'Syncing' : 'Idle');
      }
    },
    onError: (err) => {
      const msg = err && err.message ? err.message : String(err);
      console.error('[sync]', msg);
      if (notifications && /permission|access/i.test(msg)) {
        notifications.notifyNoAccess(msg);
      }
    },
    onInaccessible: (folderPath) => {
      if (overlayIcons && typeof overlayIcons.setInaccessibleFolder === 'function') {
        overlayIcons.setInaccessibleFolder(folderPath);
      }
    },
  });

  wireEngineEvents();

  appState.paused = false;
  appState.user = email || store.get(STORE_EMAIL_KEY, null);

  setTrayStatus('Syncing');
  await syncEngine.start();
}

// ─── Pause / resume ───────────────────────────────────────────────────────────

function handlePause() {
  if (!syncEngine || appState.paused) return;
  syncEngine.pause();
  appState.paused = true;
  setTrayStatus('Paused');
}

function handleResume() {
  if (!syncEngine || !appState.paused) return;
  syncEngine.resume();
  appState.paused = false;
  setTrayStatus('Idle');
}

// ─── Sign out ─────────────────────────────────────────────────────────────────

async function handleSignOut() {
  teardownSync();
  await deletePAT();
  store.delete(STORE_EMAIL_KEY);
  appState.user = null;
  appState.paused = false;
  appState.syncing = false;
  appState.online = true;
  setTrayStatus('Signed Out');
  openRendererWindow();
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────

// Map internal appState into the renderer's status vocabulary.
function computeSyncStatus() {
  if (!appState.online) return 'offline';
  if (appState.paused) return 'paused';
  if (appState.syncing) return 'syncing';
  return 'idle';
}

function pushStatusToRenderer() {
  if (rendererWindow && !rendererWindow.isDestroyed()) {
    rendererWindow.webContents.send('status-update', {
      signedIn: !!appState.user,
      email: appState.user,
      syncStatus: computeSyncStatus(),
    });
  }
}

function registerIpcHandlers() {
  ipcMain.handle('get-status', () => ({
    signedIn: !!appState.user,
    email: appState.user,
    syncStatus: computeSyncStatus(),
  }));

  ipcMain.handle('sign-in', async (_event, { email, token }) => {
    if (!email || !token) {
      throw new Error('Email and token are required.');
    }

    const client = new ApiClient(token);
    let userData;
    try {
      userData = await client.getUser();
    } catch (err) {
      throw new Error('Invalid token or unable to reach Treelife Drive: ' + err.message);
    }

    await storePAT(token);
    store.set(STORE_EMAIL_KEY, email);
    appState.user = email;

    await initSync(token, email);

    return { success: true, syncStatus: computeSyncStatus(), user: userData };
  });

  ipcMain.handle('sign-out', async () => {
    await handleSignOut();
    return { ok: true };
  });

  ipcMain.handle('open-sync-folder', async () => {
    ensureSyncFolder();
    await shell.openPath(LOCAL_ROOT);
    return { ok: true };
  });

  ipcMain.handle('open-drive', async () => {
    await ALLOWED_EXTERNAL.test('https://drive.treelife.co') && shell.openExternal('https://drive.treelife.co');
    return { ok: true };
  });

  ipcMain.handle('pause-sync', () => {
    handlePause();
    pushStatusToRenderer();
    return { syncStatus: computeSyncStatus(), paused: appState.paused };
  });

  ipcMain.handle('resume-sync', () => {
    handleResume();
    pushStatusToRenderer();
    return { syncStatus: computeSyncStatus(), paused: appState.paused };
  });
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.on("second-instance", (_event, argv) => {
  const url = argv.find(a => a.startsWith("treelife://"));
  if (url) { handleDeepLink(url); return; }
  if (rendererWindow && !rendererWindow.isDestroyed()) {
    if (rendererWindow.isMinimized()) rendererWindow.restore();
    rendererWindow.focus();
  }
});

async function signIn(email, token) {
  const client = new ApiClient(token);
  try {
    await client.getUser();
  } catch (err) {
    throw new Error('Invalid token or unable to reach Treelife Drive: ' + err.message);
  }
  await storePAT(token);
  store.set(STORE_EMAIL_KEY, email);
  appState.user = email;
  await initSync(token, email);
}

function handleDeepLink(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'treelife:') return;

    if (u.hostname === 'connect') {
      const email = u.searchParams.get('email') || '';
      const token = u.searchParams.get('token') || '';
      if (!email.endsWith('@treelife.in')) return;
      if (!token || token.length < 10 || token.length > 512) return;
      const keys = [...u.searchParams.keys()];
      if (keys.some(k => k !== 'email' && k !== 'token')) return;
      signIn(email, token).catch(e => console.error('Deep link sign-in:', e.message));
      return;
    }

    if (u.hostname === 'request-access') {
      const dropboxPath = u.searchParams.get('path') || '';
      if (!dropboxPath || dropboxPath.length > 1024) return;
      handleRequestAccess(dropboxPath);
      return;
    }
  } catch (e) { console.error('Deep link rejected:', e.message); }
}

async function handleRequestAccess(dropboxPath) {
  const folderName = dropboxPath.split('/').filter(Boolean).pop() || dropboxPath;
  if (!apiClient) {
    dialog.showMessageBox({
      type: 'warning',
      title: 'Not Connected',
      message: 'Treelife Drive is not connected. Sign in first, then try again.',
      buttons: ['OK'],
    });
    return;
  }
  const confirmed = await dialog.showMessageBox({
    type: 'question',
    title: 'Request Access',
    message: 'Request access to "' + folderName + '"?',
    detail: 'Your administrator will be notified and can grant you access from drive.treelife.co.',
    buttons: ['Request Access', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (confirmed.response !== 0) return;
  try {
    await apiClient.requestAccess(dropboxPath);
    new Notification({
      title: 'Access Requested',
      body: 'Your request for "' + folderName + '" has been sent to your administrator.',
    }).show();
  } catch (err) {
    dialog.showMessageBox({
      type: 'error',
      title: 'Request Failed',
      message: 'Could not send access request: ' + (err.message || 'Unknown error'),
      buttons: ['OK'],
    });
  }
}

app.on('window-all-closed', () => {
  // Stay alive in tray; do NOT quit.
});

app.whenReady().then(async () => {
  // Register treelife:// protocol for one-click connect from web UI
  if (process.platform === "win32") {
    app.setAsDefaultProtocolClient("treelife");
  }
  requireModules();
  notifications = new Notifications();

  store = new Store({ name: 'treelife-drive' });

  // Overlay icons (Windows only; no-op on other platforms).
  if (process.platform === 'win32') {
    overlayIcons.register();
  }

  registerIpcHandlers();

  // Create tray.
  const icon = loadTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip('Treelife Drive');
  tray.setContextMenu(buildTrayMenu());

  tray.on('double-click', () => {
    ALLOWED_EXTERNAL.test('https://drive.treelife.co') && shell.openExternal('https://drive.treelife.co');
  });

  // Check for stored credentials.
  const storedToken = await loadPAT();

  if (!storedToken) {
    // No credentials: show login UI.
    openRendererWindow();
  } else {
    // Silent tray-mode startup.
    const email = store.get(STORE_EMAIL_KEY, null);
    appState.user = email;
    try {
      await initSync(storedToken, email);
    } catch (err) {
      // Token may be invalid or server unreachable; show login.
      setTrayStatus('Error');
      openRendererWindow();
    }
  }
});

app.on('before-quit', () => {
  teardownSync();
});
