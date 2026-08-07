'use strict';

/**
 * overlay-icons.js
 * Windows Shell overlay icon manager for Treelife Drive Desktop.
 *
 * Overlay icons require a COM DLL registered as IShellIconOverlayIdentifier.
 * On Windows, this module:
 *   1. Registers the DLL under HKCU shell overlay keys (no admin required).
 *   2. Maintains a status.json file the DLL reads to determine per-file sync state.
 *   3. Exposes a JS API to update file status and trigger Explorer refresh.
 *
 * When the DLL is absent, a fallback path writes desktop.ini into inaccessible
 * folder stubs so Explorer shows a padlock-style icon without any DLL.
 *
 * On non-Windows platforms every exported method is a no-op.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IS_WINDOWS = process.platform === 'win32';

/**
 * %APPDATA%/TreelifeDrive/status.json
 * Format: { "<absolute-local-path>": "synced" | "syncing" | "error" | "noaccess" }
 */
const STATUS_DIR = IS_WINDOWS
  ? path.join(process.env.APPDATA || os.homedir(), 'TreelifeDrive')
  : path.join(os.homedir(), '.treelife-drive');

const STATUS_FILE = path.join(STATUS_DIR, 'status.json');

/**
 * DLL is bundled via electron-builder extraResources into process.resourcesPath.
 * The DLL filename preserves the "TrelifeOverlay" spelling from the build spec
 * so it matches the bundled asset name exactly.
 */
const DLL_PATH = IS_WINDOWS
  ? path.join(process.resourcesPath || '', 'overlay', 'TrelifeOverlay.dll')
  : '';

// Registry key base paths for overlay identifiers (HKCU, no elevation needed).
const REG_BASE =
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\ShellIconOverlayIdentifiers';

const OVERLAY_KEYS = {
  TreelifeSynced: `${REG_BASE}\\TreelifeSynced`,
  TreelifeNoAccess: `${REG_BASE}\\TreelifeNoAccess`,
};

