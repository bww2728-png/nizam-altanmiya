import React, { useState } from 'react';
import { AlertTriangle, ArrowLeft, LockKeyhole, ShieldCheck } from 'lucide-react';
import { ErrorBanner } from '../components/ui.jsx';
import brandBanner from '../assets/brand-banner.jpg';
import logoBadge from '../assets/logo-badge.png';
import { errText } from '../lib/format.js';

const TAGLINES = ['تطوير مستدام', 'تنمية محلية', 'تمكين مجتمعي', 'ازدهار وطني'];

/**
 * The gate before the workspace.
 *
 * There is no account and no password: the store is a plain SQLite file, so the
 * button only proves the operator is at the machine. A legacy encrypted store is
 * converted on the first open, and the encrypted copy is kept. Everything the
 * screen promises about locality is true of the code.
 */
export default function Welcome({ status, onOpened }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function enter() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await window.localApp.open();
      if (result?.quarantined) {
        setNotice(`وُجدت قاعدة بيانات قديمة تعذّر فتحها أو تحويلها إلى صيغة غير مشفّرة. لم تُحذف؛ نُقلت إلى «${result.quarantined.split(/[\\/]/).pop()}» وبدأ التطبيق بقاعدة نظيفة.`);
      } else if (result?.recoveredFrom === 'plaintext-staging') {
        setNotice('أكمل التطبيق تحويلًا كان منقطعًا، وبياناتك الآن في قاعدة البيانات العادية التي فُتحت للتو. لا حاجة إلى أي إجراء، ولا يوجد ملف منفصل يُحتفظ به.');
      } else if (result?.recoveredFrom === 'encrypted-backup') {
        setNotice('استُعيدت النسخة المشفّرة المحفوظة وحُوّلت إلى قاعدة بيانات عادية عند بدء التشغيل. النسخة المشفّرة الأصلية محفوظة كنسخة احتياطية بجانب قاعدة البيانات.');
      } else if (result?.recoveredFrom) {
        setNotice(`وُجدت قاعدة بيانات أقدم: «${result.recoveredFrom.split(/[\\/]/).pop()}». لم يُستعدها التطبيق ولم يُحوّلها؛ أُبقيت كما هي في ذلك الملف.`);
      }
      onOpened(result);
    } catch (cause) {
      setError(errText(cause) || 'تعذر فتح قاعدة البيانات.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="welcome-screen">
      <section className="welcome-card pop-in">
        <img className="welcome-banner" src={brandBanner} alt="" />
        <div className="welcome-body">
          <p className="welcome-subtitle">YEMEN LOCAL DEVELOPMENT SYSTEM</p>
          <h1>نظام التنمية المحلية</h1>
          <p className="muted" style={{ fontSize: '0.85rem' }}>الجمهورية اليمنية · مركز إدارة البيانات المحلية</p>
          <p className="welcome-copy">
            منظومة محلية لإدخال بيانات التنمية ومراجعتها وتحليلها. تُحفظ البيانات المعتمدة في قاعدة
            بيانات SQLite غير مشفّرة على هذا الجهاز، ومنها تُبنى المؤشرات والتقارير وترتيب الأولويات.
            وإذا وُجدت قاعدة بيانات مشفّرة من إصدار سابق حُوّلت تلقائيًا عند أول فتح، مع الاحتفاظ
            بنسخة مشفّرة منها.
          </p>
          <ul className="welcome-taglines">
            {TAGLINES.map((tagline) => <li key={tagline}>{tagline}</li>)}
          </ul>

          <ErrorBanner message={error} onDismiss={() => setError('')} />
          {notice && (
            <div className="quote" style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
              <AlertTriangle size={17} style={{ flex: 'none', marginTop: 2 }} />
              <span>{notice}</span>
            </div>
          )}

          <div className="btn-row" style={{ marginTop: 4 }}>
            <button className="btn primary sheen" onClick={enter} disabled={busy}>
              {busy ? 'جارٍ التهيئة...' : status?.hasDatabase ? 'الدخول إلى مساحة العمل' : 'إنشاء قاعدة البيانات والدخول'}
              {!busy && <ArrowLeft size={17} />}
            </button>
            <span className="chip"><LockKeyhole size={13} /> {status?.backups ? `${status.backups} نسخة احتياطية` : 'بلا نسخ احتياطية بعد'}</span>
          </div>

          <div className="privacy-note">
            <ShieldCheck size={18} />
            <span>قاعدة بيانات SQLite محلية غير مشفّرة على جهازك · يمكن فتح الملف ببرامج SQLite أخرى · قراءة الملفات ومعالجة الأرقام محليًا · لا اتصال سحابي</span>
          </div>

          <div className="row" style={{ justifyContent: 'center', opacity: 0.5 }}>
            <img src={logoBadge} alt="" style={{ width: 28, height: 28, borderRadius: 8 }} />
            <span className="dim" style={{ fontSize: '0.72rem' }}>إصدار 0.4 · بيانات محلية</span>
          </div>
        </div>
      </section>
    </main>
  );
}