import { useState, useRef, useEffect, useCallback } from 'react';
import { Authenticator } from '@aws-amplify/ui-react';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '../amplify/data/resource';
import '@aws-amplify/ui-react/styles.css';
import './App.css';
import beaImg from './assets/bea.png';

// ─── COMPONENT IMPORTS ────────────────────────────────────────────────────────
import ProfilePage from './components/ProfilePage';
import SymptomLoggerPage from './components/SymptomLogger';
import ExposureTestingPage from './components/ExposureTesting';
import ResourceHubPage from './components/ResourceHubPage';
import MedicationsPage from './components/MedicationsPage';
import FoodTrackerPage from './components/FoodTrackerPage';
import HomePage from './components/HomePage';
import OnboardingPage from './components/OnboardingPage';
import InsightsPage from './components/InsightsPage';
import VoicePage from './components/VoicePage';
import CommunityPage from './components/CommunityPage';
import BottomNav from './components/BottomNav';
import PatientSwitcher from './components/PatientSwitcher';
import PatientAvatar from './components/PatientAvatar';
import { ActivePatientProvider } from './contexts/ActivePatientContext';
import { useActivePatient } from './contexts/useActivePatient';
import { ArrowUpIcon, CameraIcon, ClipboardIcon, CloseIcon, MedicalCrossIcon, MicIcon, StopIcon, ThermometerIcon, UtensilsIcon, VolumeIcon } from './components/icons';
import type { Page } from './types';
import { toLocalDatetimeInputValue } from './utils/formatTime';
import { buildSubjectBlock, composeContext, patientSeed, type Patient } from './utils/patients';
import { extractTextFromFiles } from './utils/ocr';
import {
  appendMessage,
  createThread,
  deriveTitle,
  latestThread,
  listAllThreads,
  loadMessages,
  touchThread,
} from './utils/chatThreads';

// ── 🔴 WATCH SENSOR FEATURE (COMMENTED OUT — ready for future integration) ──
// import WatchStatus, { type Vitals } from './components/WatchStatus';

const client = generateClient<Schema>();

// ─── 🔗 API ENDPOINTS (MedGemma — disabled, kept for future re-enable) ────────
const COLAB_BASE_URL = "https://available-lifestyle-additional-hunting.trycloudflare.com";
const AGENT_URL = `${COLAB_BASE_URL}/agent/ask`;
const IMAGE_URL = `${COLAB_BASE_URL}/analyse-image`;
const MEDGEMMA_ENABLED = false; // set to true + deploy Colab to re-enable

// ─── TYPES ────────────────────────────────────────────────────────────────────
interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  source?: 'nova';
  imagePreview?: string;
}

interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

// ─── SESSION CONTEXT (Live Memory) ───────────────────────────────────────────
// This is the "working memory" of the conversation. It tracks entities and
// topics the user mentions so Nova can reference them across turns naturally.
interface SessionContext {
  knownAllergies: string[];        // e.g. ["shellfish", "peanuts"]
  currentSymptoms: string[];       // symptoms mentioned this session
  currentTopic: string | null;     // e.g. "reaction at restaurant"
  lastMentionedFood: string | null;
  lastMentionedMedication: string | null;
  urgencyLevel: 'normal' | 'elevated' | 'emergency';
  turnCount: number;
}

const INITIAL_SESSION_CONTEXT: SessionContext = {
  knownAllergies: [],
  currentSymptoms: [],
  currentTopic: null,
  lastMentionedFood: null,
  lastMentionedMedication: null,
  urgencyLevel: 'normal',
  turnCount: 0,
};

