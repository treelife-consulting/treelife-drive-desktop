const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('treelife', {
  getStatus: () => ipcRenderer.invoke('get-status'),
  signIn: (email, token) => ipcRenderer.invoke('sign-in', { email, token }),
  signOut: () => ipcRenderer.invoke('sign-out'),
  openSyncFolder: () => ipcRenderer.invoke('open-sync-folder'),
  openDrive: () => ipcRenderer.invoke('open-drive'),
  pauseSync: () => ipcRenderer.invoke('pause-sync'),
  resumeSync: () => ipcRenderer.invoke('resume-sync'),
  onStatusUpdate: (cb) => ipcRenderer.on('status-update', (e, data) => cb(data))
});
