import { useState, useEffect, useRef } from 'react';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '../../amplify/data/resource';
import { AlertTriangleIcon, BarChartIcon, CheckCircleIcon, ClipboardIcon, CloseIcon, FlaskIcon, PlusIcon } from './icons';
import StatusMessage from './StatusMessage';
import { toLocalDateInputValue } from '../utils/formatTime';
import { getBig9Status } from '../utils/allergens';
import { listAll } from '../utils/listAll';

const client = generateClient<Schema>();

interface ExposureTest {
  id: string;
  testName: string;
  allergen: string;
  amount: number;
  unit: string;
  servingContext: string;
  protocol: string;
  baselineSymptoms: string;
  testDate: string;
  testTime: string;
  monitoringDuration: string;
  reminders: string[];
  status: 'planned' | 'active' | 'completed';
  results?: string;
  reactions?: string;
  createdAt: string;
}

const SAFETY_CHECKS = [
  { id: 'provider',    label: 'Healthcare provider has approved this test' },
  { id: 'emergency',   label: 'Emergency medication is within reach' },
  { id: 'someone',     label: 'Someone else is present or aware' },
  { id: 'baseline',    label: 'Current symptoms are at baseline' },
  { id: 'controlled',  label: 'Testing in controlled environment' },
  { id: 'document',    label: 'Ready to document all reactions' },
];
const REMINDER_OPTIONS = ['5 min', '15 min', '30 min', '1 hour', '2 hours', '4 hours'];
const DURATION_OPTIONS  = ['1 hour', '2 hours', '4 hours', '8 hours', '12 hours', '24 hours'];

interface ExposureTestingPageProps {
  initialSection?: string;
}

