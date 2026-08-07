'use strict';

/**
 * IndexCache — local metadata index for Treelife Drive Desktop.
 *
 * Backed by electron-store (persisted key-value store) when running in the
 * Electron main process.  Falls back to an in-memory Map when electron is not
 * available so unit tests can exercise the same interface without a renderer.
 *
 * Store layout
 * ───────────────────────────────────────────────────────────────────────────
 * entries.<dropboxPath>  →  { rev, size, modified, localMtime, syncedAt,
 *                             accessible }
 * cursor                 →  string | null
 */

let Store;
try {
  Store = require('electron-store');
} catch (_) {
  Store = null; // unit-test fallback — handled in constructor
}

class IndexCache {
  /**
   * @param {string} storeName  Name passed to electron-store (determines the
   *                            filename written to AppData).  Also used as the
   *                            namespace key for the in-memory fallback so
   *                            multiple instances stay isolated in tests.
   */
  constructor(storeName) {
    this._storeName = storeName || 'index-cache';

    if (Store) {
      this._store = new Store({ name: this._storeName });
      this._mode = 'electron-store';
    } else {
      // In-memory fallback: separate Maps per named instance.
      if (!IndexCache._memStores) IndexCache._memStores = {};
      if (!IndexCache._memStores[this._storeName]) {
        IndexCache._memStores[this._storeName] = { entries: {}, cursor: null };
      }
      this._mem = IndexCache._memStores[this._storeName];
      this._mode = 'memory';
    }
  }

  // ─── Internal helpers ────────────────────────────────────────────────────

  _get(key) {
    if (this._mode === 'electron-store') return this._store.get(key);
    // Traverse dot-separated key in the memory store
    return key.split('.').reduce((obj, k) => (obj != null ? obj[k] : undefined), this._mem);
  }

  _set(key, value) {
    if (this._mode === 'electron-store') {
      this._store.set(key, value);
      return;
    }
    const parts = key.split('.');
    let obj = this._mem;
    for (let i = 0; i < parts.length - 1; i++) {
      if (obj[parts[i]] == null || typeof obj[parts[i]] !== 'object') {
        obj[parts[i]] = {};
      }
      obj = obj[parts[i]];
    }
    obj[parts[parts.length - 1]] = value;
  }

  _delete(key) {
    if (this._mode === 'electron-store') {
      this._store.delete(key);
      return;
    }
    const parts = key.split('.');
    let obj = this._mem;
    for (let i = 0; i < parts.length - 1; i++) {
      if (obj[parts[i]] == null) return;
      obj = obj[parts[i]];
    }
    delete obj[parts[parts.length - 1]];
  }

  _getEntries() {
    if (this._mode === 'electron-store') {
      return this._store.get('entries') || {};
    }
    return this._mem.entries || {};
  }

  /** Encode a Dropbox path into a dot-safe store key. */
  _encodeKey(dropboxPath) {
    // electron-store uses dot notation for nested keys; encode the path so
    // slashes and dots in filenames do not create unintended nesting.
    return Buffer.from(dropboxPath).toString('base64url');
  }

  // ─── Entry API ───────────────────────────────────────────────────────────

  /**
   * Upsert a cache entry for the given Dropbox path.
   *
   * @param {string} dropboxPath   Normalised Dropbox path (e.g. /folder/file.pdf)
   * @param {object} fields
   * @param {string}  [fields.rev]
   * @param {number}  [fields.size]
   * @param {string}  [fields.modified]    ISO-8601 server modified time
   * @param {number}  [fields.localMtime]  Local file mtime (ms since epoch)
   * @param {number}  [fields.syncedAt]    Timestamp of last successful sync (ms)
   * @param {boolean} [fields.accessible]  Whether the file is accessible locally
   */
  setEntry(dropboxPath, { rev, size, modified, localMtime, syncedAt, accessible } = {}) {
    const key = 'entries.' + this._encodeKey(dropboxPath);
    const existing = this._get(key) || {};
    const entry = {
      rev:        rev        !== undefined ? rev        : existing.rev,
      size:       size       !== undefined ? size       : existing.size,
      modified:   modified   !== undefined ? modified   : existing.modified,
      localMtime: localMtime !== undefined ? localMtime : existing.localMtime,
      syncedAt:   syncedAt   !== undefined ? syncedAt   : existing.syncedAt,
      accessible: accessible !== undefined ? accessible : (existing.accessible !== undefined ? existing.accessible : true),
    };
    this._set(key, entry);
  }

