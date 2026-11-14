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

  // Database-driven forms and the shared record/review write path
  dataEntryCatalog: () => ipcRenderer.invoke('data:entry-catalog'),
  dataForms: () => ipcRenderer.invoke('data:forms'),
  dataFormDefinition: (formVersionId) => ipcRenderer.invoke('data:form-definition', formVersionId),
  dataRecords: (request) => ipcRenderer.invoke('data:records:list', request),
  dataRecordOverview: (request) => ipcRenderer.invoke('data:records:overview', request),

  dataProjectParents: (request) => ipcRenderer.invoke('data:project-parents:list', request),
  dataRecord: (recordId) => ipcRenderer.invoke('data:record:get', recordId),
  saveDataRecord: (request) => ipcRenderer.invoke('data:record:save', request),
  reviewDataRecord: (request) => ipcRenderer.invoke('data:record:review', request),
  dataGeography: (search) => ipcRenderer.invoke('data:geography:list', search),
  dataPeriods: () => ipcRenderer.invoke('data:periods:list'),

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
  dataSources: (request) => ipcRenderer.invoke('sources:list', request),
  archiveFiles: (targets) => ipcRenderer.invoke('files:archive', { targets }),
  restoreFiles: (targets) => ipcRenderer.invoke('files:restore', { targets }),
  stageDocument: () => ipcRenderer.invoke('documents:stage'),
  documents: (request) => ipcRenderer.invoke('documents:list', request),
  document: (documentId) => ipcRenderer.invoke('documents:get', documentId),
  extractDocument: (documentId) => ipcRenderer.invoke('documents:extract', documentId),
  documentFieldCandidates: (documentId) => ipcRenderer.invoke('documents:field-candidates', documentId),
  reviewDocumentFieldCandidate: (request) => ipcRenderer.invoke('documents:field-candidate:review', request),
  promoteDocumentFieldCandidates: (request) => ipcRenderer.invoke('documents:field-candidates:promote', request),
  searchDocuments: (request) => ipcRenderer.invoke('documents:search-local', request),
  indexDocumentInRagflow: (documentId) => ipcRenderer.invoke('documents:index-ragflow', documentId),
  syncDocumentIndexStatus: (documentId) => ipcRenderer.invoke('documents:sync-index-status', documentId),
  ragflowStatus: () => ipcRenderer.invoke('ragflow:status'),
  searchKnowledge: (request) => ipcRenderer.invoke('ragflow:search', request),
  resolveDataQualityIssue: (request) => ipcRenderer.invoke('quality:resolve', request),
  saveCanonicalProject: (request) => ipcRenderer.invoke('projects:save', request),
  addProjectFunding: (request) => ipcRenderer.invoke('projects:add-funding', request),
  resolveProjectQualityIssue: (request) => ipcRenderer.invoke('projects:resolve-quality', request),
  addProjectAttachment: (projectId) => ipcRenderer.invoke('projects:add-attachment', projectId),
  exportProjectAttachment: (request) => ipcRenderer.invoke('projects:export-attachment', request),
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
  filteredIndicatorReport: (request) => ipcRenderer.invoke('sheet:indicator-report', request),
  sheetRanking: (request) => ipcRenderer.invoke('sheet:ranking', request),

  // Directorates (database sheet + card)
  directorates: (request) => ipcRenderer.invoke('analysis:directorates', request),
  directorateFilterOptions: (keys) => ipcRenderer.invoke('analysis:directorates:filter-options', keys),
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
  analysisCalculationDetail: (request) => ipcRenderer.invoke('analysis:calculation-detail', request),
  rowDetail: (request) => ipcRenderer.invoke('analysis:row-detail', request),
  getWeights: () => ipcRenderer.invoke('analysis:weights:get'),
  setWeights: (request) => ipcRenderer.invoke('analysis:weights:set', request),
  auditLog: (request) => ipcRenderer.invoke('analysis:audit', request),

  // Exports
  exportAnalysisExcel: () => ipcRenderer.invoke('analysis:export-excel'),
  exportAnalysisPdf: () => ipcRenderer.invoke('analysis:export-pdf'),
  exportFilteredPdf: (request) => ipcRenderer.invoke('analysis:export-filtered-pdf', request),
  exportFilteredExcel: (request) => ipcRenderer.invoke('analysis:export-filtered-excel', request),
  exportFilteredCsv: (request) => ipcRenderer.invoke('analysis:export-filtered-csv', request),

  // Automatic updates (GitHub Releases)
  updateStatus: () => ipcRenderer.invoke('update:status'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (handler) => {
    const listener = (_event, message) => handler(message);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },

  // Unified data layer (one contract over the workbook, the store and imports)
  unified: {
    summary: () => ipcRenderer.invoke('unified:summary'),
    datasets: () => ipcRenderer.invoke('unified:datasets'),
    describe: (datasetKey) => ipcRenderer.invoke('unified:describe', datasetKey),
    list: (request) => ipcRenderer.invoke('unified:list', request),
    get: (request) => ipcRenderer.invoke('unified:get', request),
    save: (request) => ipcRenderer.invoke('unified:save', request),
    remove: (request) => ipcRenderer.invoke('unified:remove', request),
    options: (request) => ipcRenderer.invoke('unified:options', request),
  },

  // Development track: portfolio view, context matrix, issue tree, prioritisation
  development: {
    overview: ({ geoUnitId, periodId } = {}) => ipcRenderer.invoke('development:overview', { geoUnitId, periodId }),
    contextMatrix: (request) => ipcRenderer.invoke('development:context-matrix', request),
    issueTree: (request) => ipcRenderer.invoke('development:issue-tree', request),
    criteria: () => ipcRenderer.invoke('development:criteria'),
    priorityRanking: (request) => ipcRenderer.invoke('development:priority-ranking', request),
    saveAssessment: (request) => ipcRenderer.invoke('development:save-assessment', request),
    issueLinks: (request) => ipcRenderer.invoke('development:issue-links', request),
  },

  // Planning: objectives -> programs -> project links, coverage and portfolio
  planning: {
    overview: () => ipcRenderer.invoke('planning:overview'),
    objectives: (request) => ipcRenderer.invoke('planning:objectives', request),
    programs: (request) => ipcRenderer.invoke('planning:programs', request),
    linkProject: (request) => ipcRenderer.invoke('planning:link-project', request),
    projectProgress: (request) => ipcRenderer.invoke('planning:project-progress', request),
    portfolio: (request) => ipcRenderer.invoke('planning:portfolio', request),
    beneficiaries: (request) => ipcRenderer.invoke('planning:beneficiaries', request),
    geography: (request) => ipcRenderer.invoke('planning:geography', request),
    objectiveCoverage: (request) => ipcRenderer.invoke('planning:objective-coverage', request),
  },

  // Finance: budget vs actual, ledger, revenues, expenditures, commitments
  finance: {
    overview: () => ipcRenderer.invoke('finance:overview'),
    accounts: () => ipcRenderer.invoke('finance:accounts'),
    budgetVariance: (request) => ipcRenderer.invoke('finance:budget-variance', request),
    ledger: (request) => ipcRenderer.invoke('finance:ledger', request),
    recordRevenue: (request) => ipcRenderer.invoke('finance:record-revenue', request),
    recordExpenditure: (request) => ipcRenderer.invoke('finance:record-expenditure', request),
    currencySummary: (request) => ipcRenderer.invoke('finance:currency-summary', request),
    commitments: (request) => ipcRenderer.invoke('finance:commitments', request),
  },

  // Indicator catalogue: definitions, versions, weighting profiles, analysis runs
  indicatorCatalog: {
    list: (request) => ipcRenderer.invoke('indicator-catalog:list', request),
    detail: (request) => ipcRenderer.invoke('indicator-catalog:detail', request),
    saveVersion: (request) => ipcRenderer.invoke('indicator-catalog:save-version', request),
    weightProfiles: () => ipcRenderer.invoke('indicator-catalog:weight-profiles'),
    createWeightProfile: (request) => ipcRenderer.invoke('indicator-catalog:create-weight-profile', request),
    runs: (request) => ipcRenderer.invoke('indicator-catalog:runs', request),
    runDetail: (request) => ipcRenderer.invoke('indicator-catalog:run-detail', request),
    verifyRun: (request) => ipcRenderer.invoke('indicator-catalog:verify-run', request),
    targetCoverage: (request) => ipcRenderer.invoke('indicator-catalog:target-coverage', request),
  },
});