// Valid status values.
const STATUS = {
  SYNCED: 'synced',
  SYNCING: 'syncing',
  ERROR: 'error',
  NOACCESS: 'noaccess',
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Read status.json, returning an empty object on any read/parse failure.
 */
function readStatus() {
  try {
    const raw = fs.readFileSync(STATUS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

/**
 * Write the given status map back to disk, creating the directory if needed.
 */
function writeStatus(map) {
  try {
    fs.mkdirSync(STATUS_DIR, { recursive: true });
    fs.writeFileSync(STATUS_FILE, JSON.stringify(map, null, 2), 'utf8');
  } catch (err) {
    console.error('[overlay-icons] Failed to write status file:', err.message);
  }
}

/**
 * Trigger an Explorer shell notification so overlay icons refresh immediately.
 * Uses a PowerShell one-liner via child_process; failure is non-fatal.
 *
 * SHChangeNotify(SHCNE_ASSOCCHANGED=0x08000000, SHCNF_IDLIST=0x0000) is the
 * broadest refresh signal. For a targeted refresh supply the path; the broad
 * call is used here because it works reliably across all Explorer versions.
 */
function shellRefresh() {
  if (!IS_WINDOWS) return;
  try {
    const psCode = [
      '$code = \'[DllImport("shell32.dll")] public static extern void SHChangeNotify(int e, uint f, IntPtr a, IntPtr b);\';',
      '$t = Add-Type -MemberDefinition $code -Name SHNotify -Namespace Win32 -PassThru;',
      '$t::SHChangeNotify(0x08000000, 0x0000, [IntPtr]::Zero, [IntPtr]::Zero)',
    ].join(' ');
    execSync(`powershell -NoProfile -NonInteractive -Command "& { ${psCode} }"`, {
      timeout: 5000,
      windowsHide: true,
    });
  } catch (err) {
    // Non-fatal: Explorer will pick up changes on its next poll cycle.
    console.warn('[overlay-icons] SHChangeNotify failed (non-fatal):', err.message);
  }
}

/**
 * Run a reg.exe command. Throws on failure so callers can catch.
 */
function regExec(args) {
  execSync(`reg ${args}`, { timeout: 8000, windowsHide: true });
}

/**
 * Check whether the bundled DLL exists on disk.
 */
function dllExists() {
  if (!IS_WINDOWS) return false;
  try {
    return fs.existsSync(DLL_PATH);
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * register()
 *
 * Checks for the bundled DLL. If present, writes HKCU registry keys so Windows
 * Explorer loads the overlay handler on next restart. If the DLL is absent,
 * logs that the fallback (desktop.ini) will be used for inaccessible folders.
 *
 * Safe to call multiple times. On non-Windows, this is a no-op.
 */
function register() {
  if (!IS_WINDOWS) return;

  if (!dllExists()) {
    console.info(
      '[overlay-icons] DLL not found at',
      DLL_PATH,
      '— using desktop.ini fallback for inaccessible folders.'
    );
    return;
  }

  try {
    // Write the DLL path as the default REG_SZ value for each overlay key.
    // Explorer reads these on startup; a restart or shell refresh is required
    // before the new overlays appear.
    for (const [name, keyPath] of Object.entries(OVERLAY_KEYS)) {
      regExec(`add "${keyPath}" /ve /d "${DLL_PATH}" /f`);
      console.info(`[overlay-icons] Registered overlay key: ${name}`);
    }

    // Ensure status file directory exists so the DLL can read it on first run.
    fs.mkdirSync(STATUS_DIR, { recursive: true });
    if (!fs.existsSync(STATUS_FILE)) {
      writeStatus({});
    }

    shellRefresh();
  } catch (err) {
    console.error('[overlay-icons] Failed to register overlay keys:', err.message);
  }
}

/**
 * setStatus(localPath, status)
 *
 * Update status.json with the given status for the given absolute local path,
 * then trigger a shell refresh so Explorer picks up the new overlay icon.
 *
 * @param {string} localPath  Absolute path on the local filesystem.
 * @param {string} status     One of: 'synced' | 'syncing' | 'error' | 'noaccess'
 */
function setStatus(localPath, status) {
  if (!IS_WINDOWS) return;
  if (!localPath) return;

  const validStatuses = Object.values(STATUS);
  if (!validStatuses.includes(status)) {
    console.warn('[overlay-icons] Unknown status value:', status);
    return;
  }

  try {
    const map = readStatus();
    map[localPath] = status;
    writeStatus(map);
    shellRefresh();
  } catch (err) {
    console.error('[overlay-icons] setStatus failed:', err.message);
  }
}

/**
 * setSynced(localPath)
 * Mark a file or folder as fully synced with the remote.
 */
function setSynced(localPath) {
  setStatus(localPath, STATUS.SYNCED);
}

/**
 * setSyncing(localPath)
 * Mark a file or folder as currently syncing (upload or download in progress).
 */
function setSyncing(localPath) {
  setStatus(localPath, STATUS.SYNCING);
}

/**
 * setError(localPath)
 * Mark a file or folder as having encountered a sync error.
 */
function setError(localPath) {
  setStatus(localPath, STATUS.ERROR);
}

/**
 * setNoAccess(localPath)
 *
 * Mark a file or folder as inaccessible (permission denied by server policy).
 * Updates status.json and also writes the desktop.ini fallback so the padlock
 * icon appears even on machines where the DLL is not registered.
 */
function setNoAccess(localPath) {
  setStatus(localPath, STATUS.NOACCESS);
  setInaccessibleFolder(localPath);
}

/**
 * setInaccessibleFolder(localPath)
 *
 * Fallback for environments where the DLL is not present. Writes a desktop.ini
 * inside the given folder stub so Windows Explorer renders a padlock-style icon
 * (shell32.dll icon index 48) without requiring any COM registration or admin
 * rights. Works on all Windows versions that honour desktop.ini.
 *
 * If localPath points to a file, the parent directory receives the desktop.ini.
 * The directory is created if it does not yet exist (stub folder scenario).
 *
 * On non-Windows, this is a no-op.
 */
function setInaccessibleFolder(localPath) {
  if (!IS_WINDOWS) return;
  if (!localPath) return;

  try {
    let targetDir = localPath;

    try {
      const stat = fs.statSync(localPath);
      if (!stat.isDirectory()) {
        targetDir = path.dirname(localPath);
      }
    } catch (_) {
      // Path may not exist yet (stub folder). Treat localPath as the directory.
    }

    // Ensure the stub directory exists before writing into it.
    fs.mkdirSync(targetDir, { recursive: true });

    const iniPath = path.join(targetDir, 'desktop.ini');
    const iniContent = '[.ShellClassInfo]\r\nIconResource=shell32.dll,48\r\n';

    fs.writeFileSync(iniPath, iniContent, 'utf8');

    // desktop.ini must carry the System + Hidden attributes for Explorer to
    // honour it. The containing folder must also carry the System attribute.
    execSync(`attrib +S +H "${iniPath}"`, { timeout: 5000, windowsHide: true });
    execSync(`attrib +S "${targetDir}"`, { timeout: 5000, windowsHide: true });

    shellRefresh();
  } catch (err) {
    console.error('[overlay-icons] setInaccessibleFolder failed:', err.message);
  }
}

/**
 * unregister()
 *
 * Remove the HKCU overlay registry keys. Safe to call even if the keys do not
 * exist. Explorer will stop loading the overlay handler after its next restart.
 *
 * On non-Windows, this is a no-op.
 */
function unregister() {
  if (!IS_WINDOWS) return;

  for (const [name, keyPath] of Object.entries(OVERLAY_KEYS)) {
    try {
      regExec(`delete "${keyPath}" /f`);
      console.info(`[overlay-icons] Removed overlay key: ${name}`);
    } catch (err) {
      // Key may not exist; that is not an error condition.
      console.warn(
        `[overlay-icons] Could not remove key ${name} (may not exist):`,
        err.message
      );
    }
  }

  try {
    shellRefresh();
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  register,
  setStatus,
  setSynced,
  setSyncing,
  setError,
  setNoAccess,
  setInaccessibleFolder,
  unregister,
  // Expose status constants so callers can reference them without magic strings.
  STATUS,
  // Expose paths for diagnostics and tests.
  STATUS_FILE,
  DLL_PATH,
};
