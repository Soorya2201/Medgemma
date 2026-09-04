import { useEffect, useMemo, useState } from 'react';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '../../amplify/data/resource';
import type { Page } from '../types';
import { buildAdherenceGrid, computeTodayOrder } from '../utils/medications';
import type { MedicationLogRow, MedicationRow } from '../utils/medications';
import { listAll } from '../utils/listAll';
import { useActivePatient } from '../contexts/useActivePatient';
import {
  CheckIcon,
  ChevronDownIcon,
  ClockIcon,
  ExclamationCircleIcon,
  PillIcon,
  PlusIcon,
} from './icons';

const client = generateClient<Schema>();

const TIME_LABELS = ['Morning', 'Afternoon', 'Evening', 'Night', 'As needed'];

function currentPeriodLabel(now: Date): string {
  const h = now.getHours();
  if (h < 12) return 'Morning';
  if (h < 17) return 'Afternoon';
  if (h < 21) return 'Evening';
  return 'Night';
}

function formatHistoryDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatHistoryTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

interface MedicationsPageProps {
  onNavigate: (page: Page) => void;
}

export default function MedicationsPage({ onNavigate }: MedicationsPageProps) {
  const { activeId } = useActivePatient();
  const [medications, setMedications] = useState<MedicationRow[]>([]);
  const [logs, setLogs] = useState<MedicationLogRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(new Date());

  const [showAddForm, setShowAddForm] = useState(false);
  const [name, setName] = useState('');
  const [dose, setDose] = useState('');
  const [unit, setUnit] = useState('mg');
  const [route, setRoute] = useState('Oral');
  const [timeLabel, setTimeLabel] = useState('Morning');
  const [scheduledTime, setScheduledTime] = useState('08:00');
  const [frequency, setFrequency] = useState('once');
  const [saving, setSaving] = useState(false);

  const [sortOrder, setSortOrder] = useState<'recent' | 'oldest'>('recent');
  const [timeFilter, setTimeFilter] = useState('All');
  const [historyRange, setHistoryRange] = useState<7 | 14>(7);
  const [historyExpanded, setHistoryExpanded] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [meds, logRows] = await Promise.all([
          listAll(nextToken => client.models.Medication.list({ nextToken })),
          listAll(nextToken => client.models.MedicationLog.list({ nextToken })),
        ]);
        // Scoped to whoever the switcher is on: one household's medication
        // list is not one person's schedule.
        const mine = meds.filter(m => (m.familyMemberId ?? undefined) === activeId);
        const mineIds = new Set(mine.map(m => m.id));
        if (mine) {
          setMedications(mine.map(m => ({
            id: m.id,
            name: m.name,
            dose: m.dose ?? null,
            unit: m.unit ?? null,
            route: m.route ?? null,
            timeLabel: m.timeLabel ?? null,
            scheduledTime: m.scheduledTime ?? null,
            frequency: m.frequency ?? null,
            active: m.active ?? true,
            createdAt: m.createdAt ?? new Date().toISOString(),
          })));
        }
        if (logRows) {
          // A dose carries no patient of its own — it inherits the one on the
          // medication it belongs to.
          setLogs(logRows
            .filter(l => mineIds.has(l.medicationId))
            .map(l => ({ id: l.id, medicationId: l.medicationId, takenAt: l.takenAt })));
        }
      } catch (e) {
        console.warn('Failed to load medications:', e);
      } finally {
        setLoaded(true);
      }
    })();
  }, [activeId]);

  const todayOrder = useMemo(() => computeTodayOrder(medications, logs, now), [medications, logs, now]);
  const adherenceGrid = useMemo(() => buildAdherenceGrid(medications, logs, 7, now), [medications, logs, now]);

  const medById = useMemo(() => {
    const map: Record<string, MedicationRow> = {};
    for (const m of medications) map[m.id] = m;
    return map;
  }, [medications]);

  const historyEntries = useMemo(() => {
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - historyRange);
    return logs
      .filter(l => historyExpanded || new Date(l.takenAt) >= cutoff)
      .filter(l => timeFilter === 'All' || medById[l.medicationId]?.timeLabel === timeFilter)
      .sort((a, b) => sortOrder === 'recent'
        ? new Date(b.takenAt).getTime() - new Date(a.takenAt).getTime()
        : new Date(a.takenAt).getTime() - new Date(b.takenAt).getTime());
  }, [logs, historyRange, historyExpanded, timeFilter, medById, sortOrder, now]);

  const addMedication = async () => {
    if (!name.trim()) return alert('Please enter a medication name.');
    setSaving(true);
    try {
      const { data: created } = await client.models.Medication.create({
        familyMemberId: activeId ?? null,
        name: name.trim(),
        dose: dose || undefined,
        unit: unit || undefined,
        route: route || undefined,
        timeLabel,
        scheduledTime: timeLabel === 'As needed' ? undefined : scheduledTime,
        frequency: frequency || undefined,
        active: true,
      });
      if (created) {
        setMedications(prev => [...prev, {
          id: created.id,
          name: created.name,
          dose: created.dose ?? null,
          unit: created.unit ?? null,
          route: created.route ?? null,
          timeLabel: created.timeLabel ?? null,
          scheduledTime: created.scheduledTime ?? null,
          frequency: created.frequency ?? null,
          active: created.active ?? true,
          createdAt: created.createdAt ?? new Date().toISOString(),
        }]);
      }
      setName(''); setDose(''); setFrequency('once'); setShowAddForm(false);
    } catch (e) {
      console.error('Failed to add medication:', e);
      alert('Could not save this medication. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const logDose = async (medicationId: string) => {
    const takenAt = new Date().toISOString();
    setLogs(prev => [...prev, { id: `pending-${takenAt}`, medicationId, takenAt }]);
    try {
      const { data: created } = await client.models.MedicationLog.create({ medicationId, takenAt });
      if (created) {
        setLogs(prev => prev.map(l => l.id === `pending-${takenAt}` ? { id: created.id, medicationId, takenAt } : l));
      }
    } catch (e) {
      console.error('Failed to log dose:', e);
      setLogs(prev => prev.filter(l => l.id !== `pending-${takenAt}`));
    }
  };

  return (
    <div className="medications-screen">
      <div className="medications-top-bar">
        <button className="medications-back-btn" onClick={() => onNavigate('home')}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
        </button>
        <h1 className="medications-title"><PillIcon /> Medications</h1>
        <div style={{ width: 38 }} />
      </div>

      <div className="medications-body">
        {/* ── Day-wise adherence chart (shown first, per design) ── */}
        <section className="med-chart-card">
          <h2 className="med-section-heading">Adherence — last 7 days</h2>
          {!loaded ? (
            <div className="med-loading">Loading…</div>
          ) : adherenceGrid.length === 0 ? (
            <p className="med-chart-empty">Add a medication below to start tracking adherence.</p>
          ) : (
            <div className="med-chart">
              {adherenceGrid.map(row => (
                <div key={row.medication.id} className="med-chart-row">
                  <span className="med-chart-row-label">{row.medication.name}</span>
                  <div className="med-chart-cells">
                    {row.cells.map(cell => (
                      <span
                        key={cell.dateStr}
                        className={`med-chart-cell med-chart-cell--${cell.status}`}
                        title={`${cell.dateStr}: ${cell.status === 'taken' ? 'Taken' : cell.status === 'missed' ? 'Missed' : 'No data'}`}
                      >
                        {cell.status === 'taken' && <CheckIcon />}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── Today's Medication Order ── */}
        {todayOrder.length > 0 && (
          <section className="med-today-card">
            <div className="med-today-header">
              <h2 className="med-section-heading">Today's Medication Order</h2>
              <span className="med-period-badge">{currentPeriodLabel(now)}</span>
            </div>
            {todayOrder.map(entry => {
              const m = entry.medication;
              const subtitle = [m.timeLabel, [m.dose, m.unit].filter(Boolean).join(''), m.frequency]
                .filter(Boolean)
                .join(' · ');
              return (
                <div
                  key={m.id}
                  className={`med-today-row med-today-row--${entry.status}${entry.isNext ? ' med-today-row--next' : ''}`}
                >
                  <span className={`med-status-icon med-status-icon--${entry.status}`}>
                    {entry.status === 'taken' ? <CheckIcon /> : entry.status === 'missed' ? <ExclamationCircleIcon /> : <ClockIcon />}
                  </span>
                  <div className="med-today-info">
                    <span className="med-today-name">{m.name}</span>
                    <span className="med-today-subtitle">{subtitle}</span>
                  </div>
                  {entry.status === 'taken' ? (
                    <span className="med-status-pill med-status-pill--taken">Taken</span>
                  ) : entry.status === 'asNeeded' ? (
                    <button className="med-status-pill med-status-pill--asneeded" onClick={() => void logDose(m.id)}>
                      Log dose
                    </button>
                  ) : (
                    <button
                      className={`med-status-pill med-status-pill--${entry.status}`}
                      onClick={() => void logDose(m.id)}
                    >
                      {entry.status === 'missed' ? 'Missed' : 'Coming up'}
                    </button>
                  )}
                </div>
              );
            })}
          </section>
        )}

        {/* ── Add Medication ── */}
        {showAddForm ? (
          <section className="med-add-card">
            <h2 className="med-section-heading"><PlusIcon /> Add Medication</h2>
            <div className="med-form-group">
              <label>Medication Name</label>
              <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="e.g., Cetirizine" />
            </div>
            <div className="med-form-row">
              <div className="med-form-group">
                <label>Dose</label>
                <input type="text" value={dose} onChange={e => setDose(e.target.value)} placeholder="10" />
              </div>
              <div className="med-form-group">
                <label>Unit</label>
                <select value={unit} onChange={e => setUnit(e.target.value)}>
                  {['mg', 'ml', 'mcg', 'oz', 'puffs', 'sprays', 'drops', 'units'].map(o => <option key={o}>{o}</option>)}
                </select>
              </div>
              <div className="med-form-group">
                <label>Route</label>
                <select value={route} onChange={e => setRoute(e.target.value)}>
                  {['Oral', 'Topical', 'Injectable', 'Inhaled', 'Nasal', 'Eye drops'].map(o => <option key={o}>{o}</option>)}
                </select>
              </div>
            </div>
            <div className="med-form-row">
              <div className="med-form-group">
                <label>Time of Day</label>
                <select value={timeLabel} onChange={e => setTimeLabel(e.target.value)}>
                  {TIME_LABELS.map(o => <option key={o}>{o}</option>)}
                </select>
              </div>
              {timeLabel !== 'As needed' && (
                <div className="med-form-group">
                  <label>Scheduled Time</label>
                  <input type="time" value={scheduledTime} onChange={e => setScheduledTime(e.target.value)} />
                </div>
              )}
              <div className="med-form-group">
                <label>Frequency</label>
                <input type="text" value={frequency} onChange={e => setFrequency(e.target.value)} placeholder="e.g., once" />
              </div>
            </div>
            <div className="med-form-actions">
              <button className="med-save-btn" onClick={() => void addMedication()} disabled={saving}>
                {saving ? 'Saving…' : 'Save Medication'}
              </button>
              <button className="med-cancel-btn" onClick={() => setShowAddForm(false)}>Cancel</button>
            </div>
          </section>
        ) : (
          <button className="med-add-trigger" onClick={() => setShowAddForm(true)}>
            Add Medication
          </button>
        )}

        {/* ── Filters ── */}
        <div className="med-filter-row">
          <div className="med-filter-group">
            <label>Sort</label>
            <select value={sortOrder} onChange={e => setSortOrder(e.target.value as 'recent' | 'oldest')}>
              <option value="recent">Most recent</option>
              <option value="oldest">Oldest</option>
            </select>
            <ChevronDownIcon />
          </div>
          <div className="med-filter-group">
            <label>Time</label>
            <select value={timeFilter} onChange={e => setTimeFilter(e.target.value)}>
              <option value="All">All</option>
              {TIME_LABELS.map(o => <option key={o}>{o}</option>)}
            </select>
            <ChevronDownIcon />
          </div>
        </div>

        {/* ── Medication Taken history ── */}
        <section className="med-history-card">
          <div className="med-history-header">
            <h2 className="med-section-heading">Medication Taken</h2>
            <div className="med-history-toggle">
              <button
                className={historyRange === 7 && !historyExpanded ? 'active' : ''}
                onClick={() => { setHistoryRange(7); setHistoryExpanded(false); }}
              >
                1 week
              </button>
              <button
                className={historyRange === 14 && !historyExpanded ? 'active' : ''}
                onClick={() => { setHistoryRange(14); setHistoryExpanded(false); }}
              >
                2 weeks
              </button>
            </div>
          </div>

          {!loaded ? (
            <div className="med-loading">Loading…</div>
          ) : historyEntries.length === 0 ? (
            <p className="med-chart-empty">No medication doses logged yet.</p>
          ) : (
            historyEntries.map(l => {
              const m = medById[l.medicationId];
              return (
                <div key={l.id} className="med-history-row">
                  <span className="med-history-date">{formatHistoryDate(l.takenAt)}</span>
                  <div className="med-history-info">
                    <span className="med-history-name">{m?.name ?? 'Unknown medication'}</span>
                    <span className="med-history-subtitle">
                      {formatHistoryTime(l.takenAt)}
                      {m && [m.dose, m.unit].filter(Boolean).join('') && ` · ${[m.dose, m.unit].filter(Boolean).join('')}`}
                      {m?.frequency && ` ${m.frequency}`}
                    </span>
                  </div>
                </div>
              );
            })
          )}

          {!historyExpanded && logs.length > historyEntries.length && (
            <button className="med-expand-history" onClick={() => setHistoryExpanded(true)}>
              Expand medication history
            </button>
          )}
        </section>
      </div>
    </div>
  );
}
