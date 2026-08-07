'use strict';

const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');

const QUEUE_INTERVAL_MS = 2000;
const ONLINE_POLL_MS = 10000;
const OFFLINE_CONFIRM_MS = 8000;
const MAX_CONCURRENT_UPLOADS = 3;
const MAX_RETRIES = 5;
const NO_ACCESS_FILENAME = '_Request Access.url';
const URL_FILE_CONTENT = '[InternetShortcut]\r\nURL=https://drive.treelife.co\r\n';

function exponentialBackoff(retries) {
  return Math.min(1000 * Math.pow(2, retries), 30000);
}

function conflictName(filePath) {
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const dir = path.dirname(filePath);
  const date = new Date().toISOString().slice(0, 10);
  return path.join(dir, `${base} (conflict ${date})${ext}`);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function writeFileAtomic(filePath, data) {
  const tmp = filePath + '.tmp_' + Date.now();
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

class SyncEngine extends EventEmitter {
  constructor({ localRoot, apiClient, indexCache, onStatus, onError, onInaccessible }) {
    super();

    if (!localRoot) throw new Error('localRoot is required');
    if (!apiClient) throw new Error('apiClient is required');
    if (!indexCache) throw new Error('indexCache is required');

    this.localRoot = localRoot;
    this.apiClient = apiClient;
    this.indexCache = indexCache;
    this.onStatus = onStatus || function () {};
    this.onError = onError || function () {};
    this.onInaccessible = onInaccessible || function () {};

    this._uploadQueue = [];
    this._deleteQueue = [];
    this._activeUploads = 0;
    this._paused = false;
    this._stopped = false;
    this._online = true;
    this._offlineTimer = null;
    this._queueTimer = null;
    this._onlinePollTimer = null;
    this._watcher = null;
    this._longpollActive = false;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async start() {
    this._stopped = false;
    this._paused = false;
    this.onStatus('Starting Treelife Drive sync...');

    ensureDir(this.localRoot);
    this._restoreQueues();

    try {
      this._online = await this.apiClient.isOnline();
    } catch (e) {
      this._online = false;
    }

    if (!this._online) {
      this.onStatus('No Internet Available. Treelife Drive requires internet to read/write files.');
      this.emit('offline-confirmed', 'No Internet Available. Treelife Drive requires internet to read/write files.');
    }

    if (this._online) {
      try {
        await this.initialSync();
      } catch (err) {
        this.onError(err);
      }
    }

    this._startFileWatcher();
    this._startLongpoll();
    this._startQueueProcessor();
    this._startOnlinePoller();

    this.onStatus('Sync engine running.');
    this.emit('ready');
  }

  stop() {
    this._stopped = true;
    this._paused = false;
    this._longpollActive = false;

    if (this._watcher) {
      this._watcher.close();
      this._watcher = null;
    }
    if (this._queueTimer) {
      clearInterval(this._queueTimer);
      this._queueTimer = null;
    }
    if (this._onlinePollTimer) {
      clearInterval(this._onlinePollTimer);
      this._onlinePollTimer = null;
    }
    if (this._offlineTimer) {
      clearTimeout(this._offlineTimer);
      this._offlineTimer = null;
    }

    this.onStatus('Sync engine stopped.');
    this.emit('stopped');
  }

  pause() {
    if (!this._paused) {
      this._paused = true;
      this.onStatus('Sync paused.');
      this.emit('paused');
    }
  }

  resume() {
    if (this._paused) {
      this._paused = false;
      this.onStatus('Sync resumed.');
      this.emit('resumed');
      this._processQueue();
    }
  }

  queueUpload(localPath, dropboxPath) {
    const existing = this._uploadQueue.find(
      (item) => item.localPath === localPath && item.dropboxPath === dropboxPath
    );
    if (!existing) {
      this._uploadQueue.push({ localPath, dropboxPath, retries: 0, nextRetryAt: 0 });
      this._persistQueues();
    }
  }

  queueDelete(dropboxPath) {
    const existing = this._deleteQueue.find((item) => item.dropboxPath === dropboxPath);
    if (!existing) {
      this._deleteQueue.push({ dropboxPath, retries: 0, nextRetryAt: 0 });
      this._persistQueues();
    }
  }

  // -------------------------------------------------------------------------
  // Initial sync
  // -------------------------------------------------------------------------

  async initialSync() {
    this.onStatus('Running initial sync...');
    this.emit('sync-start');

    let entries;
    try {
      entries = await this.apiClient.listFolder('', { recursive: true });
    } catch (err) {
      this.onError(new Error('Failed to list remote folder: ' + err.message));
      return;
    }

    const remotePathSet = new Set();

    for (const entry of entries) {
      if (this._stopped) break;

      const localPath = this._toLocalPath(entry.path_display);
      remotePathSet.add(entry.path_lower || entry.path_display.toLowerCase());

      if (entry['.tag'] === 'folder') {
        if (entry.accessible === false) {
          this._createNoAccessStub(localPath);
        } else {
          ensureDir(localPath);
        }
        continue;
      }

      if (entry['.tag'] === 'file') {
        if (entry.accessible === false) {
          this._createNoAccessStub(path.dirname(localPath));
          continue;
        }

        const cachedRev = this.indexCache.getRev(entry.path_lower || entry.path_display.toLowerCase());
        const localExists = fs.existsSync(localPath);

        if (!localExists) {
          await this._downloadFile(entry, localPath);
        } else if (cachedRev && entry.rev !== cachedRev) {
          const localMtime = fs.statSync(localPath).mtimeMs;
          const cachedMtime = this.indexCache.getLastSync(
            entry.path_lower || entry.path_display.toLowerCase()
          );

          if (cachedMtime && localMtime > cachedMtime + 1000) {
            // Both sides changed: conflict
            const conflictPath = conflictName(localPath);
            fs.copyFileSync(localPath, conflictPath);
            this.onStatus(`Conflict detected: saved local copy as ${path.basename(conflictPath)}`);
            this.emit('conflict', { localPath, conflictPath, remotePath: entry.path_display });
            const conflictDropbox =
              entry.path_display.replace(
                path.extname(entry.path_display),
                ` (conflict ${new Date().toISOString().slice(0, 10)})${path.extname(entry.path_display)}`
              );
            this.queueUpload(conflictPath, conflictDropbox);
            await this._downloadFile(entry, localPath);
          } else {
            await this._downloadFile(entry, localPath);
          }
        } else if (!cachedRev) {
          await this._downloadFile(entry, localPath);
        }
      }
    }

    // Remove locally present files that no longer exist remotely
    this._pruneLocalExtras(remotePathSet);

    this.onStatus('Initial sync complete.');
    this.emit('sync-complete');
  }

  // -------------------------------------------------------------------------
  // File watcher
  // -------------------------------------------------------------------------

  _startFileWatcher() {
    if (this._watcher) {
      this._watcher.close();
    }

    this._watcher = chokidar.watch(this.localRoot, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 200 },
      ignored: [
        /(^|[\/\\])\../,
        /\.tmp_\d+$/,
        new RegExp(NO_ACCESS_FILENAME.replace('.', '\\.'))
      ]
    });

    this._watcher.on('add', (localPath) => {
      const dropboxPath = this._toDropboxPath(localPath);
      this.onStatus(`New file detected: ${dropboxPath}`);
      this.queueUpload(localPath, dropboxPath);
    });

    this._watcher.on('change', (localPath) => {
      const dropboxPath = this._toDropboxPath(localPath);
      const cachedMtime = this.indexCache.getLastSync(dropboxPath.toLowerCase());
      const localMtime = fs.existsSync(localPath) ? fs.statSync(localPath).mtimeMs : 0;

      if (cachedMtime && localMtime > cachedMtime + 1000) {
        this.onStatus(`File changed: ${dropboxPath}`);
      }
      this.queueUpload(localPath, dropboxPath);
    });

    this._watcher.on('unlink', (localPath) => {
      const dropboxPath = this._toDropboxPath(localPath);
      this.onStatus(`File deleted locally: ${dropboxPath}`);
      this.queueDelete(dropboxPath);
    });

    this._watcher.on('error', (err) => {
      this.onError(new Error('File watcher error: ' + err.message));
    });
  }

  // -------------------------------------------------------------------------
  // Long-poll listener
  // -------------------------------------------------------------------------

  _startLongpoll() {
    if (this._longpollActive) return;
    this._longpollActive = true;
    this._longpollLoop();
  }

  async _longpollLoop() {
    while (this._longpollActive && !this._stopped) {
      if (!this._online) {
        await this._sleep(ONLINE_POLL_MS);
        continue;
      }

      try {
        const changed = await this.apiClient.longpollFolder();
        if (changed && !this._stopped && !this._paused) {
          await this._fetchAndApplyRemoteChanges();
        }
      } catch (err) {
        // Longpoll errors are non-fatal; back off briefly
        await this._sleep(5000);
      }
    }
  }

  async _fetchAndApplyRemoteChanges() {
    try {
      const changes = await this.apiClient.listFolderContinue();
      for (const entry of changes) {
        if (this._stopped) break;
        const localPath = this._toLocalPath(entry.path_display);

        if (entry['.tag'] === 'deleted') {
          if (fs.existsSync(localPath)) {
            fs.rmSync(localPath, { recursive: true, force: true });
            this.indexCache.remove(entry.path_lower || entry.path_display.toLowerCase());
            this.onStatus(`Remote delete applied: ${entry.path_display}`);
          }
          continue;
        }

        if (entry['.tag'] === 'folder') {
          if (entry.accessible === false) {
            this._createNoAccessStub(localPath);
          } else {
            ensureDir(localPath);
          }
          continue;
        }

        if (entry['.tag'] === 'file') {
          if (entry.accessible === false) {
            this._createNoAccessStub(path.dirname(localPath));
            continue;
          }

          const pathKey = entry.path_lower || entry.path_display.toLowerCase();
          const cachedRev = this.indexCache.getRev(pathKey);

          if (entry.rev !== cachedRev) {
            const localExists = fs.existsSync(localPath);
            if (localExists) {
              const localMtime = fs.statSync(localPath).mtimeMs;
              const cachedMtime = this.indexCache.getLastSync(pathKey);
              if (cachedMtime && localMtime > cachedMtime + 1000) {
                const conflictPath = conflictName(localPath);
                fs.copyFileSync(localPath, conflictPath);
                this.onStatus(`Conflict: saved local copy as ${path.basename(conflictPath)}`);
                this.emit('conflict', { localPath, conflictPath, remotePath: entry.path_display });
                const conflictDropbox = entry.path_display.replace(
                  path.extname(entry.path_display),
                  ` (conflict ${new Date().toISOString().slice(0, 10)})${path.extname(entry.path_display)}`
                );
                this.queueUpload(conflictPath, conflictDropbox);
              }
            }
            await this._downloadFile(entry, localPath);
          }
        }
      }
    } catch (err) {
      this.onError(new Error('Failed to apply remote changes: ' + err.message));
    }
  }

  // -------------------------------------------------------------------------
  // Queue processor
  // -------------------------------------------------------------------------

  _startQueueProcessor() {
    if (this._queueTimer) clearInterval(this._queueTimer);
    this._queueTimer = setInterval(() => {
      if (!this._stopped) this._processQueue();
    }, QUEUE_INTERVAL_MS);
  }

  async _processQueue() {
    if (this._paused || !this._online || this._stopped) return;

    // Process delete queue first (sequential, simple)
    const deleteBatch = this._deleteQueue.filter(
      (item) => !item._inFlight && Date.now() >= (item.nextRetryAt || 0)
    );
    for (const item of deleteBatch) {
      if (this._stopped) return;
      item._inFlight = true;
      try {
        await this.apiClient.deleteFile(item.dropboxPath);
        this._deleteQueue = this._deleteQueue.filter((q) => q !== item);
        this.indexCache.remove(item.dropboxPath.toLowerCase());
        this.onStatus(`Deleted remote: ${item.dropboxPath}`);
        this.emit('delete-success', item.dropboxPath);
      } catch (err) {
        item._inFlight = false;
        if (err && (err.status === 403 || err.statusCode === 403)) {
          this._deleteQueue = this._deleteQueue.filter((q) => q !== item);
          this.onError(new Error(`No permission to delete ${item.dropboxPath}`));
        } else {
          item.retries = (item.retries || 0) + 1;
          if (item.retries > MAX_RETRIES) {
            this._deleteQueue = this._deleteQueue.filter((q) => q !== item);
            this.onError(new Error(`Failed to delete ${item.dropboxPath} after ${MAX_RETRIES} retries`));
          } else {
            item.nextRetryAt = Date.now() + exponentialBackoff(item.retries);
          }
        }
      }
    }

    // Process upload queue with concurrency cap
    const available = MAX_CONCURRENT_UPLOADS - this._activeUploads;
    if (available <= 0) return;

    const uploadBatch = this._uploadQueue
      .filter((item) => !item._inFlight && Date.now() >= (item.nextRetryAt || 0))
      .slice(0, available);

    for (const item of uploadBatch) {
      if (this._stopped) return;
      this._activeUploads++;
      item._inFlight = true;
      this._uploadOne(item);
    }

    this._persistQueues();
  }

  async _uploadOne(item) {
    try {
      if (!fs.existsSync(item.localPath)) {
        this._uploadQueue = this._uploadQueue.filter((q) => q !== item);
        this._activeUploads--;
        return;
      }

      const pathKey = item.dropboxPath.toLowerCase();
      const cachedMtime = this.indexCache.getLastSync(pathKey);
      const localMtime = fs.statSync(item.localPath).mtimeMs;

      this.onStatus(`Uploading: ${item.dropboxPath}`);
      const result = await this.apiClient.uploadFile(item.localPath, item.dropboxPath);

      this.indexCache.setRev(pathKey, result.rev);
      this.indexCache.setLastSync(pathKey, localMtime);
      this._uploadQueue = this._uploadQueue.filter((q) => q !== item);
      this._activeUploads--;
      this._persistQueues();
      this.onStatus(`Uploaded: ${item.dropboxPath}`);
      this.emit('upload-success', { localPath: item.localPath, dropboxPath: item.dropboxPath });
    } catch (err) {
      item._inFlight = false;
      this._activeUploads--;

      if (err && (err.status === 403 || err.statusCode === 403)) {
        this._uploadQueue = this._uploadQueue.filter((q) => q !== item);
        this.onError(new Error(`No permission to upload ${item.dropboxPath}`));
        this.emit('upload-error', { dropboxPath: item.dropboxPath, reason: 'permission' });
        return;
      }

      item.retries = (item.retries || 0) + 1;
      if (item.retries > MAX_RETRIES) {
        this._uploadQueue = this._uploadQueue.filter((q) => q !== item);
        this.onError(new Error(`Upload failed for ${item.dropboxPath} after ${MAX_RETRIES} retries`));
        this.emit('upload-error', { dropboxPath: item.dropboxPath, reason: 'max-retries' });
      } else {
        item.nextRetryAt = Date.now() + exponentialBackoff(item.retries);
        this.onStatus(
          `Upload retry ${item.retries}/${MAX_RETRIES} for ${item.dropboxPath} in ${Math.round(exponentialBackoff(item.retries) / 1000)}s`
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Online/offline polling
  // -------------------------------------------------------------------------

  _startOnlinePoller() {
    if (this._onlinePollTimer) clearInterval(this._onlinePollTimer);
    this._onlinePollTimer = setInterval(() => this._checkOnlineStatus(), ONLINE_POLL_MS);
  }

  async _checkOnlineStatus() {
    if (this._stopped) return;
    let nowOnline = false;
    try {
      nowOnline = await this.apiClient.isOnline();
    } catch (e) {
      nowOnline = false;
    }

    if (this._online && !nowOnline) {
      // Just went offline
      this._online = false;
      this.pause();
      this.emit('offline');
      this.onStatus('Connection lost. Sync paused.');

      if (this._offlineTimer) clearTimeout(this._offlineTimer);
      this._offlineTimer = setTimeout(() => {
        if (!this._online && !this._stopped) {
          this.emit(
            'offline-confirmed',
            'No Internet Available. Treelife Drive requires internet to read/write files.'
          );
          this.onStatus('No Internet Available. Treelife Drive requires internet to read/write files.');
        }
      }, OFFLINE_CONFIRM_MS);
    } else if (!this._online && nowOnline) {
      // Coming back online
      this._online = true;
      if (this._offlineTimer) {
        clearTimeout(this._offlineTimer);
        this._offlineTimer = null;
      }
      this.emit('online');
      this.onStatus('Connection restored. Resuming sync...');
      this.resume();
      // Flush all queued items immediately
      this._processQueue();
    }
  }

  // -------------------------------------------------------------------------
  // Inaccessible items
  // -------------------------------------------------------------------------

  _createNoAccessStub(folderPath) {
    ensureDir(folderPath);
    const urlFilePath = path.join(folderPath, NO_ACCESS_FILENAME);
    if (!fs.existsSync(urlFilePath)) {
      fs.writeFileSync(urlFilePath, URL_FILE_CONTENT, { encoding: 'utf8' });
    }
    try {
      this.onInaccessible(folderPath);
    } catch (_) {
      // overlay/notification hook failure must never break sync
    }
    this.emit('no-access', folderPath);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  async _downloadFile(entry, localPath) {
    try {
      this.onStatus(`Downloading: ${entry.path_display}`);
      ensureDir(path.dirname(localPath));
      const data = await this.apiClient.downloadFile(entry.path_display);
      writeFileAtomic(localPath, data);

      const pathKey = entry.path_lower || entry.path_display.toLowerCase();
      this.indexCache.setRev(pathKey, entry.rev);
      this.indexCache.setLastSync(pathKey, fs.statSync(localPath).mtimeMs);

      this.onStatus(`Downloaded: ${entry.path_display}`);
      this.emit('download-success', { localPath, dropboxPath: entry.path_display });
    } catch (err) {
      if (err && (err.status === 403 || err.statusCode === 403)) {
        this._createNoAccessStub(path.dirname(localPath));
        return;
      }
      this.onError(new Error(`Download failed for ${entry.path_display}: ${err.message}`));
      this.emit('download-error', { dropboxPath: entry.path_display, error: err });
    }
  }

  _pruneLocalExtras(remotePathSet) {
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const dropboxPath = this._toDropboxPath(fullPath);
        const pathKey = dropboxPath.toLowerCase();

        if (entry.name === NO_ACCESS_FILENAME) continue;
        if (entry.name.startsWith('.')) continue;

        if (!remotePathSet.has(pathKey)) {
          const cachedRev = this.indexCache.getRev(pathKey);
          if (cachedRev) {
            // Was previously synced, remote deleted it
            try {
              if (entry.isDirectory()) {
                fs.rmSync(fullPath, { recursive: true, force: true });
              } else {
                fs.unlinkSync(fullPath);
              }
              this.indexCache.remove(pathKey);
              this.onStatus(`Removed locally deleted remote item: ${dropboxPath}`);
            } catch (e) {
              this.onError(new Error(`Failed to prune ${dropboxPath}: ${e.message}`));
            }
          }
        } else if (entry.isDirectory()) {
          walk(fullPath);
        }
      }
    };
    walk(this.localRoot);
  }

  _toLocalPath(dropboxPath) {
    // dropboxPath is like /Folder/file.txt
    const relative = dropboxPath.replace(/^\//, '').replace(/\//g, path.sep);
    return path.join(this.localRoot, relative);
  }

  _toDropboxPath(localPath) {
    const relative = path.relative(this.localRoot, localPath);
    return '/' + relative.replace(/\\/g, '/');
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // -------------------------------------------------------------------------
  // Queue persistence — survives app restarts so offline edits are not lost
  // -------------------------------------------------------------------------

  _persistQueues() {
    if (!this.indexCache || typeof this.indexCache.setQueue !== 'function') return;
    const strip = (q) => q.map(({ _inFlight, ...rest }) => rest);
    try {
      this.indexCache.setQueue('upload', strip(this._uploadQueue));
      this.indexCache.setQueue('delete', strip(this._deleteQueue));
    } catch (e) {
      // Persistence failure is non-fatal; in-memory queue still functions.
    }
  }

  _restoreQueues() {
    if (!this.indexCache || typeof this.indexCache.getQueue !== 'function') return;
    try {
      const up = this.indexCache.getQueue('upload');
      const del = this.indexCache.getQueue('delete');
      for (const item of up) {
        if (item && item.localPath && item.dropboxPath) {
          this.queueUpload(item.localPath, item.dropboxPath);
        }
      }
      for (const item of del) {
        if (item && item.dropboxPath) this.queueDelete(item.dropboxPath);
      }
    } catch (e) {
      // ignore restore failures
    }
  }
}

module.exports = SyncEngine;