export default function ExposureTestingPage({ initialSection }: ExposureTestingPageProps) {
  const now = new Date();
  const [activeTab, setActiveTab]       = useState<'new' | 'results' | 'history'>('new');
  const [checks, setChecks]             = useState<Record<string, boolean>>({});
  const [tests, setTests]               = useState<ExposureTest[]>([]);
  const [loaded, setLoaded]             = useState(false);
  const [testName, setTestName]         = useState('');
  const [allergen, setAllergen]         = useState('');
  const [amount, setAmount]             = useState('1.00');
  const [unit, setUnit]                 = useState('grams');
  const [servingContext, setServingCtx] = useState('');
  const [protocol, setProtocol]         = useState('');
  const [baselineSymptoms, setBaseline] = useState('');
  const [testDate, setTestDate]         = useState(toLocalDateInputValue(now));
  const [testTime, setTestTime]         = useState(now.toTimeString().slice(0, 5));
  const [monitoringDuration, setMonDur] = useState('8 hours');
  const [reminders, setReminders]       = useState<string[]>(['15 min', '30 min', '1 hour', '2 hours']);
  const [selectedTestId, setSelTestId]  = useState('');
  const [results, setResults]           = useState('');
  const [reactions, setReactions]       = useState('');
  const [savedMsg, setSavedMsg]         = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const big9Ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (initialSection === 'big9') {
      big9Ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [initialSection]);

  // ── Load from DynamoDB ──
  useEffect(() => {
    (async () => {
      try {
        const data = await listAll(nextToken => client.models.ExposureTest.list({ nextToken }));
        if (data) {
          const mapped: ExposureTest[] = data.map(d => ({
            id: d.id,
            testName: d.testName,
            allergen: d.allergen,
            amount: d.amount ?? 0,
            unit: d.unit ?? 'grams',
            servingContext: d.servingContext ?? '',
            protocol: d.protocol ?? '',
            baselineSymptoms: d.baselineSymptoms ?? '',
            testDate: d.testDate,
            testTime: d.testTime ?? '',
            monitoringDuration: d.monitoringDuration ?? '',
            reminders: d.reminders ? JSON.parse(d.reminders) : [],
            status: d.status as ExposureTest['status'],
            results: d.results ?? undefined,
            reactions: d.reactions ?? undefined,
            createdAt: d.createdAt ?? new Date().toISOString(),
          }));
          setTests(mapped);
        }
      } catch (e) {
        console.warn('Failed to load ExposureTest list:', e);
      }
      setLoaded(true);
    })();
  }, []);

  const allChecked = SAFETY_CHECKS.every(c => checks[c.id]);
  const toggleCheck = (id: string) => setChecks(p => ({ ...p, [id]: !p[id] }));
  const toggleReminder = (r: string) => setReminders(p => p.includes(r) ? p.filter(x => x !== r) : [...p, r]);

  const createTest = async () => {
    if (!allChecked) return alert('Complete safety checklist first.');
    if (!testName.trim() || !allergen.trim()) return alert('Enter test name and allergen.');
    try {
      const { data: created } = await client.models.ExposureTest.create({
        testName,
        allergen,
        amount: parseFloat(amount),
        unit,
        servingContext,
        protocol,
        baselineSymptoms,
        testDate,
        testTime,
        monitoringDuration,
        reminders: JSON.stringify(reminders),
        status: 'active',
      });
      if (created) {
        const test: ExposureTest = {
          id: created.id,
          testName, allergen, amount: parseFloat(amount), unit, servingContext, protocol,
          baselineSymptoms, testDate, testTime, monitoringDuration, reminders,
          status: 'active', createdAt: created.createdAt ?? new Date().toISOString(),
        };
        setTests(prev => [...prev, test]);
      }
      setSavedMsg({ type: 'success', text: 'Test started!' }); setTimeout(() => setSavedMsg(null), 2000);
      setTestName(''); setAllergen(''); setActiveTab('results');
    } catch (e) {
      console.error('Failed to create ExposureTest:', e);
      setSavedMsg({ type: 'error', text: 'Save failed' }); setTimeout(() => setSavedMsg(null), 3000);
    }
  };

  const saveResults = async () => {
    if (!selectedTestId) return alert('Select a test first.');
    try {
      await client.models.ExposureTest.update({
        id: selectedTestId,
        results,
        reactions,
        status: 'completed',
      });
      setTests(prev => prev.map(t => t.id === selectedTestId ? { ...t, results, reactions, status: 'completed' as const } : t));
      setSavedMsg({ type: 'success', text: 'Results saved!' }); setTimeout(() => setSavedMsg(null), 2000);
      setResults(''); setReactions(''); setSelTestId('');
    } catch (e) {
      console.error('Failed to update ExposureTest:', e);
      setSavedMsg({ type: 'error', text: 'Update failed' }); setTimeout(() => setSavedMsg(null), 3000);
    }
  };

  const deleteTest = async (id: string) => {
    if (!window.confirm('Delete?')) return;
    try {
      await client.models.ExposureTest.delete({ id });
      setTests(prev => prev.filter(x => x.id !== id));
    } catch (e) {
      console.error('Failed to delete ExposureTest:', e);
    }
  };

  const completedAllergens = tests.filter(t => t.status === 'completed').map(t => t.allergen);
  const big9 = getBig9Status(completedAllergens);
  const big9TestedCount = big9.filter(a => a.tested).length;

  const startTestFor = (name: string) => {
    setAllergen(name);
    setActiveTab('new');
  };

  return (
    <div className="page-container">
      <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><FlaskIcon /> Exposure Testing</h2>

      <div ref={big9Ref} className="big9-panel">
        <div className="big9-panel-header">
          <span className="big9-panel-title">Big 9 Allergens</span>
          <span className="big9-panel-count">{big9TestedCount}/9 tested</span>
        </div>
        <p className="big9-panel-hint">Tap an allergen to start or review its test.</p>
        <div className="progress-card-badges">
          {big9.map(a => (
            <button
              key={a.name}
              className={`progress-badge progress-badge--clickable${a.tested ? ' progress-badge--tested' : ''}`}
              onClick={() => a.tested ? setActiveTab('history') : startTestFor(a.name)}
              title={a.tested ? `${a.name} — tested` : `${a.name} — tap to start a test`}
            >
              <span className="progress-badge-circle">{a.code}</span>
              <span className="progress-badge-label">{a.name}</span>
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '2px solid #E9EDEF' }}>
        {(['new', 'results', 'history'] as const).map(t => (
          <button key={t} onClick={() => setActiveTab(t)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 16px', border: 'none', background: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 13, color: activeTab === t ? '#4A7BA7' : '#667781', borderBottom: activeTab === t ? '2px solid #4A7BA7' : '2px solid transparent', marginBottom: -2 }}>
            {t === 'new' ? <PlusIcon /> : t === 'results' ? <BarChartIcon /> : <ClipboardIcon />}
            {t === 'new' ? 'New Test' : t === 'results' ? 'Results' : 'History'}
          </button>
        ))}
      </div>
      {savedMsg && (
        <div style={{ background: '#D1E7F4', border: '1px solid #4A7BA7', borderRadius: 6, padding: '10px 16px', marginBottom: 16, fontWeight: 600 }}>
          <StatusMessage type={savedMsg.type} text={savedMsg.text} />
        </div>
      )}

      {activeTab === 'new' && (
        <div>
          <h3 style={{ color: '#DC2626', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}><AlertTriangleIcon /> Safety Checklist</h3>
          {SAFETY_CHECKS.map(c => (
            <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, cursor: 'pointer' }}>
              <input type="checkbox" checked={!!checks[c.id]} onChange={() => toggleCheck(c.id)} style={{ width: 18, height: 18 }} />
              <span style={{ fontSize: 14, color: checks[c.id] ? '#22C55E' : '#111B21' }}>{c.label}</span>
            </label>
          ))}
          {!allChecked && <div style={{ color: '#DC2626', fontSize: 12, marginBottom: 16 }}>Complete all safety checks before proceeding.</div>}

          <div className="form-row" style={{ marginTop: 16 }}>
            <div>
              <div className="form-group"><label>Test Name</label><input type="text" value={testName} onChange={e => setTestName(e.target.value)} style={{ width: '100%', padding: 10, border: '1px solid #E9EDEF', borderRadius: 8 }} /></div>
              <div className="form-group"><label>Allergen</label><input type="text" value={allergen} onChange={e => setAllergen(e.target.value)} style={{ width: '100%', padding: 10, border: '1px solid #E9EDEF', borderRadius: 8 }} /></div>
              <div style={{ display: 'flex', gap: 8 }}>
                <div className="form-group" style={{ flex: 1 }}><label>Amount</label><input type="number" value={amount} onChange={e => setAmount(e.target.value)} style={{ width: '100%', padding: 10, border: '1px solid #E9EDEF', borderRadius: 8 }} /></div>
                <div className="form-group" style={{ flex: 1 }}><label>Unit</label><select value={unit} onChange={e => setUnit(e.target.value)} style={{ width: '100%', padding: 10, border: '1px solid #E9EDEF', borderRadius: 8 }}>{['grams', 'ml', 'mg', 'pieces', 'tbsp'].map(o => <option key={o}>{o}</option>)}</select></div>
              </div>
              <div className="form-group"><label>Serving Context</label><input type="text" value={servingContext} onChange={e => setServingCtx(e.target.value)} style={{ width: '100%', padding: 10, border: '1px solid #E9EDEF', borderRadius: 8 }} /></div>
            </div>
            <div>
              <div className="form-group"><label>Test Date</label><input type="date" value={testDate} onChange={e => setTestDate(e.target.value)} style={{ width: '100%', padding: 10, border: '1px solid #E9EDEF', borderRadius: 8 }} /></div>
              <div className="form-group"><label>Test Time</label><input type="time" value={testTime} onChange={e => setTestTime(e.target.value)} style={{ width: '100%', padding: 10, border: '1px solid #E9EDEF', borderRadius: 8 }} /></div>
              <div className="form-group"><label>Monitoring Duration</label><select value={monitoringDuration} onChange={e => setMonDur(e.target.value)} style={{ width: '100%', padding: 10, border: '1px solid #E9EDEF', borderRadius: 8 }}>{DURATION_OPTIONS.map(o => <option key={o}>{o}</option>)}</select></div>
              <div className="form-group">
                <label>Reminders</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                  {REMINDER_OPTIONS.map(r => <button key={r} onClick={() => toggleReminder(r)} style={{ padding: '4px 10px', borderRadius: 16, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, background: reminders.includes(r) ? '#DC2626' : '#F0F2F5', color: reminders.includes(r) ? '#fff' : '#667781' }}>{r}</button>)}
                </div>
              </div>
            </div>
          </div>
          <div className="form-group"><label>Protocol</label><textarea value={protocol} onChange={e => setProtocol(e.target.value)} rows={3} style={{ width: '100%', padding: 10, border: '1px solid #E9EDEF', borderRadius: 8 }} /></div>
          <div className="form-group"><label>Baseline Symptoms</label><textarea value={baselineSymptoms} onChange={e => setBaseline(e.target.value)} rows={2} style={{ width: '100%', padding: 10, border: '1px solid #E9EDEF', borderRadius: 8 }} /></div>
          <button className="save-btn" onClick={createTest}>Start Exposure Test</button>
        </div>
      )}

      {activeTab === 'results' && (
        <div>
          <div className="form-group">
            <label>Select Test</label>
            <select value={selectedTestId} onChange={e => setSelTestId(e.target.value)} style={{ width: '100%', padding: 10, border: '1px solid #E9EDEF', borderRadius: 8 }}>
              <option value="">Choose a test…</option>
              {tests.filter(t => t.status === 'active').map(t => <option key={t.id} value={t.id}>{t.testName} — {t.allergen} ({t.testDate})</option>)}
            </select>
          </div>
          <div className="form-group"><label>Results</label><textarea value={results} onChange={e => setResults(e.target.value)} rows={4} style={{ width: '100%', padding: 10, border: '1px solid #E9EDEF', borderRadius: 8 }} /></div>
          <div className="form-group"><label>Reactions (if any)</label><textarea value={reactions} onChange={e => setReactions(e.target.value)} rows={3} style={{ width: '100%', padding: 10, border: '1px solid #E9EDEF', borderRadius: 8 }} /></div>
          <button className="save-btn" onClick={saveResults} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}><CheckCircleIcon /> Save Results</button>
        </div>
      )}

      {activeTab === 'history' && (
        <div>
          {!loaded ? <div style={{ textAlign: 'center', padding: 40, color: '#4A7BA7' }}>Loading...</div>
            : tests.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 40, color: '#ccc' }}>
                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}><FlaskIcon /></div>
                No tests yet
              </div>
            )
            : tests.slice().reverse().map(t => (
              <div key={t.id} style={{ border: '1px solid #E9EDEF', borderRadius: 8, padding: 14, marginBottom: 10, background: '#fff' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>{t.testName} <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 12, background: t.status === 'completed' ? '#D4EDDA' : '#D1E7F4', color: t.status === 'completed' ? '#155724' : '#4A7BA7' }}>{t.status}</span></div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#667781', marginTop: 4 }}><FlaskIcon /> {t.allergen} · {t.amount}{t.unit} · {t.testDate}</div>
                    {t.results && <div style={{ fontSize: 13, padding: 8, background: '#F0F2F5', borderRadius: 6, marginTop: 6 }}>{t.results}</div>}
                    {t.reactions && <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, padding: 8, background: '#FFF5F5', borderRadius: 6, marginTop: 4, color: '#DC2626' }}><AlertTriangleIcon /> {t.reactions}</div>}
                  </div>
                  <button onClick={() => deleteTest(t.id)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: '1px solid #E9EDEF', borderRadius: 4, width: 26, height: 26, cursor: 'pointer', color: '#DC2626', flexShrink: 0 }}><CloseIcon /></button>
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}