  /**
   * Retrieve a cache entry.
   * @param {string} dropboxPath
   * @returns {{ rev, size, modified, localMtime, syncedAt, accessible } | null}
   */
  getEntry(dropboxPath) {
    const val = this._get('entries.' + this._encodeKey(dropboxPath));
    return val !== undefined ? val : null;
  }

  /**
   * Remove a cache entry entirely.
   * @param {string} dropboxPath
   */
  deleteEntry(dropboxPath) {
    this._delete('entries.' + this._encodeKey(dropboxPath));
  }

  /**
   * Return every cached entry as a flat array.
   * @returns {Array<{ path: string, rev, size, modified, localMtime, syncedAt, accessible }>}
   */
  getAllEntries() {
    const raw = this._getEntries();
    return Object.entries(raw).map(([encodedKey, entry]) => ({
      path: Buffer.from(encodedKey, 'base64url').toString(),
      ...entry,
    }));
  }

  // ─── Convenience accessors ───────────────────────────────────────────────

  /**
   * Return the syncedAt timestamp for a path, or null if not present.
   * @param {string} dropboxPath
   * @returns {number | null}
   */
  getLastSync(dropboxPath) {
    const entry = this.getEntry(dropboxPath);
    return (entry && entry.syncedAt != null) ? entry.syncedAt : null;
  }

  /**
   * Set the accessible flag for a path.
   * @param {string}  dropboxPath
   * @param {boolean} bool
   */
  setAccessible(dropboxPath, bool) {
    this.setEntry(dropboxPath, { accessible: !!bool });
  }

  /**
   * Return whether a path is accessible locally.
   * Defaults to true when the entry is unknown (optimistic assumption).
   * @param {string} dropboxPath
   * @returns {boolean}
   */
  isAccessible(dropboxPath) {
    const entry = this.getEntry(dropboxPath);
    if (!entry) return true;
    return entry.accessible !== false;
  }

  /**
   * Record a successful sync: update syncedAt to now and store the local mtime.
   * @param {string} dropboxPath
   * @param {number} localMtime  mtime of the just-written local file (ms epoch)
   */
  markSynced(dropboxPath, localMtime) {
    this.setEntry(dropboxPath, {
      localMtime,
      syncedAt: Date.now(),
    });
  }

  /**
   * Wipe all entries (but preserve the cursor).
   */
  clear() {
    if (this._mode === 'electron-store') {
      this._store.delete('entries');
    } else {
      this._mem.entries = {};
    }
  }

  // ─── Longpoll cursor ─────────────────────────────────────────────────────

  /**
   * Persist the Dropbox longpoll cursor.
   * @param {string} cursor
   */
  setCursor(cursor) {
    this._set('cursor', cursor);
  }

  /**
   * Retrieve the persisted longpoll cursor.
   * @returns {string | null}
   */
  getCursor() {
    const val = this._get('cursor');
    return val !== undefined && val !== null ? val : null;
  }

  // ─── Pending-operation queues (survive app restarts) ─────────────────────

  setQueue(name, arr) {
    this._set('queues.' + name, arr || []);
  }

  getQueue(name) {
    const val = this._get('queues.' + name);
    return Array.isArray(val) ? val : [];
  }

  // ─── Sync-engine compatibility aliases ───────────────────────────────────
  // The sync engine addresses entries by a pre-lowercased dropbox path key and
  // uses the terse rev/lastSync/remove vocabulary. These wrap the richer entry
  // API so both callers stay in sync.

  getRev(pathKey) {
    const entry = this.getEntry(pathKey);
    return (entry && entry.rev != null) ? entry.rev : null;
  }

  setRev(pathKey, rev) {
    this.setEntry(pathKey, { rev });
  }

  setLastSync(pathKey, mtimeMs) {
    // The engine stores the local mtime here and later compares a fresh mtime
    // against it, so persist the given value as syncedAt (and localMtime).
    this.setEntry(pathKey, { syncedAt: mtimeMs, localMtime: mtimeMs });
  }

  remove(pathKey) {
    this.deleteEntry(pathKey);
  }
}

module.exports = IndexCache;
