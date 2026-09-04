import { useState, useEffect, type ComponentType } from 'react';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '../../amplify/data/resource';
import {
  CheckCircleIcon,
  ClipboardIcon,
  CloseIcon,
  EditIcon,
  LightbulbIcon,
  MapPinIcon,
  MicIcon,
  PillIcon,
  SearchIcon,
  ThermometerIcon,
  UtensilsIcon,
} from './icons';
import StatusMessage from './StatusMessage';
import LabelScanButton from './LabelScanButton';
import type { Page } from '../types';
import { toLocalDatetimeInputValue } from '../utils/formatTime';
import { COMMON_ALLERGENS } from '../utils/allergens';
import { buildContainsSummary, detectAllergensInText } from '../utils/ocr';
import { useActivePatient } from '../contexts/useActivePatient';
import { listAll } from '../utils/listAll';
import PatientSwitcher from './PatientSwitcher';

const client = generateClient<Schema>();

/**
 * Tags are stored as a JSON string array. A row written by an older build, or
 * corrupted in transit, must not take the whole health log down with it — the
 * list is rendered from a .map, so one throw loses every entry.
 */
function parseTags(raw: string | null | undefined): string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : undefined;
  } catch {
    return undefined;
  }
}

function formatTime(iso: string) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Spelled out rather than closed with an index signature: the catch-all let
// any misspelled field read as valid, and a typo here surfaces as a silently
// blank row in someone's health log rather than an error.
interface HealthEntry {
  id: string;
  type: 'Exposure' | 'Symptom' | 'Medication';
  name: string;
  time: string;
  severity?: number | null;
  bodyArea?: string | null;
  notes?: string | null;
  subtype?: string | null;
  details?: string | null;
  tags?: string[];                   // parsed here; stored as a JSON string
  dose?: string | null;
  unit?: string | null;
  route?: string | null;
  reason?: string | null;
  quantity?: string | null;
  quantityUnit?: string | null;
  ocrIngredients?: string | null;
  ocrNutrition?: string | null;
  containsSummary?: string | null;
}

const SYMPTOM_LIST = ['Hives', 'Swelling', 'Itching', 'Nausea', 'Vomiting', 'Stomach Pain', 'Difficulty Breathing', 'Dizziness', 'Fatigue', 'Headache', 'Rash', 'Other'];
const MED_ROUTES = ['Oral', 'Topical', 'Injectable', 'Inhaled'];
const MED_UNITS = ['mg', 'ml', 'mcg', 'oz', 'units', 'puffs'];
const ICONS: Record<string, ComponentType> = { Exposure: UtensilsIcon, Symptom: ThermometerIcon, Medication: PillIcon };

function SeverityBar({ value }: { value: number }) {
  const color = value <= 3 ? '#6abf8e' : value <= 6 ? '#f5c842' : '#DC2626';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
      <div style={{ flex: 1, height: 6, background: '#E9EDEF', borderRadius: 99, overflow: 'hidden' }}>
        <div style={{ width: `${value * 10}%`, height: '100%', background: color, borderRadius: 99 }} />
      </div>
      <span style={{ fontWeight: 700, color, minWidth: 18, fontSize: 13 }}>{value}</span>
    </div>
  );
}

