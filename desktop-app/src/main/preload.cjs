const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('localApp', {
  status: () => ipcRenderer.invoke('app:status'),
  open: () => ipcRenderer.invoke('db:open'),
  lock: () => ipcRenderer.invoke('db:lock'),
  backupDatabase: () => ipcRenderer.invoke('db:backup'),
  backups: () => ipcRenderer.invoke('db:backups'),
  overview: () => ipcRenderer.invoke('data:overview'),
  imports: () => ipcRenderer.invoke('data:imports'),
  reviewItems: (filters) => ipcRenderer.invoke('review:list', filters),
  approvedValues: () => ipcRenderer.invoke('data:values'),
  selectAndExtract: () => ipcRenderer.invoke('import:select-and-extract'),
  updateReviewItem: (item) => ipcRenderer.invoke('review:update', item),
  resolveReviewItems: (request) => ipcRenderer.invoke('review:resolve', request),
  exportApprovedData: () => ipcRenderer.invoke('data:export'),

  // Access policy
  accessProfile: () => ipcRenderer.invoke('security:profile:get'),
  setAccessProfile: (request) => ipcRenderer.invoke('security:profile:set', request),

  // Review -> analysis bridge
  bridgeCandidates: () => ipcRenderer.invoke('bridge:candidates'),
  bridgeRun: (request) => ipcRenderer.invoke('bridge:run', request),

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
  getDirectorate: (id) => ipcRenderer.invoke('analysis:directorate:get', id),
  saveDirectorate: (request) => ipcRenderer.invoke('analysis:directorate:save', request),
  deleteDirectorate: (id) => ipcRenderer.invoke('analysis:directorate:delete', id),
  directorateHistory: (id) => ipcRenderer.invoke('analysis:directorate:history', id),
  restoreVersion: (versionId) => ipcRenderer.invoke('analysis:directorate:restore', versionId),
  rowDetail: (request) => ipcRenderer.invoke('analysis:row-detail', request),

  // OCR
  readOcrEntry: () => ipcRenderer.invoke('analysis:ocr-read'),
  cancelOcr: () => ipcRenderer.invoke('analysis:ocr-cancel'),
  ocrDecision: (request) => ipcRenderer.invoke('analysis:ocr-decision', request),
  ocrDrafts: (request) => ipcRenderer.invoke('analysis:ocr-drafts', request),
  ocrDraft: (id) => ipcRenderer.invoke('analysis:ocr-draft', id),

  exportAnalysisExcel: () => ipcRenderer.invoke('analysis:export-excel'),
  exportAnalysisPdf: () => ipcRenderer.invoke('analysis:export-pdf'),
  onImportProgress: (listener) => {
    const handler = (_event, message) => listener(message);
    ipcRenderer.on('import:progress', handler);
    return () => ipcRenderer.removeListener('import:progress', handler);
  },
  onOcrProgress: (listener) => {
    const handler = (_event, message) => listener(message);
    ipcRenderer.on('ocr:progress', handler);
    return () => ipcRenderer.removeListener('ocr:progress', handler);
  },
});