import { useRef, useState } from 'react';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '../../amplify/data/resource';
import type { Page } from '../types';
import { toLocalDateInputValue } from '../utils/formatTime';
import { COMMON_ALLERGENS } from '../utils/allergens';
import { useActivePatient } from '../contexts/useActivePatient';
import PatientSwitcher from './PatientSwitcher';
import { buildContainsSummary, detectAllergensInText } from '../utils/ocr';
import {
  CameraIcon,
  CheckCircleIcon,
  MicIcon,
  PillIcon,
  PlusIcon,
  ThermometerIcon,
} from './icons';
import StatusMessage from './StatusMessage';
import LabelScanButton from './LabelScanButton';

const client = generateClient<Schema>();

interface FoodTrackerPageProps {
  onNavigate: (page: Page, tab?: string) => void;
}

const TOTAL_STEPS = 3;
const FOOD_FORMS = ['Solid', 'Liquid', 'Pureed', 'Other'] as const;
const TIME_OPTIONS = ['Morning', 'Afternoon', 'Evening', 'Night'] as const;

function FormShapeIcon({ form }: { form: (typeof FOOD_FORMS)[number] }) {
  switch (form) {
    case 'Solid':
      return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /></svg>;
    case 'Liquid':
      return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>;
    case 'Pureed':
      return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 8h16l-3 10H7z" /></svg>;
    default:
      return <PlusIcon />;
  }
}

function TimeOfDayIcon({ time }: { time: (typeof TIME_OPTIONS)[number] }) {
  switch (time) {
    case 'Morning':
      return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 18h16" /><path d="M6 18a6 6 0 0 1 12 0" /></svg>;
    case 'Afternoon':
      return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="5" /><path d="M12 2v2M12 20v2M4 12H2M22 12h-2" /></svg>;
    case 'Evening':
      return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 18h16" /><path d="M18 18a6 6 0 0 0-12 0" /></svg>;
    default:
      return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" /></svg>;
  }
}