// Session memory belongs to one person, not to the account. Switching patients
// starts a fresh context seeded with that person's recorded allergies, so one
// child's symptoms can never bleed into a conversation about their sibling.
const seedSessionContext = (patient: Patient | null): SessionContext => ({
  ...INITIAL_SESSION_CONTEXT,
  knownAllergies: (patient?.knownAllergies ?? '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean),
});

// ─── ENTITY EXTRACTORS ────────────────────────────────────────────────────────
const ALLERGY_FOOD_RE = /\b(shellfish|shrimp|crab|lobster|peanut|nut|dairy|milk|gluten|wheat|soy|egg|fish|sesame|tree nut|latex|bee|wasp|penicillin|aspirin|ibuprofen|sulfa|mold|dust|pollen|cat|dog|pet)s?\b/gi;
const SYMPTOM_ENTITY_RE = /\b(hives?|swelling|itch(?:ing)?|rash|nausea|vomit(?:ing)?|dizziness|dizzy|wheezing|wheeze|throat tightening|anaphylaxis|cramps?|bloating|stomach pain|difficulty breathing|headache|tingling|redness|bumps?)\b/gi;
const MEDICATION_RE = /\b(benadryl|epipen|epinephrine|cetirizine|zyrtec|claritin|loratadine|prednisone|prednisolone|inhaler|montelukast|singulair|diphenhydramine|hydroxyzine|cortisone|steroid)s?\b/gi;
const EMERGENCY_RE = /\b(can'?t breathe|throat closing|anaphylaxis|epipen|epinephrine|emergency|911|can not breathe|unable to breathe|severe reaction|face swelling|lips? swelling)\b/i;
const ELEVATED_RE = /\b(difficulty breathing|tight(?:ness)?|wheez|throat|spreading|getting worse|severe|bad reaction|not improving|still swelling)\b/i;

const extractEntities = (text: string) => ({
  allergies: [...new Set((text.match(ALLERGY_FOOD_RE) ?? []).map(s => s.toLowerCase()))],
  symptoms: [...new Set((text.match(SYMPTOM_ENTITY_RE) ?? []).map(s => s.toLowerCase()))],
  medications: [...new Set((text.match(MEDICATION_RE) ?? []).map(s => s.toLowerCase()))],
  isEmergency: EMERGENCY_RE.test(text),
  isElevated: ELEVATED_RE.test(text),
});

// ─── CONTEXT SERIALIZER ───────────────────────────────────────────────────────
// Produces a compact 1-3 sentence summary injected into every Nova call.
// Phrased about "the subject" rather than "the user": the person these facts
// describe is whoever the SUBJECT block names, who is often not the person
// typing.
const buildContextSummary = (ctx: SessionContext): string | null => {
  if (ctx.turnCount === 0) return null; // no context yet on first turn
  const parts: string[] = [];
  if (ctx.knownAllergies.length > 0)
    parts.push(`The subject has known allergies to: ${ctx.knownAllergies.join(', ')}.`);
  if (ctx.currentSymptoms.length > 0)
    parts.push(`Symptoms mentioned this session: ${ctx.currentSymptoms.join(', ')}.`);
  if (ctx.currentTopic)
    parts.push(`Current topic: ${ctx.currentTopic}.`);
  if (ctx.lastMentionedFood)
    parts.push(`Last food mentioned: ${ctx.lastMentionedFood}.`);
  if (ctx.lastMentionedMedication)
    parts.push(`Medication mentioned: ${ctx.lastMentionedMedication}.`);
  if (ctx.urgencyLevel === 'emergency')
    parts.push('URGENT: the subject may be experiencing a severe/emergency reaction.');
  else if (ctx.urgencyLevel === 'elevated')
    parts.push('Note: the subject\'s symptoms may be worsening — stay attentive.');
  return parts.length > 0 ? parts.join(' ') : null;
};

// Page type is defined in src/types.ts — imported above

// ─── CONVERSATIONAL LOGGING STATE MACHINE ──────────────────────────────────────
type LoggingEntryType = 'Exposure' | 'Symptom' | 'Medication';

interface FieldDef {
  key: string;
  label: string;
  question: string;          // natural prompt for Nova Micro
  options?: string[];         // if present, fuzzy-match against these
  type?: 'number' | 'text' | 'select' | 'time';  // parsing hint
  optional?: boolean;
}

interface LoggingSession {
  entryType: LoggingEntryType;
  currentFieldIndex: number;
  collectedData: Record<string, string>;
  awaitingConfirmation?: boolean;  // waiting for user to confirm before submit
}

const SYMPTOM_OPTIONS = ['Hives', 'Swelling', 'Itching', 'Nausea', 'Vomiting', 'Stomach Pain', 'Difficulty Breathing', 'Dizziness', 'Fatigue', 'Headache', 'Rash', 'Other'];
const MED_ROUTE_OPTIONS = ['Oral', 'Topical', 'Injectable', 'Inhaled'];
const MED_UNIT_OPTIONS = ['mg', 'ml', 'mcg', 'oz', 'units', 'puffs'];
const EXPOSURE_TYPE_OPTIONS = ['Meal', 'Product', 'Environmental', 'Other'];

// `{subject}` and `{possessive}` are filled in with the person being logged —
// "the user"/"their" when that's the account owner, "Maya"/"Maya's" when a
// caregiver is logging for someone else. Without this, every question Nova
// generates asks the caregiver about their own body.
const FIELD_SCRIPTS: Record<LoggingEntryType, FieldDef[]> = {
  Symptom: [
    { key: 'name', label: 'Symptom', question: 'Ask which symptom {subject} is experiencing. Mention options: Hives, Swelling, Itching, Nausea, Vomiting, Stomach Pain, Difficulty Breathing, Dizziness, Headache, Rash, or Other.', type: 'select', options: SYMPTOM_OPTIONS },
    { key: 'severity', label: 'Severity', question: 'Ask how severe {possessive} symptom is on a scale of 1 to 10.', type: 'number' },
    { key: 'bodyArea', label: 'Body Area', question: 'Ask where on {possessive} body the symptom is (e.g., face, arms, throat).', type: 'text', optional: true },
    { key: 'notes', label: 'Notes', question: 'Ask if there are any additional notes about this symptom. They can say "skip" if none.', type: 'text', optional: true },
  ],
  Exposure: [
    { key: 'subtype', label: 'Type', question: 'Ask what type of exposure this is: Meal, Product, Environmental, or Other.', type: 'select', options: EXPOSURE_TYPE_OPTIONS },
    { key: 'name', label: 'Name', question: 'Ask what {subject} was exposed to (e.g., "Chicken Caesar Salad", "New lotion").', type: 'text' },
    { key: 'tags', label: 'Ingredients/Tags', question: 'Ask for the key ingredients or tags, separated by commas. They can say "skip" if unsure.', type: 'text', optional: true },
    { key: 'details', label: 'Details', question: 'Ask for any additional details about the exposure. They can say "skip" if none.', type: 'text', optional: true },
  ],
  Medication: [
    { key: 'name', label: 'Medication Name', question: 'Ask which medication {subject} took (e.g., Benadryl, EpiPen).', type: 'text' },
    { key: 'dose', label: 'Dose', question: 'Ask what dose {subject} took (just the number, e.g., 25).', type: 'text' },
    { key: 'unit', label: 'Unit', question: 'Ask what unit the dose is in: mg, ml, mcg, units, or puffs.', type: 'select', options: MED_UNIT_OPTIONS },
    { key: 'route', label: 'Route', question: 'Ask how {subject} took the medication: Oral, Topical, Injectable, or Inhaled.', type: 'select', options: MED_ROUTE_OPTIONS },
    { key: 'reason', label: 'Reason', question: 'Ask why {subject} took this medication (e.g., allergic reaction, prevention).', type: 'text', optional: true },
    { key: 'notes', label: 'Notes', question: 'Ask if there are any additional notes about this medication. They can say "skip" if none.', type: 'text', optional: true },
  ],
};

/** Fills a field script's person tokens for whoever is being logged. */
const fillQuestion = (question: string, patient: Patient | null): string =>
  question
    .replace(/\{subject\}/g, patient && !patient.isOwner ? patient.firstName : 'the user')
    .replace(/\{possessive\}/g, patient && !patient.isOwner ? `${patient.firstName}'s` : 'their');

// ─── INTENT DETECTION ─────────────────────────────────────────────────────────
const LOGGING_INTENT_RE: { type: LoggingEntryType; pattern: RegExp }[] = [
  { type: 'Symptom',    pattern: /\b(log|record|track|add|note|enter|save)\b[\s\w]{0,12}\b(symptom|symptoms)\b/i },
  { type: 'Exposure',   pattern: /\b(log|record|track|add|note|enter|save)\b[\s\w]{0,12}\b(exposure|meal|food|what i ate|what i eat)\b/i },
  { type: 'Medication', pattern: /\b(log|record|track|add|note|enter|save)\b[\s\w]{0,12}\b(medication|medicine|med|drug|pill)\b/i },
  // Also detect reversed phrasing: "symptom log", "i want to log"
  { type: 'Symptom',    pattern: /\b(symptom|symptoms)\b[\s\w]{0,8}\b(log|record|track)\b/i },
  { type: 'Exposure',   pattern: /\b(exposure|meal)\b[\s\w]{0,8}\b(log|record|track)\b/i },
  { type: 'Medication', pattern: /\b(medication|medicine|med)\b[\s\w]{0,8}\b(log|record|track)\b/i },
];

const detectLoggingIntent = (text: string): LoggingEntryType | null => {
  for (const { type, pattern } of LOGGING_INTENT_RE) {
    if (pattern.test(text)) return type;
  }
  return null;
};

// ─── ANSWER PARSING ───────────────────────────────────────────────────────────
const fuzzyMatch = (input: string, options: string[]): string | null => {
  const lower = input.toLowerCase().trim();
  // Exact match
  const exact = options.find(o => o.toLowerCase() === lower);
  if (exact) return exact;
  // Starts-with match
  const starts = options.find(o => o.toLowerCase().startsWith(lower));
  if (starts) return starts;
  // Contains match
  const contains = options.find(o => o.toLowerCase().includes(lower) || lower.includes(o.toLowerCase()));
  if (contains) return contains;
  return null;
};

const parseFieldAnswer = (raw: string, field: FieldDef): { value: string; valid: boolean; hint?: string } => {
  const trimmed = raw.trim();
  // Skip / none handling for optional fields
  if (field.optional && /^(skip|none|no|n\/a|nothing|pass)$/i.test(trimmed)) {
    return { value: '', valid: true };
  }
  // Cancel detection
  if (/^(cancel|stop|quit|exit|abort|nevermind)$/i.test(trimmed)) {
    return { value: '__CANCEL__', valid: true };
  }

  if (field.type === 'select' && field.options) {
    const matched = fuzzyMatch(trimmed, field.options);
    if (matched) return { value: matched, valid: true };
    return { value: '', valid: false, hint: `Please choose one of: ${field.options.join(', ')}` };
  }
  if (field.type === 'number') {
    const num = trimmed.match(/(\d+)/)?.[1];
    if (num) {
      const n = parseInt(num);
      if (field.key === 'severity' && (n < 1 || n > 10)) {
        return { value: '', valid: false, hint: 'Please give a number between 1 and 10.' };
      }
      return { value: num, valid: true };
    }
    return { value: '', valid: false, hint: 'I need a number here. Could you try again?' };
  }
  // Free text
  if (!trimmed) {
    if (field.optional) return { value: '', valid: true };
    return { value: '', valid: false, hint: `Please provide a value for ${field.label}.` };
  }
  return { value: trimmed, valid: true };
};

// ─── MEDICAL TRIAGE KEYWORDS ──────────────────────────────────────────────────
const MEDICAL_KEYWORDS = [
  'allerg', 'rash', 'hive', 'itch', 'swell', 'anaphyla', 'epipen',
  'symptom', 'reaction', 'medication', 'antihistamine', 'inhaler',
  'throat', 'breathing', 'wheez', 'sting', 'bite', 'food', 'peanut',
  'dairy', 'gluten', 'pollen', 'asthma', 'diagnos', 'treatment',
  'doctor', 'hospital', 'pain', 'nausea', 'vomit', 'fever', 'skin',
  'immune', 'inflam', 'histamin', 'sensitiv', 'exposure', 'trigger',
  'throat', 'redness', 'bumps', 'hives', 'tingling', 'swelling',
];

const isMedicalQuery = (text: string): boolean => {
  const lower = text.toLowerCase();
  return MEDICAL_KEYWORDS.some(k => lower.includes(k));
};

// ─── SENTENCE SPLITTER ────────────────────────────────────────────────────────
// Splits a response into individual sentence strings for multi-bubble display.
// Respects abbreviations like Dr., Mr., e.g., i.e., etc.
const splitIntoSentences = (text: string): string[] => {
  // Clean first
  const cleaned = text
    .replace(/\r\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();

  // Split on sentence-ending punctuation followed by whitespace or newline
  const raw = cleaned.split(/(?<=[.!?])\s+(?=[A-Z\u0080-\uFFFF*•-]|\d)/);
  const sentences: string[] = [];

  for (const chunk of raw) {
    const trimmed = chunk.trim();
    if (trimmed.length === 0) continue;
    // Further split on newlines that introduce bullets or numbered lists
    const lines = trimmed.split(/\n+/);
    for (const line of lines) {
      const l = line.trim();
      if (l.length > 0) sentences.push(l);
    }
  }

  return sentences.length > 0 ? sentences : [cleaned];
};

// ─── UTILITIES ────────────────────────────────────────────────────────────────
function renderMarkdown(text: string): React.ReactNode {
  const lines = text.split('\n');
  return lines.map((line, lineIndex) => {
    const parts: React.ReactNode[] = [];
    const regex = /(\*\*(.+?)\*\*|\*(.+?)\*)/g;
    let lastIndex = 0;
    let match;
    while ((match = regex.exec(line)) !== null) {
      if (match.index > lastIndex) parts.push(line.slice(lastIndex, match.index));
      if (match[0].startsWith('**')) parts.push(<strong key={`${lineIndex}-${match.index}`}>{match[2]}</strong>);
      else parts.push(<em key={`${lineIndex}-${match.index}`}>{match[3]}</em>);
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < line.length) parts.push(line.slice(lastIndex));
    const isNumbered = /^\d+\.\s/.test(line);
    const isBullet = /^[•*-]\s/.test(line);
    return (
      <span key={lineIndex}>
        {isNumbered || isBullet
          ? <span style={{ display: 'block', paddingLeft: 10, marginBottom: 3 }}>{parts.length > 0 ? parts : line}</span>
          : <span style={{ display: 'block', marginBottom: line === '' ? 8 : 2 }}>{parts.length > 0 ? parts : line}</span>
        }
      </span>
    );
  });
}

const cleanModelOutput = (raw: string): string => {
  let text = raw.replace(/\[SYSTEM:[\s\S]*?\]\s*/gi, '');
  // Strip any leaked [INSTRUCTION:...] blocks that MedGemma may echo back
  text = text.replace(/\[INSTRUCTION:[\s\S]*?\]/gi, '');
  // Strip the injected --- separator block if MedGemma echoes it back
  text = text.replace(/\n*---\nIf your reply[\s\S]*?question\./gi, '');
  text = text.replace(/^user[\s\S]*?model\s*/i, '');
  text = text.replace(/<unused\d+>thought\s*/gi, '');
  text = text.replace(/Thinking Process:[\s\S]*?(?=\n\nEssentially|\n\nIn summary|\n\nSo,|\n\n[A-Z][a-z]|$)/i, '');
  text = text.replace(/<[^>]+>/g, '').replace(/^model\s*/i, '').replace(/\n{3,}/g, '\n\n');
  return text.trim() || 'I could not generate a response.';
};

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
// ── Smart Quick-Reply Extractor ───────────────────────────────────────
// Instead of instructing MedGemma to emit a structured token (unreliable),
// we detect a symptom-question pattern in whatever MedGemma naturally writes,
// then serve relevant options from the frontend.
interface AppShellProps {
  userId: string;
  userEmail?: string;
}

function AppShell({ userId, userEmail }: AppShellProps) {
  const { patients, activePatient, activeId, setActiveId, loading: patientsLoading, reload: reloadPatients } =
    useActivePatient();

  const [messages, setMessages] = useState<Message[]>([]);
  const [chatHistory, setChatHistory] = useState<HistoryTurn[]>([]);
  const [sessionContext, setSessionContext] = useState<SessionContext>(INITIAL_SESSION_CONTEXT);
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [currentPage, setCurrentPage] = useState<Page>('home');
  const [symptomLoggerTab, setSymptomLoggerTab] = useState<'Exposure' | 'Symptom' | 'Medication' | 'History'>('Exposure');
  const [exposureTestingSection, setExposureTestingSection] = useState<string | undefined>(undefined);

  // ── Chat thread being written to (created lazily on the first user message) ──
  // Mirrored in a ref because saves fire from staggered timeouts and from the
  // logging state machine, both of which would otherwise read a stale id and
  // start a second thread for the same conversation.
  // Held in a ref, not state: nothing renders the thread id, and it has to be
  // correct the instant the patient changes — a message typed straight after a
  // switch would otherwise be appended to the previous person's thread.
  const threadIdRef = useRef<string | null>(null);
  const setActiveThread = useCallback((id: string | null) => {
    threadIdRef.current = id;
  }, []);
  // Only ever read through the updater callback, to keep the stored count
  // correct when two turns are saved in quick succession.
  const [, setThreadMessageCount] = useState(0);
  const [hydratingChat, setHydratingChat] = useState(true);
  // Set when the household has more than one person and no history at all, so
  // Bea opens by asking who the conversation is about instead of assuming.
  const [awaitingSubjectChoice, setAwaitingSubjectChoice] = useState(false);
  const hasGreetedOnce = useRef(false);

  // ── Onboarding gate — new/incomplete profiles see the setup wizard first ──
  const [onboardingStatus, setOnboardingStatus] = useState<'checking' | 'needed' | 'done'>('checking');
  const [existingProfileId, setExistingProfileId] = useState<string | null>(null);

  // Other components (e.g. ProfilePage) read the signed-in user id off the DOM
  // rather than via props, so stamp it here instead of during render.
  useEffect(() => {
    document.body.dataset.userId = userId;
  }, [userId]);

  // ── Conversational Logging State ──
  const [loggingSession, setLoggingSession] = useState<LoggingSession | null>(null);

  // Voice Settings
  const [selectedVoice, setSelectedVoice] = useState<SpeechSynthesisVoice | null>(null);

  // Image Upload (kept for future MedGemma re-enable — see MEDGEMMA_ENABLED)
  const [pendingImage, setPendingImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [readingImage, setReadingImage] = useState(false);
  const chatImageInputRef = useRef<HTMLInputElement>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const srRef = useRef<{ stop: () => void } | null>(null);

  // ── Voice Init ──
  useEffect(() => {
    const loadVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      const preferred =
        voices.find(v => v.name === 'Google UK English Female') ||
        voices.find(v => v.lang === 'en-GB' && v.name.toLowerCase().includes('female')) ||
        voices.find(v => v.lang.startsWith('en-')) ||
        voices[0];
      setSelectedVoice(preferred ?? null);
    };
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
  }, []);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  // ── speakText ──────────────────────────────────────────────────────────────
  const speakText = useCallback((text: string) => {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.slice(0, 500));
    if (selectedVoice) u.voice = selectedVoice;
    u.rate = 0.92; u.pitch = 1.05;
    u.onstart = () => setIsSpeaking(true);
    u.onend = () => setIsSpeaking(false);
    window.speechSynthesis.speak(u);
  }, [selectedVoice]);

  const stopSpeaking = () => { window.speechSynthesis.cancel(); setIsSpeaking(false); };

  // ── Multi-bubble injector ──────────────────────────────────────────────────
  // Splits text into sentences and pushes each as a separate Message with a
  // staggered 350ms delay so the chat feels natural and alive.
  const injectBubbles = useCallback((
    text: string,
    source: Message['source'],
    speakFirst: boolean = false,
  ) => {
    const sentences = splitIntoSentences(text);
    sentences.forEach((sentence, i) => {
      setTimeout(() => {
        const msg: Message = {
          id: `${Date.now()}-${i}`,
          role: 'assistant',
          content: sentence,
          timestamp: new Date(),
          source,
        };
        setMessages(prev => [...prev, msg]);
        if (speakFirst && i === 0) speakText(sentence);
      }, i * 350);
    });
  }, [speakText]);

  // ── Onboarding status check — runs once per session ───────────────────────
  useEffect(() => {
    (async () => {
      try {
        const { data } = await client.models.UserProfile.list();
        const profile = data?.[0];
        if (profile) {
          setExistingProfileId(profile.id);
          setOnboardingStatus(profile.onboardingComplete ? 'done' : 'needed');
        } else {
          setOnboardingStatus('needed');
        }
      } catch (e) {
        console.warn('Failed to check onboarding status — letting the user into the app', e);
        setOnboardingStatus('done');
      }
    })();
  }, []);

  const handleOnboardingComplete = (landingPage?: Page) => {
    setOnboardingStatus('done');
    // Onboarding usually creates the first child — pick them up before the chat
    // hydrates, so the very first conversation is already about the right person.
    void reloadPatients();
    if (landingPage) setCurrentPage(landingPage);
  };

  // ── Greeting ───────────────────────────────────────────────────────────────
  // Spoken aloud only on the very first greeting of a session; a greeting that
  // talks at you every time you switch person would be intrusive.
  const greetFor = useCallback(async (patient: Patient | null, speak: boolean) => {
    const who = patient && !patient.isOwner ? patient.firstName : null;
    const fallback = who
      ? `Hi! How is ${who} doing today?`
      : "Hi! I'm Bea. How are you feeling?";
    try {
      const result = await client.queries.askNovaMicro({
        question: who
          ? `Greet the caregiver warmly and ask how ${who} is doing. Max 10 words.`
          : 'Greet the user warmly. Max 8 words.',
        history: '[]',
        context: composeContext(buildSubjectBlock(patient)),
      });
      const greetText = String(result.data ?? fallback).trim() || fallback;
      setMessages([{
        id: `greet-${Date.now()}`,
        role: 'assistant',
        content: greetText,
        timestamp: new Date(),
        source: 'nova',
      }]);
      if (speak) speakText(greetText);
    } catch (e) {
      console.warn('Nova Micro greeting failed', e);
      setMessages([{
        id: `greet-fallback-${Date.now()}`,
        role: 'assistant',
        content: fallback,
        timestamp: new Date(),
        source: 'nova',
      }]);
    }
  }, [speakText]);

  // ── Chat hydration — runs on load and whenever the tracked person changes ──
  //
  // Switching person is a full context swap, not a filter: the previous thread
  // stays saved as it was, and the incoming person's own thread, history and
  // session memory are loaded in its place.
  useEffect(() => {
    if (onboardingStatus !== 'done' || patientsLoading) return;

    let cancelled = false;
    (async () => {
      setHydratingChat(true);
      setActiveThread(null);
      setMessages([]);
      setChatHistory([]);
      setLoggingSession(null);
      setAwaitingSubjectChoice(false);
      setSessionContext(seedSessionContext(activePatient));

      const thread = await latestThread(activeId);
      if (cancelled) return;

      if (thread) {
        const stored = await loadMessages(thread.id);
        if (cancelled) return;
        setActiveThread(thread.id);
        setThreadMessageCount(stored.length);
        // Assistant replies were saved whole but are displayed as one bubble per
        // sentence, so re-split them to match how they first appeared.
        setMessages(stored.flatMap<Message>(m => (
          m.role === 'assistant'
            ? splitIntoSentences(m.content).map((sentence, i) => ({
                id: `${m.id}-${i}`,
                role: 'assistant',
                content: sentence,
                timestamp: new Date(m.sentAt),
                source: 'nova',
              }))
            : [{ id: m.id, role: 'user', content: m.content, timestamp: new Date(m.sentAt) }]
        )));
        setChatHistory(stored.slice(-20).map(m => ({ role: m.role, content: m.content })));
        hasGreetedOnce.current = true;
      } else {
        setActiveThread(null);
        setThreadMessageCount(0);

        // First run in a household with more than one person: ask rather than
        // guess. Logging a reaction against the wrong child is expensive to undo.
        const noHistoryAnywhere = !hasGreetedOnce.current
          && patients.length > 1
          && (await listAllThreads()).length === 0;
        if (cancelled) return;

        if (noHistoryAnywhere) {
          hasGreetedOnce.current = true;
          setAwaitingSubjectChoice(true);
          setMessages([{
            id: 'subject-prompt',
            role: 'assistant',
            content: "Hi! I'm Bea. Who are we talking about today?",
            timestamp: new Date(),
            source: 'nova',
          }]);
        } else {
          await greetFor(activePatient, !hasGreetedOnce.current);
          hasGreetedOnce.current = true;
        }
      }

      if (!cancelled) setHydratingChat(false);
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, onboardingStatus, patientsLoading]);

  // ── DynamoDB Event Logger (non-blocking) ──────────────────────────────────
  const logEvent = useCallback(async (
    userId: string,
    type: 'user_query' | 'medical_response' | 'nova_reply' | 'image_analysis',
    payload: Record<string, unknown>,
  ) => {
    try {
      const event = JSON.stringify({ type, ts: new Date().toISOString(), ...payload });
      await client.queries.logConversationEvent({ userId, event });
    } catch (e) {
      console.warn('logEvent failed (non-blocking)', e);
    }
  }, []);

  // ── Voice Handlers ──
  const startRecording = () => {
    type SREvent = { results: { [k: number]: { [k: number]: { transcript: string } } } };
    type SRConstructor = new () => {
      lang: string; continuous: boolean; interimResults: boolean;
      start(): void; stop(): void;
      onresult: ((e: SREvent) => void) | null;
      onend: (() => void) | null;
    };
    const win = window as Window & { SpeechRecognition?: SRConstructor; webkitSpeechRecognition?: SRConstructor };
    const SR = win.SpeechRecognition || win.webkitSpeechRecognition;
    if (!SR) return alert('Voice input not supported. Please use Chrome.');
    const rec = new SR();
    rec.lang = 'en-US'; rec.continuous = false; rec.interimResults = false;
    rec.onresult = (e) => setInputText(prev => prev ? prev + ' ' + e.results[0][0].transcript : e.results[0][0].transcript);
    rec.onend = () => setIsRecording(false);
    rec.start(); srRef.current = rec; setIsRecording(true);
  };
  const stopRecording = () => { srRef.current?.stop(); setIsRecording(false); };

  // ── Image handlers ──
  // Nova Micro is text-only, so a photo reaches it as the text Textract reads
  // off it — which is exactly what an ingredients label is.
  const clearImage = () => { setPendingImage(null); setImagePreview(null); };

  const attachImage = (file: File) => {
    setPendingImage(file);
    const reader = new FileReader();
    reader.onload = e => setImagePreview(e.target?.result as string);
    reader.readAsDataURL(file);
  };

  // ── SESSION CONTEXT UPDATER ───────────────────────────────────────────────────
  // Called after every exchange to keep the live session memory up to date.
  const updateSessionContext = (userText: string, assistantText: string) => {
    const userEntities = extractEntities(userText);
    const assistantEntities = extractEntities(assistantText);
    setSessionContext(prev => {
      const next = { ...prev, turnCount: prev.turnCount + 1 };
      // Merge new allergies (deduplicated)
      if (userEntities.allergies.length > 0)
        next.knownAllergies = [...new Set([...prev.knownAllergies, ...userEntities.allergies])];
      // Merge new symptoms
      const newSymptoms = [...userEntities.symptoms, ...assistantEntities.symptoms];
      if (newSymptoms.length > 0)
        next.currentSymptoms = [...new Set([...prev.currentSymptoms, ...newSymptoms])].slice(-8);
      // Track last medication mentioned
      const meds = [...userEntities.medications, ...assistantEntities.medications];
      if (meds.length > 0) next.lastMentionedMedication = meds[meds.length - 1];
      // Derive current topic from user's message (first 60 chars as topic hint)
      const topicHint = userText.trim().slice(0, 60);
      if (topicHint.length > 10) next.currentTopic = topicHint;
      // Urgency escalation — never de-escalate within a session
      if (userEntities.isEmergency) next.urgencyLevel = 'emergency';
      else if (userEntities.isElevated && prev.urgencyLevel === 'normal') next.urgencyLevel = 'elevated';
      return next;
    });
  };

  // ── Thread persistence ────────────────────────────────────────────────────
  /**
   * Ensure a thread exists for the current person and record a turn in it.
   * Reads the live thread id from a ref rather than state, so turns saved from
   * a staggered timeout or the logging state machine land in the same thread
   * instead of racing a second one into existence.
   */
  const persistTurn = async (role: 'user' | 'assistant', content: string): Promise<void> => {
    let id = threadIdRef.current;
    if (!id) {
      // Only a user turn is worth opening a thread for — a greeting nobody
      // replied to should not show up in the profile history.
      if (role !== 'user') return;
      const created = await createThread(activeId, deriveTitle(content));
      if (!created) return;   // save failed; the conversation still works
      id = created.id;
      setActiveThread(id);
    }
    const target = id;
    await appendMessage(target, activeId, role, content);
    setThreadMessageCount(prev => {
      const next = prev + 1;
      void touchThread(target, next);
      return next;
    });
  };

  /** Say one of Bea's lines and record it, so the saved transcript reads as a conversation. */
  const sayAndSave = (text: string) => {
    injectBubbles(text, 'nova', false);
    void persistTurn('assistant', text);
  };

  // ── CONVERSATIONAL LOGGING HELPERS ────────────────────────────────────────────
  const askLoggingQuestion = async (entryType: LoggingEntryType, field: FieldDef) => {
    try {
      const forWhom = activePatient && !activePatient.isOwner
        ? ` on behalf of ${activePatient.name}, who is not the person you are talking to`
        : '';
      const prompt = `You are helping the user log a ${entryType}${forWhom}. ${fillQuestion(field.question, activePatient)} Keep it friendly and conversational. Do NOT add any prefix like "Sure!" — just ask the question directly.`;
      const result = await client.queries.askNovaMicro({
        question: prompt,
        history: JSON.stringify(chatHistory.slice(-4)),
        context: composeContext(buildSubjectBlock(activePatient), buildContextSummary(sessionContext)),
      });
      const questionText = String(result.data ?? field.question).trim();
      sayAndSave(questionText);
      setChatHistory(prev => [...prev, { role: 'assistant', content: questionText }].slice(-20) as HistoryTurn[]);
    } catch {
      // Fallback: use the raw question text
      const fallback = `What is the ${field.label.toLowerCase()}?`;
      sayAndSave(fallback);
    }
  };

  const startLoggingSession = async (entryType: LoggingEntryType) => {
    const session: LoggingSession = { entryType, currentFieldIndex: 0, collectedData: {} };
    setLoggingSession(session);
    // Announce — naming the person makes a mis-set switcher obvious before the
    // entry is written rather than after it lands in the wrong record.
    const forWhom = activePatient && !activePatient.isOwner ? ` for ${activePatient.firstName}` : '';
    const announcement = `Sure! Let's log a ${entryType.toLowerCase()}${forWhom}. I'll ask you a few questions.`;
    sayAndSave(announcement);
    // Ask first question after a short delay
    const fields = FIELD_SCRIPTS[entryType];
    setTimeout(() => void askLoggingQuestion(entryType, fields[0]), 800);
  };

  const cancelLoggingSession = () => {
    setLoggingSession(null);
    sayAndSave('Logging cancelled. Feel free to chat normally!');
  };

  const submitLoggedEntry = async (session: LoggingSession) => {
    const { entryType, collectedData } = session;
    const now = toLocalDatetimeInputValue(new Date());
    try {
      const basePayload: Record<string, unknown> = {
        type: entryType,
        time: now,
        // Without this every entry logged through chat was attributed to the
        // account owner, regardless of who the conversation was about.
        familyMemberId: activeId ?? null,
      };

      if (entryType === 'Symptom') {
        basePayload.name = collectedData.name || 'Unknown';
        basePayload.severity = collectedData.severity ? parseInt(collectedData.severity) : undefined;
        basePayload.bodyArea = collectedData.bodyArea || undefined;
        basePayload.notes = collectedData.notes || undefined;
      } else if (entryType === 'Exposure') {
        basePayload.subtype = collectedData.subtype || undefined;
        basePayload.name = collectedData.name || 'Unknown';
        basePayload.tags = collectedData.tags ? JSON.stringify(collectedData.tags.split(',').map((t: string) => t.trim()).filter(Boolean)) : undefined;
        basePayload.details = collectedData.details || undefined;
      } else if (entryType === 'Medication') {
        basePayload.name = collectedData.name || 'Unknown';
        basePayload.dose = collectedData.dose || undefined;
        basePayload.unit = collectedData.unit || undefined;
        basePayload.route = collectedData.route || undefined;
        basePayload.reason = collectedData.reason || undefined;
        basePayload.notes = collectedData.notes || undefined;
      }

      await client.models.HealthEntry.create(basePayload as Parameters<typeof client.models.HealthEntry.create>[0]);

      setLoggingSession(null);
      const summary = entryType === 'Symptom'
        ? `${collectedData.name} (severity ${collectedData.severity || '?'}/10)`
        : entryType === 'Exposure'
        ? `${collectedData.subtype || ''} — ${collectedData.name}`
        : `${collectedData.name} ${collectedData.dose || ''}${collectedData.unit || ''}`;
      const forWhom = activePatient && !activePatient.isOwner ? ` for ${activePatient.firstName}` : '';
      sayAndSave(`${entryType} logged successfully${forWhom}!\n${summary}\nYou can view it in the Health Logger page.`);
    } catch (e) {
      console.error('Failed to save logged entry:', e);
      setLoggingSession(null);
      sayAndSave('Sorry, I couldn\'t save that entry. Please try logging it manually in the Health Logger.');
    }
  };

  const handleLoggingAnswer = async (userText: string) => {
    if (!loggingSession) return;
    const { entryType, currentFieldIndex, collectedData } = loggingSession;
    const fields = FIELD_SCRIPTS[entryType];
    const currentField = fields[currentFieldIndex];

    const parsed = parseFieldAnswer(userText, currentField);

    // Cancel
    if (parsed.value === '__CANCEL__') {
      cancelLoggingSession();
      return;
    }

    // Invalid answer — re-ask
    if (!parsed.valid) {
      sayAndSave(parsed.hint || `Could you try that again?`);
      return;
    }

    // Store the answer
    const updatedData = { ...collectedData, [currentField.key]: parsed.value };
    const nextIndex = currentFieldIndex + 1;

    if (nextIndex >= fields.length) {
      // All fields collected — submit
      const finalSession: LoggingSession = { entryType, currentFieldIndex: nextIndex, collectedData: updatedData };
      setLoggingSession(finalSession);
      await submitLoggedEntry(finalSession);
    } else {
      // Move to next field
      const nextSession: LoggingSession = { entryType, currentFieldIndex: nextIndex, collectedData: updatedData };
      setLoggingSession(nextSession);
      setTimeout(() => void askLoggingQuestion(entryType, fields[nextIndex]), 500);
    }
  };

  // ── THE AGENTIC ROUTER ──────────────────────────────────────────────────────
  //
  //  Image        → MedGemma vision     (Colab /analyse-image — disabled)
  //  Medical text → MedGemma /agent/ask (Colab — disabled)
  //  All text     → Nova Micro          (AWS Bedrock)
  //
  //  Every response is sentence-split into separate chat bubbles.
  //  All interactions are logged to DynamoDB via logConversationEvent.

  const sendMessage = async () => sendMessageWithText(inputText);

  const sendMessageWithText = async (overrideText?: string) => {
    const rawText = overrideText ?? inputText;
    const hasText = rawText.trim().length > 0;
    const hasImage = pendingImage !== null;
    if ((!hasText && !hasImage) || loading) return;

    const userContent = hasText ? rawText.trim() : 'What do you see in this image?';
    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: userContent,
      timestamp: new Date(),
      imagePreview: imagePreview ?? undefined,
    };

    setMessages(prev => [...prev, userMsg]);
    setInputText('');
    setLoading(true);
    const capturedImage = pendingImage;
    clearImage();

    // ── FIX: Add user turn to history BEFORE calling API ────────────────────
    // This ensures the current message is visible in the history sent to Nova,
    // preventing the "forgets what I just said" bug.
    const updatedHistory: HistoryTurn[] = [
      ...chatHistory,
      { role: 'user' as const, content: userContent },
    ].slice(-20);
    setChatHistory(updatedHistory);

    // Persist the user's turn before anything can fail downstream, so a dropped
    // reply still leaves a record of what was reported.
    await persistTurn('user', userContent);

    // ── CONVERSATIONAL LOGGING INTERCEPT ────────────────────────────────────
    // If a logging session is active, route the answer to the state machine
    if (loggingSession && !capturedImage) {
      setLoading(false);
      await handleLoggingAnswer(userContent);
      return;
    }

    // Check if the user wants to START a new logging session
    if (!capturedImage) {
      const intent = detectLoggingIntent(userContent);
      if (intent) {
        setLoading(false);
        await startLoggingSession(intent);
        return;
      }
    }

    // History snapshot already includes the current user turn (fixed above)
    const historySnapshot = updatedHistory.slice(-10);
    const contextSummary = buildContextSummary(sessionContext);

    // A photo is answered from the text Textract reads off it. Nova Micro
    // cannot see, so sending the image alone produced a confident reply about
    // a label it had never read — worse than saying the photo was unreadable.
    let labelText = '';
    if (capturedImage && !MEDGEMMA_ENABLED) {
      setReadingImage(true);
      try {
        labelText = await extractTextFromFiles([capturedImage]);
      } catch (err) {
        console.warn('Chat label OCR failed:', err);
      } finally {
        setReadingImage(false);
      }
    }

    // Saying so is the honest answer; passing the photo through unread would
    // have Bea answer about a label nobody has read.
    if (capturedImage && !MEDGEMMA_ENABLED && !labelText) {
      setLoading(false);
      const miss = "I couldn't read any text in that photo. I read labels rather than see pictures — try a straight, well-lit shot of the ingredients list.";
      injectBubbles(miss, 'nova', true);
      void persistTurn('assistant', miss);
      return;
    }

    // The subject block leads the context: it decides who "you" refers to, and
    // every fact after it is read in that frame.
    const novaContext = composeContext(
      buildSubjectBlock(activePatient),
      contextSummary,
      labelText ? `Text read from the photo the user just sent:\n${labelText}` : '',
    );

    try {
      let responseText = '';
      let source: Message['source'] = 'nova';

      // ── RULE 1: Image → Nova Micro (MedGemma vision disabled) ───────────
      if (capturedImage && MEDGEMMA_ENABLED) {
        // MedGemma image analysis — disabled until COLAB_BASE_URL is live
        const b64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = e => resolve((e.target?.result as string).split(',')[1]);
          reader.onerror = reject;
          reader.readAsDataURL(capturedImage);
        });
        const res = await fetch(IMAGE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image_b64: b64, question: userContent }),
        });
        const data = await res.json() as { response?: string; error?: string };
        responseText = res.ok
          ? cleanModelOutput(data.response ?? '')
          : `Image Error: ${data.error ?? 'Unknown'}`;
        void logEvent(userId, 'image_analysis', { question: userContent, response_preview: responseText.slice(0, 120) });
      }

      // ── RULE 2: All text → Nova Micro (MedGemma disabled) ────────────────
      else if (MEDGEMMA_ENABLED && !capturedImage && isMedicalQuery(userContent)) {
        // Reserved: MedGemma medical routing — re-enable by setting MEDGEMMA_ENABLED = true
        const medGemmaQuestion = novaContext ? `[Context: ${novaContext}]\n\n${userContent}` : userContent;
        const res = await fetch(AGENT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: medGemmaQuestion, history: historySnapshot.slice(-10), biometrics: null }),
        });
        if (res.ok) {
          const data = await res.json() as { response?: string; error?: string };
          responseText = cleanModelOutput(data.response ?? '');
        } else {
          responseText = 'Connection Error: Is Colab running?';
        }
      }

      // ── RULE 3: Nova Micro — all queries ─────────────────────────────────
      else {
        source = 'nova';

        const result = await client.queries.askNovaMicro({
          question: userContent,
          history: JSON.stringify(historySnapshot),
          context: novaContext,
        });
        responseText = cleanModelOutput(String(result.data ?? '').trim())
          || "I'm here! Could you tell me a little more about that?";

        void logEvent(userId, 'nova_reply', {
          question: userContent,
          response: responseText,
        });
      }

      // ── Inject multi-bubble response ────────────────────────────────────
      // Each sentence becomes its own chat bubble with a 350ms stagger
      injectBubbles(responseText, source, true);

      // Saved whole rather than per-bubble so the history sent to Nova on the
      // next load is the same shape it was during the live conversation.
      void persistTurn('assistant', responseText);

      // ── Update rolling chat history with assistant reply ─────────────────
      // Note: user turn was already added before the API call (timing fix).
      setChatHistory(prev => [
        ...prev,
        { role: 'assistant', content: responseText },
      ].slice(-20) as HistoryTurn[]);

      // ── Update session context with entities from this exchange ──────────
      updateSessionContext(userContent, responseText);

    } catch (err: unknown) {
      console.error('sendMessage error:', err);
      setMessages(prev => [...prev, {
        id: Date.now().toString(),
        role: 'assistant',
        content: `Network Error: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: new Date(),
      }]);
    } finally {
      setLoading(false);
    }
  };

  const navigateTo = (page: Page, tab?: string) => {
    if (page === 'symptom-logger') setSymptomLoggerTab((tab as typeof symptomLoggerTab) ?? 'Exposure');
    if (page === 'exposure-testing') setExposureTestingSection(tab);
    setCurrentPage(page);
  };

  // Answering the opening "who are we talking about?" question. Picking someone
  // else hands off to the hydration effect; picking whoever is already active
  // would not change `activeId`, so greet here instead.
  const chooseSubject = (p: Patient) => {
    setAwaitingSubjectChoice(false);
    if (p.id === activeId) void greetFor(p, false);
    else setActiveId(p.id);
  };

  // ── Chat UI ────────────────────────────────────────────────────────────────
  const renderChat = () => (
    <>
      {/* ── Bea chat header ── */}
      <div className="chat-top-bar">
        <button className="chat-back-btn" onClick={() => navigateTo('home')}>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
        </button>
        <h1 className="chat-top-title">Bea</h1>
        <PatientSwitcher onManageFamily={() => navigateTo('profile')} />
      </div>

      <div className="chat-messages">
        {messages.length === 0 && !hydratingChat ? (
          <div className="empty-chat">
            <img src={beaImg} alt="Bea" className="bot-logo-large" />
            <h2>Immuny</h2>
            <p className="tagline">ALLERGY AI ALLY</p>
            <div className="quick-actions">
              <button onClick={() => setInputText('Any allergy symptoms to check on?')}><ThermometerIcon /> Check allergies</button>
              <button onClick={() => setInputText('Is it safe to eat strawberries with my allergy?')}><UtensilsIcon /> Food allergies</button>
              <button onClick={() => setInputText('What should I do during an allergic reaction?')}><MedicalCrossIcon /> Reaction guide</button>
            </div>
          </div>
        ) : (
          messages.map((msg, i) => {
            // One avatar per run of consecutive messages from the same speaker,
            // anchored to the last bubble in the run so it sits beside the end
            // of what Bea just said. While the typing bubble is up it owns the
            // avatar, so the message above it gives it up.
            const next = messages[i + 1];
            const endsRun = !next
              ? !loading
              : next.role !== msg.role;
            return (
            <div key={msg.id} className={`message-bubble ${msg.role}`}>
              {msg.role === 'assistant' && (
                endsRun
                  ? <img src={beaImg} alt="Bea" className="message-avatar" />
                  : <span className="message-avatar-spacer" aria-hidden="true" />
              )}
              <div className="message-content">
                {msg.imagePreview && (
                  <img src={msg.imagePreview} alt="Uploaded"
                    style={{ maxWidth: '100%', maxHeight: 200, borderRadius: 8, marginBottom: 6, display: 'block' }} />
                )}
                <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{renderMarkdown(msg.content)}</div>
                <span className="message-time">{msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            </div>
            );
          })
        )}
        {/* First run with more than one person on the account: choosing here is
            faster than opening the switcher, and makes the subject explicit
            before anything is logged against it. */}
        {awaitingSubjectChoice && (
          <div className="subject-choice">
            {patients.map(p => (
              <button
                key={p.id ?? 'owner'}
                type="button"
                className="subject-choice-chip"
                onClick={() => chooseSubject(p)}
              >
                <PatientAvatar avatarKey={p.avatarKey} seed={patientSeed(p)} size={30} />
                <span>{p.isOwner ? 'Me' : p.firstName}</span>
              </button>
            ))}
          </div>
        )}
        {loading && (
          <div className="message-bubble assistant">
            <img src={beaImg} alt="Bea" className="message-avatar" />
            <div className="message-content typing"><span /><span /><span /></div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-container">
        {/* ── Logging Session Banner ──────────────────────────────── */}
        {loggingSession && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '8px 14px', marginBottom: 6, borderRadius: 8,
            background: 'linear-gradient(135deg, #D1E7F4, #E8F5E9)',
            border: '1px solid #4A7BA7', fontSize: 13, fontWeight: 600, color: '#2E5A7E',
          }}>
            <span>
              <ClipboardIcon /> Logging {loggingSession.entryType}
              {' '}
              ({Math.min(loggingSession.currentFieldIndex + 1, FIELD_SCRIPTS[loggingSession.entryType].length)}/{FIELD_SCRIPTS[loggingSession.entryType].length})
            </span>
            <button onClick={cancelLoggingSession} style={{
              background: '#DC2626', color: '#fff', border: 'none', borderRadius: 6,
              padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
            }}>Cancel</button>
          </div>
        )}
        {isSpeaking && (
          <div className="speaking-banner">
            <span><VolumeIcon /> Speaking ({selectedVoice?.name || 'Default Voice'})…</span>
            <button onClick={stopSpeaking}>Stop</button>
          </div>
        )}
        {imagePreview && (
          <div className="chat-attachment">
            <img src={imagePreview} alt="Attached" className="chat-attachment-thumb" />
            <span className="chat-attachment-note">
              {readingImage ? 'Reading the label…' : 'Bea will read the text in this photo'}
            </span>
            <button className="chat-attachment-remove" onClick={clearImage} aria-label="Remove photo">
              <CloseIcon />
            </button>
          </div>
        )}
        <div className="input-bar">
          <input
            ref={chatImageInputRef}
            type="file"
            accept="image/*"
            onChange={e => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) attachImage(file);
            }}
            style={{ display: 'none' }}
          />
          <button
            className="chat-attach-btn"
            onClick={() => chatImageInputRef.current?.click()}
            title="Attach a photo"
            aria-label="Attach a photo"
          >
            <CameraIcon />
          </button>

          <div className="chat-input-pill">
            <input
              type="text"
              value={inputText}
              onChange={e => setInputText(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && void sendMessage()}
              placeholder={isRecording ? 'Listening…' : 'How else can I help'}
              className="message-input"
            />
            <button
              onClick={isRecording ? stopRecording : startRecording}
              className={`chat-mic-btn ${isRecording ? 'recording' : ''}`}
              title={isRecording ? 'Stop' : 'Voice input'}
              aria-label={isRecording ? 'Stop recording' : 'Voice input'}
            >
              {isRecording ? <StopIcon /> : <MicIcon />}
            </button>
          </div>

          <button
            onClick={() => void sendMessage()}
            disabled={(!inputText.trim() && !pendingImage) || loading}
            className="chat-send-btn"
            aria-label="Send"
          >
            <ArrowUpIcon />
          </button>
        </div>
        <p className="chat-disclaimer">
          Immuny helps track experiences and patterns and does not provide medical advice.
        </p>
      </div>
    </>
  );

  const renderContent = (userId: string, userEmail?: string) => {
    switch (currentPage) {
      case 'home':            return <HomePage onNavigate={navigateTo} userName={userEmail} />;
      case 'voice':           return <VoicePage onNavigate={navigateTo} />;
      case 'insights':        return <InsightsPage onNavigate={navigateTo} />;
      case 'community':       return <CommunityPage currentUserId={userId} />;
      case 'profile':         return <ProfilePage />;
      case 'symptom-logger':  return <SymptomLoggerPage initialTab={symptomLoggerTab} onNavigate={navigateTo} />;
      case 'exposure-testing': return <ExposureTestingPage initialSection={exposureTestingSection} />;
      case 'resource-hub':     return <ResourceHubPage onNavigate={navigateTo} />;
      case 'medications':      return <MedicationsPage onNavigate={navigateTo} />;
      case 'food-tracker':     return <FoodTrackerPage onNavigate={navigateTo} />;
      case 'chat':            return renderChat();
      default:                return <HomePage onNavigate={navigateTo} />;
    }
  };

  // ── Onboarding gate ────────────────────────────────────────────────────────
  if (onboardingStatus === 'checking') {
    return (
      <div className="app-container">
        <div className="onboarding-loading">
          <img src={beaImg} alt="Bea" className="onboarding-loading-bea" />
        </div>
      </div>
    );
  }

  if (onboardingStatus === 'needed') {
    return (
      <div className="app-container">
        <OnboardingPage existingProfileId={existingProfileId} onComplete={handleOnboardingComplete} />
      </div>
    );
  }

  return (
    <div className="app-container">
      <div className="main-content">
        <div key={currentPage} className="page-fade">
          {renderContent(userId, userEmail)}
        </div>
      </div>
      <BottomNav current={currentPage} onNavigate={navigateTo} />
    </div>
  );
}

export default function App() {
  return (
    <Authenticator>
      {({ user }) => {
        const userId = user?.userId ?? 'anonymous';
        const userEmail = user?.signInDetails?.loginId;
        return (
          <ActivePatientProvider>
            <AppShell userId={userId} userEmail={userEmail} />
          </ActivePatientProvider>
        );
      }}
    </Authenticator>
  );
}