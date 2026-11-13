import React, { useState } from 'react';
import { FileSearch, FileSpreadsheet } from 'lucide-react';
import DocumentCenter from './DocumentCenter.jsx';
import ImportPage from './Import.jsx';

const TABS = [
  { id: 'documents', label: 'الوثائق والبحث', icon: FileSearch },
  { id: 'import', label: 'الاستيراد الآلي', icon: FileSpreadsheet },
];

export default function DocumentsHub({ initialTab = 'documents', onNavigate, notify, onApplied, accessProfile }) {
  const [tab, setTab] = useState(initialTab === 'import' ? 'import' : 'documents');

  return (
    <section className="stack">
      <div className="row between" style={{ flexWrap: 'wrap' }}>
        <div className="segmented" role="tablist" aria-label="مركز الوثائق والاستيراد">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
              <Icon size={15} /> {label}
            </button>
          ))}
        </div>
        {tab === 'documents' && <button className="btn primary" type="button" onClick={() => setTab('import')}><FileSpreadsheet size={16} /> استيراد ملف Excel</button>}
      </div>
      {tab === 'import'
        ? <ImportPage onNavigate={onNavigate} notify={notify} onApplied={onApplied} />
        : <DocumentCenter notify={notify} accessProfile={accessProfile} />}
    </section>
  );
}
