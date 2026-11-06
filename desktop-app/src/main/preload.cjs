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

  // Analysis layer
  readTemplate: (request) => ipcRenderer.invoke('analysis:read-template', request),
  commitTemplate: () => ipcRenderer.invoke('analysis:commit-template'),
  runAnalysis: (request) => ipcRenderer.invoke('analysis:run', request),
  latestAnalysis: () => ipcRenderer.invoke('analysis:latest'),
  analysisRuns: () => ipcRenderer.invoke('analysis:runs'),
  getWeights: () => ipcRenderer.invoke('analysis:weights:get'),
  setWeights: (request) => ipcRenderer.invoke('analysis:weights:set', request),
  auditLog: (request) => ipcRenderer.invoke('analysis:audit', request),
  fieldCatalogue: () => ipcRenderer.invoke('analysis:fields'),
  directorates: (request) => ipcRenderer.invoke('analysis:directorates', request),
  exportAnalysisExcel: () => ipcRenderer.invoke('analysis:export-excel'),
  exportAnalysisPdf: () => ipcRenderer.invoke('analysis:export-pdf'),
  onImportProgress: (listener) => {
    const handler = (_event, message) => listener(message);
    ipcRenderer.on('import:progress', handler);
    return () => ipcRenderer.removeListener('import:progress', handler);
  },
});
