const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('localApp', {
  status: () => ipcRenderer.invoke('app:status'),
  open: () => ipcRenderer.invoke('db:open'),
  lock: () => ipcRenderer.invoke('db:lock'),
  overview: () => ipcRenderer.invoke('data:overview'),
  imports: () => ipcRenderer.invoke('data:imports'),
  reviewItems: (filters) => ipcRenderer.invoke('review:list', filters),
  approvedValues: () => ipcRenderer.invoke('data:values'),
  selectAndExtract: () => ipcRenderer.invoke('import:select-and-extract'),
  updateReviewItem: (item) => ipcRenderer.invoke('review:update', item),
  resolveReviewItems: (request) => ipcRenderer.invoke('review:resolve', request),
  exportApprovedData: () => ipcRenderer.invoke('data:export'),
  onImportProgress: (listener) => {
    const handler = (_event, message) => listener(message);
    ipcRenderer.on('import:progress', handler);
    return () => ipcRenderer.removeListener('import:progress', handler);
  },
});