export default function FoodTrackerPage({ onNavigate }: FoodTrackerPageProps) {
  const { activeId } = useActivePatient();
  const [step, setStep] = useState(1);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [date, setDate] = useState(toLocalDateInputValue(new Date()));
  const [foodText, setFoodText] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [tagOther, setTagOther] = useState('');
  const [listening, setListening] = useState(false);

  const [foodForm, setFoodForm] = useState<(typeof FOOD_FORMS)[number]>('Solid');
  const [amountServed, setAmountServed] = useState('');
  const [quantity, setQuantity] = useState('');
  const [quantityUnit, setQuantityUnit] = useState('grams');
  const [ocrIngredients, setOcrIngredients] = useState('');
  const [ocrNutrition, setOcrNutrition] = useState('');
  const [completion, setCompletion] = useState(50);
  const [timeOfDay, setTimeOfDay] = useState<(typeof TIME_OPTIONS)[number]>('Morning');
  const [customTime, setCustomTime] = useState('');
  const [showCustomTime, setShowCustomTime] = useState(false);

  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const recRef = useRef<{ stop: () => void } | null>(null);
  const voiceSupported = 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window;

  const toggleTag = (tag: string) => {
    setTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => setImagePreview(ev.target?.result as string);
    reader.readAsDataURL(file);
  };

  const startVoice = (onResult: (text: string) => void) => {
    type SREvent = { results: { [k: number]: { [k: number]: { transcript: string } } } };
    type SRConstructor = new () => {
      lang: string; continuous: boolean; interimResults: boolean;
      start(): void; stop(): void;
      onresult: ((e: SREvent) => void) | null;
      onend: (() => void) | null;
    };
    const win = window as Window & { SpeechRecognition?: SRConstructor; webkitSpeechRecognition?: SRConstructor };
    const SR = win.SpeechRecognition || win.webkitSpeechRecognition;
    if (!SR) return;
    const rec = new SR();
    rec.lang = 'en-US'; rec.continuous = false; rec.interimResults = false;
    rec.onresult = e => onResult(e.results[0][0].transcript);
    rec.onend = () => setListening(false);
    rec.start();
    recRef.current = rec;
    setListening(true);
  };
  const stopVoice = () => { recRef.current?.stop(); setListening(false); };

  const goNext = () => setStep(s => Math.min(TOTAL_STEPS, s + 1));
  const goBack = () => step === 1 ? onNavigate('home') : setStep(s => Math.max(1, s - 1));

  const submit = async () => {
    if (!foodText.trim()) { setStep(1); return; }
    setSaving(true);
    try {
      const allTags = [...tags, ...tagOther.split(',').map(t => t.trim()).filter(Boolean)];
      const timeLabel = showCustomTime && customTime ? customTime : timeOfDay;
      const details = [
        `Form: ${foodForm}`,
        amountServed ? `Amount served: ${amountServed}` : null,
        `Completion: ${completion}%`,
        `Time of day: ${timeLabel}`,
        notes.trim() ? `Notes: ${notes.trim()}` : null,
      ].filter(Boolean).join(' · ');

      await client.models.HealthEntry.create({
        familyMemberId: activeId ?? null,   // whose meal this was
        type: 'Exposure',
        subtype: 'Meal',
        name: foodText.trim(),
        tags: JSON.stringify(allTags),
        details,
        time: `${date}T${new Date().toTimeString().slice(0, 5)}`,
        quantity: quantity || undefined,
        quantityUnit: quantity ? quantityUnit : undefined,
        ocrIngredients: ocrIngredients || undefined,
        ocrNutrition: ocrNutrition || undefined,
        containsSummary: buildContainsSummary(`${ocrIngredients} ${ocrNutrition}`) || undefined,
      });

      setSavedMsg({ type: 'success', text: 'Food logged!' });
      setTimeout(() => onNavigate('home'), 1200);
    } catch (e) {
      console.error('Failed to log food:', e);
      setSavedMsg({ type: 'error', text: 'Save failed. Please try again.' });
      setSaving(false);
    }
  };

  return (
    <div className="page-container food-tracker-page">
      <div className="food-tracker-header">
        <button className="food-tracker-back" onClick={goBack}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
        </button>
        <span className="food-tracker-step-label">Step {step} of {TOTAL_STEPS}</span>
        <PatientSwitcher />
      </div>

      {savedMsg && (
        <div style={{ background: savedMsg.type === 'success' ? '#D1E7F4' : '#FFF5F5', border: `1px solid ${savedMsg.type === 'success' ? '#4A7BA7' : '#DC2626'}`, borderRadius: 8, padding: '10px 16px', marginBottom: 16, fontWeight: 600 }}>
          <StatusMessage type={savedMsg.type} text={savedMsg.text} />
        </div>
      )}

      {step === 1 && (
        <div>
          <h2>Log Foods &amp; Ingredients</h2>
          <div className="food-tracker-photo-box" onClick={() => fileInputRef.current?.click()}>
            {imagePreview
              ? <img src={imagePreview} alt="Meal preview" className="food-tracker-photo-preview" />
              : <span className="food-tracker-photo-placeholder">Take a photo or pick from gallery</span>}
          </div>
          <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileChange} style={{ display: 'none' }} />
          <div className="food-tracker-photo-buttons">
            <button className="food-tracker-photo-btn" onClick={() => fileInputRef.current?.click()}>
              <CameraIcon /> Take Photo / Pick from Gallery
            </button>
          </div>

          <div className="form-group">
            <label>Input Date</label>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ width: '100%', padding: 12, border: '1px solid #E9EDEF', borderRadius: 8 }} />
          </div>

          <div className="form-group">
            <label>Food or Ingredient(s)</label>
            <div className="food-tracker-input-with-mic">
              <input
                type="text"
                value={foodText}
                onChange={e => setFoodText(e.target.value)}
                placeholder="Type here"
                style={{ width: '100%', padding: '12px 40px 12px 12px', border: '1px solid #E9EDEF', borderRadius: 8 }}
              />
              {voiceSupported && (
                <button
                  className={`food-tracker-mic-btn${listening ? ' listening' : ''}`}
                  onClick={() => listening ? stopVoice() : startVoice(t => setFoodText(prev => prev ? `${prev} ${t}` : t))}
                  title="Voice input"
                >
                  <MicIcon />
                </button>
              )}
            </div>
          </div>

          <div className="food-tracker-chip-row">
            {COMMON_ALLERGENS.slice(0, 8).map(a => (
              <button key={a} className={`onboarding-chip${tags.includes(a) ? ' active' : ''}`} onClick={() => toggleTag(a)}>
                {a}
              </button>
            ))}
          </div>
          <input
            type="text"
            value={tagOther}
            onChange={e => setTagOther(e.target.value)}
            placeholder="+ Add more ingredients (comma-separated)"
            style={{ width: '100%', padding: 12, border: '1px solid #E9EDEF', borderRadius: 8, marginTop: 8 }}
          />

          <div className="form-group" style={{ marginTop: 16 }}>
            <label>Scan the package (optional)</label>
            <LabelScanButton
              label="Scan Ingredients List (multiple photos OK)"
              multiple
              onExtracted={text => {
                setOcrIngredients(prev => prev ? `${prev}\n---\n${text}` : text);
                const detected = detectAllergensInText(text);
                if (detected.length > 0) {
                  setTags(prev => [...new Set([...prev, ...detected])]);
                }
              }}
            />
            <LabelScanButton
              label="Scan Nutrition Facts"
              onExtracted={text => setOcrNutrition(prev => prev ? `${prev}\n---\n${text}` : text)}
            />
            {ocrIngredients && (
              <div className="ocr-extracted-box">
                <span className="ocr-extracted-box-label">Scanned ingredients</span>
                <div className="ocr-extracted-box-text">{ocrIngredients}</div>
              </div>
            )}
            {ocrNutrition && (
              <div className="ocr-extracted-box">
                <span className="ocr-extracted-box-label">Scanned nutrition facts</span>
                <div className="ocr-extracted-box-text">{ocrNutrition}</div>
              </div>
            )}
            {buildContainsSummary(`${ocrIngredients} ${ocrNutrition}`) && (
              <div className="ocr-contains-summary">{buildContainsSummary(`${ocrIngredients} ${ocrNutrition}`)}</div>
            )}
          </div>

          <button className="save-btn food-tracker-next-btn" onClick={goNext} disabled={!foodText.trim()}>
            Next
          </button>
        </div>
      )}

      {step === 2 && (
        <div>
          <h2>Food Form</h2>
          <div className="food-tracker-form-grid">
            {FOOD_FORMS.map(f => (
              <button key={f} className={`food-tracker-option${foodForm === f ? ' active' : ''}`} onClick={() => setFoodForm(f)}>
                <FormShapeIcon form={f} />
                <span>{f}</span>
              </button>
            ))}
          </div>

          <div className="form-group">
            <label>Amount Served</label>
            <input type="text" value={amountServed} onChange={e => setAmountServed(e.target.value)} placeholder="e.g., 1 cup, 2 pieces"
              style={{ width: '100%', padding: 12, border: '1px solid #E9EDEF', borderRadius: 8 }} />
          </div>

          <div className="form-row">
            <div className="form-group form-group--wide">
              <label>Quantity</label>
              <input type="text" value={quantity} onChange={e => setQuantity(e.target.value)} placeholder="e.g., 250"
                style={{ width: '100%', padding: 12, border: '1px solid #E9EDEF', borderRadius: 8 }} />
            </div>
            <div className="form-group">
              <label>Unit</label>
              <select value={quantityUnit} onChange={e => setQuantityUnit(e.target.value)} style={{ width: '100%', padding: 12, border: '1px solid #E9EDEF', borderRadius: 8 }}>
                {['grams', 'oz', 'ml', 'cups', 'pieces', 'tbsp'].map(o => <option key={o}>{o}</option>)}
              </select>
            </div>
          </div>

          <div className="form-group">
            <label>Food Completion</label>
            <div className="food-tracker-completion-pill">{completion}%</div>
            <input type="range" min={0} max={100} step={5} value={completion} onChange={e => setCompletion(Number(e.target.value))}
              style={{ width: '100%', accentColor: 'var(--teal)' }} />
          </div>

          <div className="form-group">
            <label>Time of Day</label>
            <div className="food-tracker-form-grid">
              {TIME_OPTIONS.map(t => (
                <button key={t} className={`food-tracker-option${!showCustomTime && timeOfDay === t ? ' active' : ''}`}
                  onClick={() => { setTimeOfDay(t); setShowCustomTime(false); }}>
                  <TimeOfDayIcon time={t} />
                  <span>{t}</span>
                </button>
              ))}
            </div>
            <button className="food-tracker-custom-time-btn" onClick={() => setShowCustomTime(s => !s)}>
              Add Custom Time
            </button>
            {showCustomTime && (
              <input type="time" value={customTime} onChange={e => setCustomTime(e.target.value)}
                style={{ width: '100%', padding: 12, border: '1px solid #E9EDEF', borderRadius: 8, marginTop: 8 }} />
            )}
          </div>

          <button className="save-btn food-tracker-next-btn" onClick={goNext}>Next</button>
        </div>
      )}

      {step === 3 && (
        <div>
          <h2>Notes &amp; Additional Information</h2>
          <div className="food-tracker-input-with-mic">
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={5}
              placeholder="Add any additional information"
              style={{ width: '100%', padding: 12, border: '1px solid #E9EDEF', borderRadius: 8, fontFamily: 'inherit' }}
            />
          </div>

          <div className="food-tracker-cross-links">
            <button className="home-shortcut" onClick={() => onNavigate('symptom-logger', 'Symptom')}>
              <ThermometerIcon /> Log Symptoms
            </button>
            <button className="home-shortcut" onClick={() => onNavigate('symptom-logger', 'Medication')}>
              <PillIcon /> Log Medications
            </button>
          </div>

          <button className="save-btn food-tracker-next-btn" onClick={() => void submit()} disabled={saving}>
            <CheckCircleIcon /> {saving ? 'Logging…' : 'Log Food/Ingredient'}
          </button>
        </div>
      )}
    </div>
  );
}