function EntryCard({ entry, onDelete, onEdit }: { entry: HealthEntry; onDelete: () => void; onEdit: (updates: Partial<HealthEntry>) => void }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(entry.name);
  const [editNotes, setEditNotes] = useState(entry.notes ?? entry.details ?? entry.reason ?? '');
  const [editSeverity, setEditSeverity] = useState(entry.severity ?? 5);
  const TypeIcon = ICONS[entry.type];

  const startEdit = () => {
    setEditName(entry.name);
    setEditNotes(entry.notes ?? entry.details ?? entry.reason ?? '');
    setEditSeverity(entry.severity ?? 5);
    setEditing(true);
  };

  const saveEdit = () => {
    const updates: Partial<HealthEntry> = { name: editName.trim() || entry.name };
    if (entry.type === 'Symptom') updates.severity = editSeverity;
    if (entry.notes !== undefined) updates.notes = editNotes;
    else if (entry.details !== undefined) updates.details = editNotes;
    else if (entry.reason !== undefined) updates.reason = editNotes;
    onEdit(updates);
    setEditing(false);
  };

  return (
    <div style={{ border: '1px solid #E9EDEF', borderRadius: 8, padding: 12, marginBottom: 8, background: '#fff' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, background: '#D1E7F4', color: '#4A7BA7', padding: '2px 8px', borderRadius: 12 }}>
              <TypeIcon /> {entry.type}
            </span>
            {entry.subtype && <span style={{ fontSize: 11, color: '#999' }}>{entry.subtype}</span>}
          </div>
          {editing ? (
            <input type="text" value={editName} onChange={e => setEditName(e.target.value)}
              style={{ width: '100%', padding: 8, border: '1px solid #4A7BA7', borderRadius: 6, fontSize: 14, fontWeight: 600, marginBottom: 4 }} />
          ) : (
            <div style={{ fontWeight: 600, fontSize: 14, color: '#111B21', marginBottom: 2 }}>
              {entry.name}
              {entry.dose && <span style={{ fontWeight: 400, color: '#667781', fontSize: 13 }}> — {entry.dose}{entry.unit} ({entry.route})</span>}
            </div>
          )}
          <div style={{ fontSize: 12, color: '#667781' }}>{formatTime(entry.time)}</div>
        </div>
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          {!confirmDelete && !editing && (
            <>
              <button onClick={startEdit} title="Edit entry" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: '1px solid #E9EDEF', borderRadius: 4, width: 26, height: 26, cursor: 'pointer', color: '#4A7BA7' }}><EditIcon /></button>
              <button onClick={() => setConfirmDelete(true)} title="Delete entry" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: '1px solid #E9EDEF', borderRadius: 4, width: 26, height: 26, cursor: 'pointer', color: '#DC2626' }}><CloseIcon /></button>
            </>
          )}
          {confirmDelete && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <span style={{ color: '#DC2626', fontWeight: 600 }}>Delete this entry?</span>
              <button onClick={onDelete} style={{ background: '#DC2626', color: '#fff', border: 'none', borderRadius: 4, padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>Yes</button>
              <button onClick={() => setConfirmDelete(false)} style={{ background: 'none', border: '1px solid #E9EDEF', borderRadius: 4, padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer', color: '#667781' }}>No</button>
            </div>
          )}
        </div>
      </div>
      {!editing && entry.severity != null && <SeverityBar value={entry.severity} />}
      {editing && entry.type === 'Symptom' && (
        <div style={{ marginTop: 6 }}>
          <label style={{ fontSize: 12, color: '#667781' }}>Severity: {editSeverity}/10</label>
          <input type="range" min="1" max="10" value={editSeverity} onChange={e => setEditSeverity(Number(e.target.value))} style={{ width: '100%', accentColor: '#4A7BA7' }} />
        </div>
      )}
      {entry.quantity && (
        <div style={{ fontSize: 12, color: '#667781', marginTop: 2 }}>
          Quantity: {entry.quantity}{entry.quantityUnit ? ` ${entry.quantityUnit}` : ''}
        </div>
      )}
      {(entry.tags?.length ?? 0) > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
          {entry.tags?.map((t, i) => (
            <span key={i} style={{ background: '#F0F2F5', border: '1px solid #E9EDEF', borderRadius: 12, padding: '2px 8px', fontSize: 11, color: '#667781' }}>{t}</span>
          ))}
        </div>
      )}
      {entry.containsSummary && (
        <div className="ocr-contains-summary" style={{ marginTop: 8, marginBottom: 0 }}>{entry.containsSummary}</div>
      )}
      {!editing && (entry.notes || entry.details || entry.reason || entry.bodyArea || entry.ocrIngredients || entry.ocrNutrition) && (
        <div style={{ marginTop: 8, padding: 10, background: '#F0F2F5', borderRadius: 6, fontSize: 13, color: '#3B4A54', borderTop: '1px solid #E9EDEF' }}>
          {entry.bodyArea && <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}><MapPinIcon /> {entry.bodyArea}</div>}
          {entry.notes || entry.details || entry.reason}
          {entry.ocrIngredients && (
            <div style={{ marginTop: 6 }}>
              <strong>Scanned ingredients:</strong>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{entry.ocrIngredients}</div>
            </div>
          )}
          {entry.ocrNutrition && (
            <div style={{ marginTop: 6 }}>
              <strong>Scanned nutrition facts:</strong>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{entry.ocrNutrition}</div>
            </div>
          )}
        </div>
      )}
      {editing && (
        <div style={{ marginTop: 8 }}>
          <label style={{ fontSize: 12, color: '#667781' }}>Notes</label>
          <textarea value={editNotes} onChange={e => setEditNotes(e.target.value)} rows={2}
            style={{ width: '100%', padding: 8, border: '1px solid #E9EDEF', borderRadius: 6, fontFamily: 'inherit', fontSize: 13 }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button onClick={saveEdit} className="save-btn" style={{ padding: '6px 14px', fontSize: 12 }}>Save changes</button>
            <button onClick={() => setEditing(false)} style={{ padding: '6px 14px', fontSize: 12, background: 'none', border: '1px solid #E9EDEF', borderRadius: 8, cursor: 'pointer', color: '#667781' }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

interface SymptomLoggerPageProps {
  initialTab?: 'Exposure' | 'Symptom' | 'Medication' | 'History';
  onNavigate?: (page: Page) => void;
}

export default function SymptomLoggerPage({ initialTab, onNavigate }: SymptomLoggerPageProps) {
  const { activeId, activePatient } = useActivePatient();
  const loggingFor = activePatient && !activePatient.isOwner ? activePatient.firstName : 'yourself';
  const now = new Date();
  const [activeTab, setActiveTab] = useState<'Exposure' | 'Symptom' | 'Medication' | 'History'>(initialTab ?? 'Exposure');
  const [entries, setEntries] = useState<HealthEntry[]>([]);
  const [historyFilter, setHistoryFilter] = useState('All');
  const [search, setSearch] = useState('');
  const [loaded, setLoaded] = useState(false);

  const [expType, setExpType] = useState('Meal');
  const [expName, setExpName] = useState('');
  const [expTags, setExpTags] = useState('');
  const [expDetails, setExpDetails] = useState('');
  const [expTime, setExpTime] = useState(toLocalDatetimeInputValue(now));
  const [expQuantity, setExpQuantity] = useState('');
  const [expQuantityUnit, setExpQuantityUnit] = useState('grams');
  const [expOcrIngredients, setExpOcrIngredients] = useState('');
  const [expOcrNutrition, setExpOcrNutrition] = useState('');

  const [symName, setSymName] = useState('');
  const [symCustom, setSymCustom] = useState('');
  const [symSeverity, setSymSeverity] = useState(5);
  const [symBody, setSymBody] = useState('');
  const [symNotes, setSymNotes] = useState('');
  const [symTime, setSymTime] = useState(toLocalDatetimeInputValue(now));

  const [medName, setMedName] = useState('');
  const [medDose, setMedDose] = useState('');
  const [medUnit, setMedUnit] = useState('mg');
  const [medRoute, setMedRoute] = useState('Oral');
  const [medReason, setMedReason] = useState('');
  const [medNotes, setMedNotes] = useState('');
  const [medTime, setMedTime] = useState(toLocalDatetimeInputValue(now));

  const [savedMsg, setSavedMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  // ── Load entries from DynamoDB ──
  useEffect(() => {
    (async () => {
      try {
        const data = await listAll(nextToken => client.models.HealthEntry.list({ nextToken }));
        if (data) {
          // Scoped to whoever the switcher is on: a history mixing two children
          // is worse than useless when deciding what one of them reacted to.
          const mapped: HealthEntry[] = data
            .filter(d => (d.familyMemberId ?? undefined) === activeId)
            .map(d => ({
            id: d.id,
            type: d.type as HealthEntry['type'],
            subtype: d.subtype ?? undefined,
            name: d.name,
            severity: d.severity ?? undefined,
            bodyArea: d.bodyArea ?? undefined,
            notes: d.notes ?? undefined,
            tags: parseTags(d.tags),
            details: d.details ?? undefined,
            dose: d.dose ?? undefined,
            unit: d.unit ?? undefined,
            route: d.route ?? undefined,
            reason: d.reason ?? undefined,
            quantity: d.quantity ?? undefined,
            quantityUnit: d.quantityUnit ?? undefined,
            ocrIngredients: d.ocrIngredients ?? undefined,
            ocrNutrition: d.ocrNutrition ?? undefined,
            containsSummary: d.containsSummary ?? undefined,
            time: d.time,
          }));
          setEntries(mapped);
        }
      } catch (e) {
        console.warn('Failed to load HealthEntry list:', e);
      }
      setLoaded(true);
    })();
  }, [activeId]);

  // Validation speaks through the same banner as a save result, instead of a
  // modal alert() the user has to dismiss before fixing the field.
  const warn = (text: string) => {
    setSavedMsg({ type: 'error', text });
    setTimeout(() => setSavedMsg(null), 3000);
  };

  // Resolves true only once the row is actually in the table, so the caller
  // knows whether it is safe to clear the form.
  const addEntry = async (entry: Omit<HealthEntry, 'id'>): Promise<boolean> => {
    setSaving(true);
    try {
      const tagsStr = entry.tags?.length ? JSON.stringify(entry.tags) : undefined;
      const { data: created, errors } = await client.models.HealthEntry.create({
        // Without this every hand-logged entry was filed against the account
        // owner, and the clinician export then named the wrong patient.
        familyMemberId: activeId ?? null,
        type: entry.type,
        subtype: entry.subtype ?? undefined,
        name: entry.name,
        severity: entry.severity ?? undefined,
        bodyArea: entry.bodyArea ?? undefined,
        notes: entry.notes ?? undefined,
        tags: tagsStr,
        details: entry.details ?? undefined,
        dose: entry.dose ?? undefined,
        unit: entry.unit ?? undefined,
        route: entry.route ?? undefined,
        reason: entry.reason ?? undefined,
        time: entry.time,
        quantity: entry.quantity ?? undefined,
        quantityUnit: entry.quantityUnit ?? undefined,
        ocrIngredients: entry.ocrIngredients ?? undefined,
        ocrNutrition: entry.ocrNutrition ?? undefined,
        containsSummary: entry.containsSummary ?? undefined,
      });
      // Amplify reports a rejected write as an errors array rather than a
      // throw, so an unchecked call reported "Saved!" over a row that was
      // never written.
      if (!created) {
        console.error('Failed to create HealthEntry:', errors);
        setSavedMsg({ type: 'error', text: 'Save failed — your entry is still here, try again' });
        setTimeout(() => setSavedMsg(null), 4000);
        return false;
      }
      setEntries(prev => [...prev, { ...entry, id: created.id }]);
      setSavedMsg({ type: 'success', text: 'Saved!' });
      setTimeout(() => setSavedMsg(null), 2000);
      return true;
    } catch (e) {
      console.error('Failed to create HealthEntry:', e);
      setSavedMsg({ type: 'error', text: 'Save failed — your entry is still here, try again' });
      setTimeout(() => setSavedMsg(null), 4000);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const deleteEntry = async (id: string) => {
    try {
      await client.models.HealthEntry.delete({ id });
      setEntries(prev => prev.filter(x => x.id !== id));
    } catch (e) {
      console.error('Failed to delete HealthEntry:', e);
    }
  };

  const updateEntry = async (id: string, updates: Partial<HealthEntry>) => {
    try {
      // tags lives as a parsed array in state but as a JSON string in the
      // column, so it cannot be spread through untouched.
      const { tags, ...rest } = updates;
      await client.models.HealthEntry.update({
        id,
        ...rest,
        ...(tags !== undefined ? { tags: tags.length ? JSON.stringify(tags) : null } : {}),
      });
      setEntries(prev => prev.map(x => x.id === id ? { ...x, ...updates } : x));
      setSavedMsg({ type: 'success', text: 'Updated!' });
      setTimeout(() => setSavedMsg(null), 2000);
    } catch (e) {
      console.error('Failed to update HealthEntry:', e);
      setSavedMsg({ type: 'error', text: 'Update failed' });
      setTimeout(() => setSavedMsg(null), 3000);
    }
  };

  const filteredEntries = entries
    .filter(e => historyFilter === 'All' || e.type === historyFilter)
    .filter(e => !search || e.name?.toLowerCase().includes(search.toLowerCase()) || (Array.isArray(e.tags) && e.tags.some((t: string) => t.toLowerCase().includes(search.toLowerCase()))))
    .slice().reverse();

  return (
    <div className="page-container">
      {/* The switcher rides in the title row because an entry filed against the
          wrong child is expensive to notice later — who you are logging for has
          to be readable at the moment you type, not one screen away. */}
      <div className="logger-title-row">
        <h2><ClipboardIcon /> Health Logger</h2>
        <PatientSwitcher onManageFamily={onNavigate ? () => onNavigate('profile') : undefined} />
      </div>
      <p className="logger-subject-note">Logging for <strong>{loggingFor}</strong></p>
      {/* Hands off to the guided voice logger, which asks the follow-up
          questions and writes the entry itself. This used to be a dictation
          box that transcribed your words and then did nothing with them. */}
      {onNavigate && (
        <div style={{ background: '#F0F2F5', borderRadius: 8, padding: 12, marginBottom: 20, border: '1px solid #E9EDEF' }}>
          <button
            onClick={() => onNavigate('voice')}
            className="save-btn"
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', fontSize: 13, background: '#4A7BA7' }}
          >
            <MicIcon /> Log by voice with Bea
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#aaa', marginTop: 8 }}>
            <LightbulbIcon /> Bea asks where it is, how bad it is, and when it started — then saves it for you
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '2px solid #E9EDEF', paddingBottom: 0, overflowX: 'auto' }}>
        {(['Exposure', 'Symptom', 'Medication', 'History'] as const).map(t => (
          <button key={t} onClick={() => setActiveTab(t)} style={{
            display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, whiteSpace: 'nowrap',
            padding: '10px 16px', border: 'none', background: 'none', cursor: 'pointer',
            fontWeight: 600, fontSize: 13, color: activeTab === t ? '#4A7BA7' : '#667781',
            borderBottom: activeTab === t ? '2px solid #4A7BA7' : '2px solid transparent', marginBottom: -2
          }}>
            {t === 'Exposure' ? <UtensilsIcon /> : t === 'Symptom' ? <ThermometerIcon /> : t === 'Medication' ? <PillIcon /> : <ClipboardIcon />}
            {t === 'Exposure' ? 'Food / Exposure' : t}
            {t === 'History' && ` (${entries.length})`}
          </button>
        ))}
      </div>

      {savedMsg && (
        <div style={{ background: '#D1E7F4', border: '1px solid #4A7BA7', borderRadius: 6, padding: '10px 16px', marginBottom: 16, fontWeight: 600 }}>
          <StatusMessage type={savedMsg.type} text={savedMsg.text} />
        </div>
      )}

      {activeTab === 'Exposure' && (
        <div>
          <p style={{ fontSize: 13, color: '#667781', marginBottom: 16 }}>
            Log what you ate, used, or were around — you don't need a reaction to log it.
          </p>
          <div className="form-row">
            <div className="form-group"><label>Type</label><select value={expType} onChange={e => setExpType(e.target.value)} style={{ width: '100%', padding: 12, border: '1px solid #E9EDEF', borderRadius: 8 }}><option>Meal</option><option>Product</option><option>Environmental</option><option>Other</option></select></div>
            <div className="form-group form-group--wide"><label>{expType === 'Meal' ? 'What did you eat?' : 'Name / Description'}</label><input type="text" value={expName} onChange={e => setExpName(e.target.value)} placeholder="e.g., Chicken Caesar Salad" style={{ width: '100%', padding: 12, border: '1px solid #E9EDEF', borderRadius: 8 }} /></div>
          </div>
          <div className="form-group">
            <label>Ingredients / Tags (comma-separated)</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
              {COMMON_ALLERGENS.map(a => (
                <button
                  key={a}
                  type="button"
                  onClick={() => {
                    const current = expTags.split(',').map(t => t.trim()).filter(Boolean);
                    if (current.some(t => t.toLowerCase() === a.toLowerCase())) return;
                    setExpTags([...current, a].join(', '));
                  }}
                  style={{ padding: '3px 10px', borderRadius: 14, border: '1px solid #E9EDEF', background: '#F0F2F5', color: '#667781', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
                >
                  + {a}
                </button>
              ))}
            </div>
            <input type="text" value={expTags} onChange={e => setExpTags(e.target.value)} placeholder="e.g., chicken, lettuce, peanuts" style={{ width: '100%', padding: 12, border: '1px solid #E9EDEF', borderRadius: 8 }} />
          </div>

          <div className="form-row">
            <div className="form-group form-group--wide"><label>Quantity</label><input type="text" value={expQuantity} onChange={e => setExpQuantity(e.target.value)} placeholder="e.g., 250" style={{ width: '100%', padding: 12, border: '1px solid #E9EDEF', borderRadius: 8 }} /></div>
            <div className="form-group"><label>Unit</label><select value={expQuantityUnit} onChange={e => setExpQuantityUnit(e.target.value)} style={{ width: '100%', padding: 12, border: '1px solid #E9EDEF', borderRadius: 8 }}>{['grams', 'oz', 'ml', 'cups', 'pieces', 'tbsp'].map(o => <option key={o}>{o}</option>)}</select></div>
          </div>

          <div className="form-group">
            <label>Scan the package (optional)</label>
            <LabelScanButton
              label="Scan Ingredients List (multiple photos OK)"
              multiple
              onExtracted={text => {
                setExpOcrIngredients(prev => prev ? `${prev}\n---\n${text}` : text);
                const detected = detectAllergensInText(text);
                if (detected.length > 0) {
                  const current = expTags.split(',').map(t => t.trim()).filter(Boolean);
                  setExpTags([...new Set([...current, ...detected])].join(', '));
                }
              }}
            />
            <LabelScanButton
              label="Scan Nutrition Facts"
              onExtracted={text => setExpOcrNutrition(prev => prev ? `${prev}\n---\n${text}` : text)}
            />
            {expOcrIngredients && (
              <div className="ocr-extracted-box">
                <span className="ocr-extracted-box-label">Scanned ingredients</span>
                <div className="ocr-extracted-box-text">{expOcrIngredients}</div>
              </div>
            )}
            {expOcrNutrition && (
              <div className="ocr-extracted-box">
                <span className="ocr-extracted-box-label">Scanned nutrition facts</span>
                <div className="ocr-extracted-box-text">{expOcrNutrition}</div>
              </div>
            )}
            {buildContainsSummary(`${expOcrIngredients} ${expOcrNutrition}`) && (
              <div className="ocr-contains-summary">{buildContainsSummary(`${expOcrIngredients} ${expOcrNutrition}`)}</div>
            )}
          </div>

          <div className="form-group"><label>Details</label><textarea value={expDetails} onChange={e => setExpDetails(e.target.value)} rows={2} style={{ width: '100%', padding: 12, border: '1px solid #E9EDEF', borderRadius: 8 }} /></div>
          <div className="form-group"><label>Date & Time</label><input type="datetime-local" value={expTime} onChange={e => setExpTime(e.target.value)} style={{ width: '100%', padding: 12, border: '1px solid #E9EDEF', borderRadius: 8 }} /></div>
          <button className="save-btn" disabled={saving} onClick={async () => {
            if (!expName.trim()) return warn('Please enter a name.');
            const ok = await addEntry({
              type: 'Exposure',
              subtype: expType,
              name: expName,
              tags: expTags.split(',').map(t => t.trim()).filter(Boolean),
              details: expDetails,
              time: expTime,
              quantity: expQuantity || undefined,
              quantityUnit: expQuantity ? expQuantityUnit : undefined,
              ocrIngredients: expOcrIngredients || undefined,
              ocrNutrition: expOcrNutrition || undefined,
              containsSummary: buildContainsSummary(`${expOcrIngredients} ${expOcrNutrition}`) || undefined,
            });
            if (!ok) return;
            setExpName(''); setExpTags(''); setExpDetails(''); setExpQuantity(''); setExpOcrIngredients(''); setExpOcrNutrition('');
          }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}><CheckCircleIcon /> {saving ? 'Saving…' : expType === 'Meal' ? 'Log Food' : 'Log Exposure'}</button>
        </div>
      )}

      {activeTab === 'Symptom' && (
        <div>
          <div className="form-group">
            <label>Symptom</label>
            <select value={symName} onChange={e => setSymName(e.target.value)} style={{ width: '100%', padding: 12, border: '1px solid #E9EDEF', borderRadius: 8 }}>
              <option value="">Select symptom…</option>
              {SYMPTOM_LIST.map(s => <option key={s}>{s}</option>)}
            </select>
          </div>
          {symName === 'Other' && <div className="form-group"><label>Describe</label><input type="text" value={symCustom} onChange={e => setSymCustom(e.target.value)} placeholder="e.g., Throat tightness" style={{ width: '100%', padding: 12, border: '1px solid #E9EDEF', borderRadius: 8 }} /></div>}
          <div className="form-group"><label>Severity: {symSeverity}/10</label><input type="range" min="1" max="10" value={symSeverity} onChange={e => setSymSeverity(Number(e.target.value))} style={{ width: '100%', accentColor: '#4A7BA7' }} /><SeverityBar value={symSeverity} /></div>
          <div className="form-row">
            <div className="form-group"><label>Body Area</label><input type="text" value={symBody} onChange={e => setSymBody(e.target.value)} placeholder="e.g., Face" style={{ width: '100%', padding: 12, border: '1px solid #E9EDEF', borderRadius: 8 }} /></div>
            <div className="form-group"><label>Date & Time</label><input type="datetime-local" value={symTime} onChange={e => setSymTime(e.target.value)} style={{ width: '100%', padding: 12, border: '1px solid #E9EDEF', borderRadius: 8 }} /></div>
          </div>
          <div className="form-group"><label>Notes</label><textarea value={symNotes} onChange={e => setSymNotes(e.target.value)} rows={2} style={{ width: '100%', padding: 12, border: '1px solid #E9EDEF', borderRadius: 8 }} /></div>
          <button className="save-btn" disabled={saving} onClick={async () => {
            const name = symName === 'Other' ? symCustom.trim() : symName;
            if (!name) return warn('Please select a symptom.');
            const ok = await addEntry({ type: 'Symptom', name, severity: symSeverity, bodyArea: symBody, notes: symNotes, time: symTime });
            if (!ok) return;
            setSymName(''); setSymCustom(''); setSymSeverity(5); setSymBody(''); setSymNotes('');
          }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}><CheckCircleIcon /> {saving ? 'Saving…' : 'Log Symptom'}</button>
        </div>
      )}

      {activeTab === 'Medication' && (
        <div>
          <div className="form-group"><label>Medication Name</label><input type="text" value={medName} onChange={e => setMedName(e.target.value)} placeholder="e.g., Benadryl, EpiPen" style={{ width: '100%', padding: 12, border: '1px solid #E9EDEF', borderRadius: 8 }} /></div>
          <div className="form-row">
            <div className="form-group"><label>Dose</label><input type="text" value={medDose} onChange={e => setMedDose(e.target.value)} placeholder="25" style={{ width: '100%', padding: 12, border: '1px solid #E9EDEF', borderRadius: 8 }} /></div>
            <div className="form-group"><label>Unit</label><select value={medUnit} onChange={e => setMedUnit(e.target.value)} style={{ width: '100%', padding: 12, border: '1px solid #E9EDEF', borderRadius: 8 }}>{MED_UNITS.map(o => <option key={o}>{o}</option>)}</select></div>
            <div className="form-group"><label>Route</label><select value={medRoute} onChange={e => setMedRoute(e.target.value)} style={{ width: '100%', padding: 12, border: '1px solid #E9EDEF', borderRadius: 8 }}>{MED_ROUTES.map(o => <option key={o}>{o}</option>)}</select></div>
          </div>
          <div className="form-group"><label>Reason</label><input type="text" value={medReason} onChange={e => setMedReason(e.target.value)} placeholder="e.g., Allergic reaction" style={{ width: '100%', padding: 12, border: '1px solid #E9EDEF', borderRadius: 8 }} /></div>
          <div className="form-group"><label>Notes</label><textarea value={medNotes} onChange={e => setMedNotes(e.target.value)} rows={2} style={{ width: '100%', padding: 12, border: '1px solid #E9EDEF', borderRadius: 8 }} /></div>
          <div className="form-group"><label>Date & Time</label><input type="datetime-local" value={medTime} onChange={e => setMedTime(e.target.value)} style={{ width: '100%', padding: 12, border: '1px solid #E9EDEF', borderRadius: 8 }} /></div>
          <button className="save-btn" disabled={saving} onClick={async () => {
            if (!medName.trim()) return warn('Please enter medication name.');
            const ok = await addEntry({ type: 'Medication', name: medName, dose: medDose, unit: medUnit, route: medRoute, reason: medReason, notes: medNotes, time: medTime });
            if (!ok) return;
            setMedName(''); setMedDose(''); setMedReason(''); setMedNotes('');
          }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}><CheckCircleIcon /> {saving ? 'Saving…' : 'Log Medication'}</button>
        </div>
      )}

      {activeTab === 'History' && (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            {['All', 'Exposure', 'Symptom', 'Medication'].map(f => {
              const FilterIcon = ICONS[f];
              return (
                <button key={f} onClick={() => setHistoryFilter(f)} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 14px', borderRadius: 20, border: '1px solid #E9EDEF', cursor: 'pointer', fontWeight: 600, fontSize: 12, background: historyFilter === f ? '#4A7BA7' : '#F0F2F5', color: historyFilter === f ? '#fff' : '#667781' }}>
                  {FilterIcon && <FilterIcon />} {f}
                </button>
              );
            })}
          </div>
          <div style={{ position: 'relative', marginBottom: 16 }}>
            <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8', display: 'flex' }}><SearchIcon /></span>
            <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search entries…" style={{ width: '100%', padding: '10px 10px 10px 34px', border: '1px solid #E9EDEF', borderRadius: 8 }} />
          </div>
          {!loaded ? <div style={{ textAlign: 'center', padding: 40, color: '#4A7BA7' }}>Loading...</div>
            : filteredEntries.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 40, color: '#ccc' }}>
                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}><ClipboardIcon /></div>
                No entries found
              </div>
            )
              : filteredEntries.map(e => <EntryCard key={e.id} entry={e} onDelete={() => deleteEntry(e.id)} onEdit={updates => updateEntry(e.id, updates)} />)}
        </div>
      )}
    </div>
  );
}