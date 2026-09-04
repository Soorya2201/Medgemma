import { useEffect, useMemo, useState } from 'react';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '../../amplify/data/resource';
// The stacked mascot+wordmark lockup — matches the reference document's
// header, which is a tall (~0.77 aspect) crop rather than the wide lockup
// used elsewhere in the app.
import immunyLogo from '../assets/immuny-logo-header.png';
import { buildReport, type ReportEntry, type ReportInput, type ReportPatient } from '../utils/clinicalReport';
import { downloadVisitSummary, loadLogo, type LogoImage } from '../utils/exportPdf';
import { getActivePatientId, setActivePatientId } from '../utils/activePatient';
import { listAll } from '../utils/listAll';
import { loadPatients, type Patient } from '../utils/patients';

const client = generateClient<Schema>();

type PeriodKey = '30' | '90' | '180' | 'all';

const PERIOD_LABELS: Record<PeriodKey, string> = {
  '30': 'Last 30 days',
  '90': 'Last 90 days',
  '180': 'Last 6 months',
  'all': 'All time',
};

interface PatientOption {
  id: string | undefined;   // undefined = the profile owner
  label: string;
  patient: ReportPatient;
}

function toReportPatient(p: Patient): ReportPatient {
  return {
    name: p.isOwner ? (p.name === 'Me' ? 'Patient' : p.name) : p.name,
    dateOfBirth: p.dateOfBirth ?? null,
    relationship: p.relationship ?? null,
    knownAllergies: p.knownAllergies ?? null,
    medicalConditions: p.medicalConditions ?? null,
    // Household-level family history from the owner's profile applies to everyone.
    medicalHistory: p.medicalHistory ?? null,
  };
}

interface ExportDataSheetProps {
  onClose: () => void;
}

export default function ExportDataSheet({ onClose }: ExportDataSheetProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [generating, setGenerating] = useState(false);
  const [patients, setPatients] = useState<PatientOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>(getActivePatientId());
  const [period, setPeriod] = useState<PeriodKey>('90');
  const [entryCount, setEntryCount] = useState<number | null>(null);

  const cachedLogo = useMemo<{ current: LogoImage | null }>(() => ({ current: null }), []);

  useEffect(() => {
    (async () => {
      try {
        const options: PatientOption[] = (await loadPatients()).map(p => ({
          id: p.id,
          label: p.name,
          patient: toReportPatient(p),
        }));
        setPatients(options);
        // The saved active-patient id might belong to a family member who was
        // since removed — fall back to the profile owner rather than erroring.
        if (selectedId && !options.some(o => o.id === selectedId)) setSelectedId(undefined);
      } catch (e) {
        console.error('ExportDataSheet: failed to load patients', e);
        setError('Could not load your profile. Please try again.');
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = patients.find(p => p.id === selectedId) ?? patients[0];

  // Live count so the button doesn't feel like a leap into the unknown, and so
  // an empty result ("0 entries in this range") is visible before generating.
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    (async () => {
      setEntryCount(null);
      try {
        const data = await listAll(nextToken => client.models.HealthEntry.list({ nextToken }));
        if (cancelled || !data) return;
        const { start, end } = periodBounds(period);
        const count = data.filter(e => {
          const owner = e.familyMemberId ?? undefined;
          if (owner !== selected.id) return false;
          const t = new Date(e.time).getTime();
          return t >= start.getTime() && t <= end.getTime();
        }).length;
        if (!cancelled) setEntryCount(count);
      } catch {
        if (!cancelled) setEntryCount(null);
      }
    })();
    return () => { cancelled = true; };
  }, [selected, period]);

  const generate = async () => {
    if (!selected) return;
    setGenerating(true);
    setError('');
    try {
      if (!cachedLogo.current) cachedLogo.current = await loadLogo(immunyLogo);

      const [entries, medications, medicationLogs, exposureTests] = await Promise.all([
        listAll(nextToken => client.models.HealthEntry.list({ nextToken })),
        listAll(nextToken => client.models.Medication.list({ nextToken })),
        listAll(nextToken => client.models.MedicationLog.list({ nextToken })),
        listAll(nextToken => client.models.ExposureTest.list({ nextToken })),
      ]);

      const { start, end } = periodBounds(period);
      const patientEntries: ReportEntry[] = (entries ?? [])
        .filter(e => (e.familyMemberId ?? undefined) === selected.id)
        .map(e => ({ ...e }));

      const input: ReportInput = {
        patient: selected.patient,
        entries: patientEntries,
        medications: (medications ?? []).map(m => ({ ...m })),
        medicationLogs: (medicationLogs ?? []).map(l => ({ ...l })),
        // Exposure tests aren't yet attributed to a specific family member in
        // the data model, so a household with more than one patient sees every
        // test on each export — noted here rather than silently mixing records.
        exposureTests: (exposureTests ?? []).map(t => ({ ...t })),
        periodStart: start,
        periodEnd: end,
        generatedAt: new Date(),
      };

      const model = buildReport(input);
      downloadVisitSummary(model, cachedLogo.current);
      setActivePatientId(selected.id);
      onClose();
    } catch (e) {
      console.error('ExportDataSheet: failed to generate export', e);
      setError('Could not generate the export. Please try again.');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="voice-settings-modal" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Export data</h3>
          <button onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">
          {loading ? (
            <div style={{ textAlign: 'center', padding: 20, color: '#4A7BA7' }}>Loading…</div>
          ) : (
            <>
              <p style={{ marginTop: 0, color: '#667781', fontSize: 13, lineHeight: 1.5 }}>
                Generates an allergy visit summary — a PDF built for a clinician, with patterns,
                a reaction timeline, and data-completeness notes. It does not diagnose anything.
              </p>

              <label>Who is this for?</label>
              <select
                className="voice-select"
                value={selectedId ?? '__self__'}
                onChange={e => setSelectedId(e.target.value === '__self__' ? undefined : e.target.value)}
              >
                {patients.map(p => (
                  <option key={p.id ?? '__self__'} value={p.id ?? '__self__'}>{p.label}</option>
                ))}
              </select>

              {selected && !selected.patient.dateOfBirth && (
                <p style={{ fontSize: 12, color: '#b26a00', marginTop: -8, marginBottom: 16 }}>
                  No date of birth on file for {selected.label} — the export will print "DOB: not recorded".
                  {selected.id ? '' : ' Add one in Personal Information above.'}
                </p>
              )}

              <label>Reporting period</label>
              <select className="voice-select" value={period} onChange={e => setPeriod(e.target.value as PeriodKey)}>
                {(Object.keys(PERIOD_LABELS) as PeriodKey[]).map(k => (
                  <option key={k} value={k}>{PERIOD_LABELS[k]}</option>
                ))}
              </select>

              <p style={{ fontSize: 12, color: '#94a3b8', marginTop: -8 }}>
                {entryCount == null ? 'Counting entries…' : `${entryCount} ${entryCount === 1 ? 'entry' : 'entries'} in this range.`}
              </p>

              {error && <p style={{ color: '#DC2626', fontSize: 13 }}>{error}</p>}

              <button className="test-voice-btn" disabled={generating || !selected} onClick={() => void generate()}>
                {generating ? 'Preparing PDF…' : 'Download PDF'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function periodBounds(period: PeriodKey): { start: Date; end: Date } {
  const end = new Date();
  if (period === 'all') return { start: new Date(0), end };
  const days = { '30': 30, '90': 90, '180': 180 }[period];
  const start = new Date(end.getTime() - days * 86_400_000);
  return { start, end };
}
