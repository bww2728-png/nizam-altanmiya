const { contextBridge, ipcRenderer } = require('electron');

/**
 * The renderer's only door to the main process.
 *
 * Every method here maps to exactly one `ipcMain.handle` channel; the channel
 * names of the workbook sheets are grouped so the interface and this list can be
 * compared at a glance. No channel accepts a path it did not receive from a main
 * process dialog unless the main process re-validates it.
 */
contextBridge.exposeInMainWorld('localApp', {
  // Session and store
  status: () => ipcRenderer.invoke('app:status'),
  open: () => ipcRenderer.invoke('db:open'),
  lock: () => ipcRenderer.invoke('db:lock'),
  backupDatabase: () => ipcRenderer.invoke('db:backup'),
  restoreDatabase: () => ipcRenderer.invoke('db:restore'),
  backups: () => ipcRenderer.invoke('db:backups'),

  // Access policy
  accessProfile: () => ipcRenderer.invoke('security:profile:get'),
  setAccessProfile: (request) => ipcRenderer.invoke('security:profile:set', request),

  // Excel import: scan -> plan -> apply
  scanWorkbook: (request) => ipcRenderer.invoke('import:scan', request),
  importPlan: () => ipcRenderer.invoke('import:plan'),
  canonicalProjects: (request) => ipcRenderer.invoke('projects:list', request),
  canonicalProject: (projectId) => ipcRenderer.invoke('projects:get', projectId),
  canonicalProjectReferences: () => ipcRenderer.invoke('projects:references'),
  indicatorObservations: (request) => ipcRenderer.invoke('observations:list', request),
  saveIndicatorObservation: (request) => ipcRenderer.invoke('observations:save', request),
  dataQualityIssues: (request) => ipcRenderer.invoke('quality:list', request),
  resolveDataQualityIssue: (request) => ipcRenderer.invoke('quality:resolve', request),
  saveCanonicalProject: (request) => ipcRenderer.invoke('projects:save', request),
  addProjectFunding: (request) => ipcRenderer.invoke('projects:add-funding', request),
  resolveProjectQualityIssue: (request) => ipcRenderer.invoke('projects:resolve-quality', request),
  addProjectAttachment: (projectId) => ipcRenderer.invoke('projects:add-attachment', projectId),
  exportProjectAttachment: (request) => ipcRenderer.invoke('projects:export-attachment', request),
  importHistory: (request) => ipcRenderer.invoke('import:history', request),
  importSheetPreview: (request) => ipcRenderer.invoke('import:sheet-preview', request),
  importRegions: (request) => ipcRenderer.invoke('import:regions', request),
  importRegionPreview: (request) => ipcRenderer.invoke('import:region-preview', request),
  promoteProjects: (request) => ipcRenderer.invoke('import:promote-projects', request),
  promoteIndicators: (request) => ipcRenderer.invoke('import:promote-indicators', request),
  applyImport: (request) => ipcRenderer.invoke('import:apply', request),
  // Push channel from the scan (reading -> plan -> done). Returns an unsubscribe
  // function so unmounting a page cannot leak listeners.
  onImportProgress: (handler) => {
    const listener = (_event, message) => handler(message);
    ipcRenderer.on('import:progress', listener);
    return () => ipcRenderer.removeListener('import:progress', listener);
  },

  // Workbook sheets
  sheetDashboard: () => ipcRenderer.invoke('sheet:dashboard'),
  sheetIndicators: () => ipcRenderer.invoke('sheet:indicators'),
  sheetRanking: (request) => ipcRenderer.invoke('sheet:ranking', request),

  // Directorates (database sheet + card)
  directorates: (request) => ipcRenderer.invoke('analysis:directorates', request),
  getDirectorate: (id) => ipcRenderer.invoke('analysis:directorate:get', id),
  saveDirectorate: (request) => ipcRenderer.invoke('analysis:directorate:save', request),
  deleteDirectorate: (id) => ipcRenderer.invoke('analysis:directorate:delete', id),
  directorateHistory: (id) => ipcRenderer.invoke('analysis:directorate:history', id),
  restoreVersion: (versionId) => ipcRenderer.invoke('analysis:directorate:restore', versionId),
  fieldCatalogue: () => ipcRenderer.invoke('analysis:fields'),

  // Analysis run and calibration
  runAnalysis: (request) => ipcRenderer.invoke('analysis:run', request),
  latestAnalysis: () => ipcRenderer.invoke('analysis:latest'),
  analysisRuns: () => ipcRenderer.invoke('analysis:runs'),
  rowDetail: (request) => ipcRenderer.invoke('analysis:row-detail', request),
  getWeights: () => ipcRenderer.invoke('analysis:weights:get'),
  setWeights: (request) => ipcRenderer.invoke('analysis:weights:set', request),
  auditLog: (request) => ipcRenderer.invoke('analysis:audit', request),

  // Exports
  exportAnalysisExcel: () => ipcRenderer.invoke('analysis:export-excel'),
  exportAnalysisPdf: () => ipcRenderer.invoke('analysis:export-pdf'),
  exportFilteredPdf: (request) => ipcRenderer.invoke('analysis:export-filtered-pdf', request),

  // Automatic updates (GitHub Releases)
  updateStatus: () => ipcRenderer.invoke('update:status'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (handler) => {
    const listener = (_event, message) => handler(message);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },
});
