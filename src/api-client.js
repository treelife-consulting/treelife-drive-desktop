'use strict';

const fetch = require('node-fetch');
const fs = require('fs');
const { EventEmitter } = require('events');

class ApiClient extends EventEmitter {
  constructor(token) {
    super();
    this.baseUrl = 'https://drive.treelife.co';
    this.token = token;
    this._longpollActive = false;
    this._cursor = null;
  }

  _authHeaders() {
    return {
      'Authorization': 'Bearer ' + this.token,
      'Content-Type': 'application/json',
    };
  }

  async _handleResponse(res) {
    if (!res.ok) {
      let message = 'Request failed';
      try {
        const body = await res.json();
        message = body.message || body.error || message;
      } catch (_) {
        // ignore json parse failure
      }
      const err = new Error(message);
      err.statusCode = res.status;
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  async getUser() {
    const res = await fetch(this.baseUrl + '/api/auth/me', {
      method: 'GET',
      headers: this._authHeaders(),
    });
    return this._handleResponse(res);
  }

  // ---------------------------------------------------------------------------
  // Listing
  // ---------------------------------------------------------------------------

  // Returns a plain array of entries. Accepts an options object so callers can
  // request a recursive listing; the server returns { entries, cursor }.
  async listFolder(path, opts = {}) {
    let url = this.baseUrl + '/api/files/list?path=' + encodeURIComponent(path);
    if (opts && opts.recursive) url += '&recursive=1';
    const res = await fetch(url, {
      method: 'GET',
      headers: this._authHeaders(),
    });
    const body = await this._handleResponse(res);
    if (body && body.cursor !== undefined) this._cursor = body.cursor;
    if (Array.isArray(body)) return body;
    return (body && body.entries) ? body.entries : [];
  }

  // Fetch the batch of changes accumulated since the stored cursor. Returns an
  // array of change entries (files/folders/deletions).
  async listFolderContinue() {
    const res = await fetch(this.baseUrl + '/api/files/list_continue', {
      method: 'POST',
      headers: this._authHeaders(),
      body: JSON.stringify({ cursor: this._cursor }),
    });
    const body = await this._handleResponse(res);
    if (body && body.cursor !== undefined) this._cursor = body.cursor;
    if (Array.isArray(body)) return body;
    return (body && body.entries) ? body.entries : [];
  }

  // ---------------------------------------------------------------------------
  // Download
  // ---------------------------------------------------------------------------

  async download(path) {
    const url = this.baseUrl + '/api/files/download?path=' + encodeURIComponent(path);
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + this.token,
      },
    });
    if (!res.ok) {
      let message = 'Download failed';
      try {
        const body = await res.json();
        message = body.message || body.error || message;
      } catch (_) {
        // ignore
      }
      const err = new Error(message);
      err.statusCode = res.status;
      err.status = res.status;
      throw err;
    }
    return res;
  }

  // Download and buffer the file contents. Returns a Buffer the sync engine can
  // write to disk atomically.
  async downloadFile(path) {
    const res = await this.download(path);
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  // ---------------------------------------------------------------------------
  // Upload
  // ---------------------------------------------------------------------------

  // Low-level streaming upload. Kept for callers that already hold a stream.
  async _uploadStream(path, readableStream, size) {
    const url = this.baseUrl + '/api/files/upload?path=' + encodeURIComponent(path);
    const headers = {
      'Authorization': 'Bearer ' + this.token,
      'Content-Type': 'application/octet-stream',
    };
    if (size !== undefined && size !== null) {
      headers['Content-Length'] = String(size);
    }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: readableStream,
    });
    return this._handleResponse(res);
  }

  // High-level upload used by the sync engine: reads the local file and streams
  // it to the remote dropbox path. Returns the server response (expects { rev }).
  async uploadFile(localPath, dropboxPath) {
    const stat = fs.statSync(localPath);
    const stream = fs.createReadStream(localPath);
    return this._uploadStream(dropboxPath, stream, stat.size);
  }

  async createFolder(path) {
    const res = await fetch(this.baseUrl + '/api/files/mkdir', {
      method: 'POST',
      headers: this._authHeaders(),
      body: JSON.stringify({ path }),
    });
    return this._handleResponse(res);
  }

  // ---------------------------------------------------------------------------
  // Delete / rename
  // ---------------------------------------------------------------------------

  async deleteItem(path) {
    const res = await fetch(this.baseUrl + '/api/files/delete', {
      method: 'DELETE',
      headers: this._authHeaders(),
      body: JSON.stringify({ path }),
    });
    return this._handleResponse(res);
  }

  // Alias expected by the sync engine.
  async deleteFile(path) {
    return this.deleteItem(path);
  }

  async renameItem(from, to) {
    const res = await fetch(this.baseUrl + '/api/files/rename', {
      method: 'POST',
      headers: this._authHeaders(),
      body: JSON.stringify({ from, to }),
    });
    return this._handleResponse(res);
  }

  async getMetadata(path) {
    const url = this.baseUrl + '/api/files/meta?path=' + encodeURIComponent(path);
    const res = await fetch(url, {
      method: 'GET',
      headers: this._authHeaders(),
    });
    return this._handleResponse(res);
  }

  // ---------------------------------------------------------------------------
  // Long-poll
  // ---------------------------------------------------------------------------

  async longpoll(cursor) {
    const res = await fetch(this.baseUrl + '/api/longpoll', {
      method: 'POST',
      headers: this._authHeaders(),
      body: JSON.stringify({ cursor }),
    });
    return this._handleResponse(res);
  }

  // Blocking-style long-poll used by the sync engine. Resolves true when the
  // server reports remote changes are available, false otherwise (e.g. timeout).
  // The engine then calls listFolderContinue() to fetch the actual entries.
  async longpollFolder() {
    const result = await this.longpoll(this._cursor);
    if (result && result.cursor !== undefined) this._cursor = result.cursor;
    if (result && typeof result.changes === 'boolean') return result.changes;
    return !!(result && result.changes);
  }

  startLongpoll() {
    if (this._longpollActive) return;
    this._longpollActive = true;
    let cursor = this._cursor;

    const loop = async () => {
      if (!this._longpollActive) return;
      try {
        const result = await this.longpoll(cursor);
        if (result && result.cursor !== undefined) {
          cursor = result.cursor;
          this._cursor = result.cursor;
        }
        if (result && result.changes) {
          this.emit('change', result);
        }
        setImmediate(loop);
      } catch (err) {
        this.emit('error', err);
        setTimeout(() => {
          if (this._longpollActive) loop();
        }, 15000);
      }
    };

    loop();
  }

  stopLongpoll() {
    this._longpollActive = false;
  }

  async isOnline() {
    const AbortController = global.AbortController || require('abort-controller');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(this.baseUrl + '/api/auth/me', {
        method: 'HEAD',
        headers: {
          'Authorization': 'Bearer ' + this.token,
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return res.status < 500;
    } catch (_) {
      clearTimeout(timeout);
      return false;
    }
  }
}

module.exports = ApiClient;
