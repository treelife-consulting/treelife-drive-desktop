'use strict';

const chokidar = require('chokidar');
const path = require('path');

const IGNORED_PATTERNS = [
  /(^|[\/\\])\../,
  /\.no-access$/,
  /_Request Access\.url$/,
  /\.tmp$/,
  /\.treelife-/
];

class FileWatcher {
  constructor({ localRoot, onAdd, onChange, onDelete, onReady }) {
    this.localRoot = localRoot.endsWith(path.sep)
      ? localRoot
      : localRoot + path.sep;
    this.onAdd = onAdd || function () {};
    this.onChange = onChange || function () {};
    this.onDelete = onDelete || function () {};
    this.onReady = onReady || function () {};
    this.watcher = null;
  }

  localToDropbox(localPath) {
    let relative = localPath;
    if (relative.startsWith(this.localRoot)) {
      relative = relative.slice(this.localRoot.length);
    } else if (relative.startsWith(this.localRoot.slice(0, -1))) {
      relative = relative.slice(this.localRoot.length - 1);
    }
    relative = relative.replace(/\\/g, '/');
    if (!relative.startsWith('/')) {
      relative = '/' + relative;
    }
    return relative;
  }

  dropboxToLocal(dropboxPath) {
    return path.join(this.localRoot, dropboxPath);
  }

  start() {
    this.watcher = chokidar.watch(this.localRoot, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 800,
        pollInterval: 100
      },
      ignored: IGNORED_PATTERNS,
      persistent: true
    });

    this.watcher
      .on('add', (localPath) => {
        const dropboxPath = this.localToDropbox(localPath);
        this.onAdd(localPath, dropboxPath);
      })
      .on('change', (localPath) => {
        const dropboxPath = this.localToDropbox(localPath);
        this.onChange(localPath, dropboxPath);
      })
      .on('unlink', (localPath) => {
        const dropboxPath = this.localToDropbox(localPath);
        this.onDelete(localPath, dropboxPath);
      })
      .on('addDir', (localPath) => {
        const dropboxPath = this.localToDropbox(localPath);
        this.onAdd(localPath, dropboxPath);
      })
      .on('unlinkDir', (localPath) => {
        const dropboxPath = this.localToDropbox(localPath);
        this.onDelete(localPath, dropboxPath);
      })
      .on('ready', () => {
        this.onReady();
      });
  }

  stop() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}

module.exports = FileWatcher;
