import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '../../amplify/data/resource';
import type { Page } from '../types';
import beaImg from '../assets/bea.png';
import { toLocalDatetimeInputValue } from '../utils/formatTime';
import { cancelSpeech, primeVoices, speak } from '../utils/speech';
import { phraseQuestion } from '../utils/beaVoice';
import { useActivePatient } from '../contexts/useActivePatient';
import PatientSwitcher from './PatientSwitcher';
import {
  applyAnswer,
  personRefFor,
  COFACTOR_OPTIONS,
  draftToPayload,
  isSignificantEpisode,
  localExtract,
  needsBodyArea,
  nextSlot,
  openingSeverity,
  parseOnset,
  parseSeverity,
  remainingCount,
  stashUnparsed,
  toFiveScale,
  type EmergencyCare,
  type EntryDraft,
  type EntryType,
  type Slot,
  type SlotKey,
} from '../utils/voiceInterview';

const EMERGENCY_LABELS: Record<EmergencyCare, string> = {
  'none': 'None',
  'urgent-care': 'Urgent care',
  'emergency-room': 'Emergency room',
  'ambulance': 'Ambulance',
};

const client = generateClient<Schema>();

const GROQ_API_KEY = (import.meta.env.VITE_GROQ_API_KEY as string | undefined) ?? '';

// ── Listening thresholds ─────────────────────────────────────────────────────
// The mic closes itself once you stop talking, so a five-question interview
// doesn't need ten taps. Tapping the mic always stops it early.
const SPEECH_RMS = 0.045;    // above this counts as speech, not room noise
const SILENCE_MS = 1600;     // hang up this long after the last speech
const MIN_LISTEN_MS = 1200;  // never close before this, even on a quiet answer
const MAX_LISTEN_MS = 20_000;
const NO_SPEECH_MS = 7000;   // nothing heard at all → re-prompt without a round trip

/** Two failed parses of the same question and we keep the raw words instead. */
const MAX_RETRIES = 2;

/**
 * Attempts that produce nothing usable — silence, an unusably short clip, an
 * empty transcript — before Bea stops reopening the mic by herself and waits
 * to be tapped. Without a ceiling, a muted or blocked mic puts the interview in
 * a loop: re-ask, listen, hear nothing, re-ask, forever.
 */
const MAX_NO_ANSWER = 2;

type Phase =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  // Bea asked, heard nothing usable twice, and has handed control back. The
  // draft and the current question are still held, so tapping the mic picks up
  // exactly where it left off rather than starting over.
  | 'paused'
  | 'review'
  | 'saving'
  | 'done'
  | 'error';

interface Turn {
  role: 'bea' | 'you';
  text: string;
}

interface VoicePageProps {
  onNavigate: (page: Page) => void;
}

const OPENING_QUESTION = 'What would you like to log?';

const EXAMPLE_PROMPTS = [
  '"I have a rash on my arm"',
  '"I just ate a peanut butter sandwich"',
  '"I took 25mg of Benadryl for my rash"',
];

function getSupportedMimeType(): string {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const t of types) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

async function transcribeWithGroq(blob: Blob, mimeType: string): Promise<string> {
  if (!GROQ_API_KEY) throw new Error('Groq API key not configured. Add VITE_GROQ_API_KEY to .env.local');
  const ext = mimeType.includes('mp4') ? 'm4a' : mimeType.includes('ogg') ? 'ogg' : 'webm';
  const form = new FormData();
  form.append('file', blob, `recording.${ext}`);
  form.append('model', 'whisper-large-v3-turbo');
  form.append('language', 'en');
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: form,
  });
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Groq transcription failed (${res.status}): ${err}`);
  }
  const data = await res.json() as { text?: string };
  return (data.text ?? '').trim();
}

// ─── Opening-sentence understanding ──────────────────────────────────────────
// Only the FIRST sentence goes to the model, and only to work out what kind of
// entry this is and what it's called. Everything it returns is re-validated
// with the same deterministic parsers used for the spoken answers.

const EXTRACT_INSTRUCTION =
  'Extract one health log entry from the transcript. ' +
  'Reply with exactly this JSON shape and nothing else: ' +
  '{"type":"Symptom|Exposure|Medication","name":"short label","bodyArea":"string or null",' +
  '"severityPhrase":"the words describing how bad it is, or null",' +
  '"onsetPhrase":"the words describing when it started, or null",' +
  '"notes":"string or null"}. ' +
  'name must be 1-4 words (e.g. "Rash", "Peanut butter sandwich", "Benadryl"). ' +
  'Use null for anything the user did not say.';

interface RawExtraction {
  type?: string;
  name?: string;
  bodyArea?: string | null;
  severityPhrase?: string | null;
  onsetPhrase?: string | null;
  notes?: string | null;
}

function parseJsonObject(raw: string): RawExtraction | null {
  const cleaned = raw.replace(/```json\n?|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as RawExtraction;
  } catch {
    return null;
  }
}

async function understandOpening(transcript: string): Promise<EntryDraft> {
  let raw = '';
  try {
    const result = await client.queries.askNovaMicro({
      question: EXTRACT_INSTRUCTION,
      context: `Transcript: "${transcript}"`,
      history: '[]',
      mode: 'extract',
    });
    raw = String(result.data ?? '');
  } catch {
    // The `mode` argument ships with this change; if the backend hasn't caught
    // up yet, fall back to the call shape it already knows.
    try {
      const legacy = await client.queries.askNovaMicro({
        question: EXTRACT_INSTRUCTION,
        context: `Transcript: "${transcript}"`,
        history: '[]',
      });
      raw = String(legacy.data ?? '');
    } catch {
      raw = '';
    }
  }

  const parsed = parseJsonObject(raw);
  const fallback = localExtract(transcript);

  const type: EntryType =
    parsed?.type === 'Symptom' || parsed?.type === 'Exposure' || parsed?.type === 'Medication'
      ? parsed.type
      : fallback.type;

  const name = (parsed?.name ?? '').trim() || fallback.name;
  const draft: EntryDraft = { type, name: name.slice(0, 60) };

  if (parsed?.bodyArea && type === 'Symptom' && needsBodyArea(name)) {
    draft.bodyArea = parsed.bodyArea.trim().slice(0, 40);
  }

  // Severity/onset are re-parsed here rather than trusted as numbers from the
  // model — this is where the old flow silently lost the severity.
  const severity = parsed?.severityPhrase
    ? parseSeverity(parsed.severityPhrase)
    : openingSeverity(transcript);
  if (severity != null) draft.severity = severity;

  const startedAt = parseOnset(parsed?.onsetPhrase ?? '') ?? parseOnset(transcript);
  if (startedAt) draft.startedAt = startedAt;

  if (parsed?.notes && parsed.notes.trim()) draft.notes = parsed.notes.trim().slice(0, 500);

  return draft;
}

// ─── UI bits ─────────────────────────────────────────────────────────────────
function WaveAnimation({ level }: { level: number }) {
  // Bars track the mic input so it's obvious Bea is actually hearing you.
  const scales = [0.45, 0.75, 1, 0.75, 0.45];
  return (
    <div className="voice-wave" aria-hidden="true">
      {scales.map((weight, i) => (
        <div
          key={i}
          className={`voice-wave-bar voice-wave-bar--${i} voice-wave-bar--live`}
          style={{ transform: `scaleY(${Math.max(0.25, Math.min(1, 0.25 + level * 9 * weight))})` }}
        />
      ))}
    </div>
  );
}

function Spinner() {
  return <div className="voice-spinner" aria-label="Loading" />;
}

export default function VoicePage({ onNavigate }: VoicePageProps) {
  // Who the entry is about. Read from context rather than localStorage so a
  // switch made while the interview is open takes effect immediately.
  const { activePatient, activeId } = useActivePatient();
  const person = useMemo(() => personRefFor(activePatient), [activePatient]);
  const personRef = useRef(person);
  useEffect(() => { personRef.current = person; }, [person]);

  const contentEndRef = useRef<HTMLDivElement>(null);

  const [phase, setPhase] = useState<Phase>('idle');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState<EntryDraft | null>(null);
  const [activeSlot, setActiveSlot] = useState<Slot | null>(null);
  const [level, setLevel] = useState(0);
  const [muted, setMuted] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [savedSummary, setSavedSummary] = useState<string[]>([]);

  // Async callbacks (recorder/TTS) read the live values through refs.
  const draftRef = useRef<EntryDraft | null>(null);
  const slotRef = useRef<Slot | null>(null);
  const askedRef = useRef<SlotKey[]>([]);
  const retriesRef = useRef(0);
  const mutedRef = useRef(false);
  const abortedRef = useRef(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeTypeRef = useRef('');
  const audioCtxRef = useRef<AudioContext | null>(null);
  const meterTimerRef = useRef<number | null>(null);
  const hardStopRef = useRef<number | null>(null);
  const heardSpeechRef = useRef(false);
  const noAnswerRef = useRef(0);

  useEffect(() => { mutedRef.current = muted; }, [muted]);
  useEffect(() => { primeVoices(); }, []);

  // Follow the conversation down as Bea asks and the review card appears.
  useEffect(() => {
    contentEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns, phase, savedSummary]);

  const pushTurn = useCallback((role: Turn['role'], text: string) => {
    setTurns(prev => [...prev, { role, text }].slice(-8));
  }, []);

  // ── Mic teardown ───────────────────────────────────────────────────────────
  const teardownMeter = useCallback(() => {
    if (meterTimerRef.current != null) {
      window.clearInterval(meterTimerRef.current);
      meterTimerRef.current = null;
    }
    if (hardStopRef.current != null) {
      window.clearTimeout(hardStopRef.current);
      hardStopRef.current = null;
    }
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    setLevel(0);
  }, []);

  const releaseMic = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  }, []);

  const stopListening = useCallback(() => {
    const rec = recorderRef.current;
    teardownMeter();
    if (rec && rec.state !== 'inactive') rec.stop();   // onstop drives the next step
    releaseMic();
  }, [releaseMic, teardownMeter]);

  useEffect(() => {
    return () => {
      abortedRef.current = true;
      cancelSpeech();
      const rec = recorderRef.current;
      if (rec && rec.state !== 'inactive') {
        rec.onstop = null;
        rec.stop();
      }
      teardownMeter();
      releaseMic();
    };
  }, [releaseMic, teardownMeter]);

  // ── Listening ──────────────────────────────────────────────────────────────
  /** Returns false when WebAudio is unavailable, so there is no level to read. */
  const startMeter = useCallback((stream: MediaStream): boolean => {
    let ctx: AudioContext;
    try {
      ctx = new AudioContext();
    } catch {
      return false;   // no WebAudio: the caller falls back to the hard cap
    }
    audioCtxRef.current = ctx;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);

    const startedAt = Date.now();
    let lastVoiceAt = 0;
    heardSpeechRef.current = false;

    meterTimerRef.current = window.setInterval(() => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const x = (buf[i] - 128) / 128;
        sum += x * x;
      }
      const rms = Math.sqrt(sum / buf.length);
      setLevel(prev => prev * 0.6 + rms * 0.4);

      const now = Date.now();
      const elapsed = now - startedAt;
      if (rms > SPEECH_RMS) {
        lastVoiceAt = now;
        heardSpeechRef.current = true;
      }

      if (elapsed > MAX_LISTEN_MS) stopListening();
      else if (heardSpeechRef.current && now - lastVoiceAt > SILENCE_MS && elapsed > MIN_LISTEN_MS) stopListening();
      else if (!heardSpeechRef.current && elapsed > NO_SPEECH_MS) stopListening();
    }, 100);
    return true;
  }, [stopListening]);

  const startListening = useCallback(async () => {
    if (abortedRef.current) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch {
      setErrorMsg('Could not access the microphone. Check the app’s permissions and try again.');
      setPhase('error');
      return;
    }
    streamRef.current = stream;
    try {
      const mimeType = getSupportedMimeType();
      mimeTypeRef.current = mimeType;
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      heardSpeechRef.current = false;
      recorder.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => { teardownMeter(); void handleRecordingComplete(); };
      recorderRef.current = recorder;
      recorder.start(250);
      setPhase('listening');

      const metered = startMeter(stream);
      if (!metered) {
        // No level to watch, so nothing can judge whether anyone spoke — assume
        // they did and let the transcript be the judge. Claiming "I didn't hear
        // anything" here would be a guess, and a self-fulfilling one.
        heardSpeechRef.current = true;
      }
      // The meter is what normally closes the mic. It is also the thing that can
      // be missing, so the cap belongs outside it — otherwise a browser without
      // WebAudio records until the tab is closed.
      hardStopRef.current = window.setTimeout(stopListening, MAX_LISTEN_MS + 500);
    } catch {
      // Don't leave the mic hot if the recorder itself failed to start.
      releaseMic();
      setErrorMsg('Recording isn’t supported in this browser. Try Chrome or Safari.');
      setPhase('error');
    }
    // handleRecordingComplete is defined below; the ref-based state it reads is
    // always current, so the stale-closure warning doesn't apply here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [releaseMic, startMeter, stopListening, teardownMeter]);

  // ── Conversation control ───────────────────────────────────────────────────
  const askSlot = useCallback(async (slot: Slot, forDraft: EntryDraft, override?: string) => {
    slotRef.current = slot;
    setActiveSlot(slot);

    // A re-prompt after a misheard answer is already tuned to explain what's
    // needed — rephrasing that one would lose the correction.
    const who = personRef.current;
    let question = override ?? slot.ask(forDraft, who);
    if (!override) {
      setPhase('thinking');
      question = await phraseQuestion(question, {
        mustKeep: slot.keep,
        // Naming the subject here stops the rewrite quietly turning "Maya's
        // rash" back into "your rash".
        context: `${forDraft.type.toLowerCase()}${forDraft.name ? ` "${forDraft.name}"` : ''}`
          + (who.isSelf ? '' : `, being logged for ${who.named}, not for the person speaking`),
      });
      if (abortedRef.current) return;
    }

    pushTurn('bea', question);
    setPhase('speaking');
    await speak(question, { muted: mutedRef.current });
    if (abortedRef.current) return;
    await startListening();
  }, [pushTurn, startListening]);

  const finishInterview = useCallback(async (finalDraft: EntryDraft) => {
    draftRef.current = finalDraft;
    setDraft(finalDraft);
    slotRef.current = null;
    setActiveSlot(null);
    setPhase('review');
    const line = 'Here’s what I’ve got — tap save if that looks right.';
    pushTurn('bea', line);
    await speak(line, { muted: mutedRef.current });
  }, [pushTurn]);

  const advance = useCallback((next: EntryDraft) => {
    draftRef.current = next;
    setDraft(next);
    const slot = nextSlot(next, askedRef.current);
    if (!slot) {
      void finishInterview(next);
      return;
    }
    retriesRef.current = 0;
    void askSlot(slot, next);
  }, [askSlot, finishInterview]);

  const resetSession = useCallback(() => {
    draftRef.current = null;
    slotRef.current = null;
    askedRef.current = [];
    retriesRef.current = 0;
    noAnswerRef.current = 0;
    setDraft(null);
    setActiveSlot(null);
    setTurns([]);
    setErrorMsg('');
    setSavedSummary([]);
  }, []);

  const cancelSession = useCallback(async () => {
    resetSession();
    setPhase('idle');
    const line = 'No problem — nothing was saved.';
    pushTurn('bea', line);
    await speak(line, { muted: mutedRef.current });
  }, [pushTurn, resetSession]);

  /** Single entry point for anything the user "said" — spoken or tapped. */
  const handleAnswer = useCallback(async (text: string) => {
    // Something came through, so the run of dead attempts is over. Tapping a
    // chip counts too, which is why this sits here rather than next to the
    // transcription that usually produces it.
    noAnswerRef.current = 0;
    pushTurn('you', text);
    const current = draftRef.current;

    // First utterance: work out what's being logged.
    if (!current) {
      setPhase('thinking');
      const understood = await understandOpening(text);
      if (abortedRef.current) return;
      if (!understood.name) {
        // Couldn't tell what it was — ask outright rather than guessing.
        advance({ type: understood.type, name: '' });
        return;
      }
      advance(understood);
      return;
    }

    const slot = slotRef.current;
    if (!slot) return;

    const result = applyAnswer(current, slot.key, text, new Date(), personRef.current);
    if (result.status === 'cancel') {
      void cancelSession();
      return;
    }
    if (result.status === 'retry') {
      retriesRef.current += 1;
      if (retriesRef.current > MAX_RETRIES) {
        // Stop badgering: keep the words verbatim and move on.
        const stashed = stashUnparsed(current, slot.key, text);
        askedRef.current = [...askedRef.current, slot.key];
        advance(stashed);
        return;
      }
      void askSlot(slot, current, result.reprompt);
      return;
    }

    askedRef.current = [...askedRef.current, slot.key];
    advance(result.draft);
  }, [advance, askSlot, cancelSession, pushTurn]);

  // ── Recording → transcript ─────────────────────────────────────────────────
  const handleRecordingComplete = useCallback(async () => {
    const slot = slotRef.current;
    /**
     * `retry` reopens the mic straight away; `paused` is said instead once the
     * attempts are spent, and then Bea waits. The two are worded differently on
     * purpose — telling someone to "tap the mic" while silently reopening it
     * ourselves is what made the old loop so confusing to watch.
     */
    const reAsk = (retry: string, paused: string) => {
      noAnswerRef.current += 1;
      if (!slot || !draftRef.current) {
        setErrorMsg(paused);
        setPhase('error');
        return;
      }
      if (noAnswerRef.current >= MAX_NO_ANSWER) {
        pushTurn('bea', paused);
        setPhase('paused');
        void speak(paused, { muted: mutedRef.current });
        return;
      }
      void askSlot(slot, draftRef.current, retry);
    };

    if (!heardSpeechRef.current) {
      reAsk(
        'I didn’t catch that — go ahead whenever you’re ready.',
        'I still can’t hear anything. Check the mic isn’t muted, then tap it to try again.',
      );
      return;
    }

    const mimeType = mimeTypeRef.current || 'audio/webm';
    const blob = new Blob(chunksRef.current, { type: mimeType });
    if (blob.size < 500) {
      reAsk(
        'That was too short to make out — could you say it again?',
        'I’m still not getting enough audio. Tap the mic and try once more.',
      );
      return;
    }

    try {
      setPhase('transcribing');
      const text = await transcribeWithGroq(blob, mimeType);
      if (abortedRef.current) return;
      if (!text) {
        reAsk(
          'I couldn’t make that out — could you say it again?',
          'I still couldn’t make that out. Tap the mic to try again.',
        );
        return;
      }
      await handleAnswer(text);
    } catch (err) {
      console.error('VoicePage transcription error:', err);
      setErrorMsg(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      setPhase('error');
    }
  }, [askSlot, handleAnswer, pushTurn]);

  // ── Saving ─────────────────────────────────────────────────────────────────
  const saveDraft = useCallback(async () => {
    const finalDraft = draftRef.current;
    if (!finalDraft) return;
    setPhase('saving');
    const payload = draftToPayload({ ...finalDraft, familyMemberId: activeId });
    try {
      const { data: created } = await client.models.HealthEntry.create(payload);

      // "I took some Benadryl for it" becomes its own medication entry, linked
      // both ways — that link is what lets the export report whether treatment
      // helped, rather than listing doses and symptoms as unrelated rows.
      if (created?.id && finalDraft.treatment) {
        try {
          const { data: med } = await client.models.HealthEntry.create({
            type: 'Medication',
            name: finalDraft.treatment,
            time: finalDraft.startedAt || toLocalDatetimeInputValue(new Date()),
            reason: finalDraft.name,
            relatedEntryId: created.id,
            familyMemberId: activeId,
          });
          if (med?.id) {
            await client.models.HealthEntry.update({ id: created.id, relatedEntryId: med.id });
          }
        } catch (linkErr) {
          // The symptom itself is saved; a missing link shouldn't fail the log.
          console.warn('VoicePage: could not save the linked medication entry', linkErr);
        }
      }

      const summary = [
        `${finalDraft.type}: ${finalDraft.name}`,
        finalDraft.bodyArea ? `Where: ${finalDraft.bodyArea}` : '',
        typeof finalDraft.severity === 'number' ? `Severity: ${toFiveScale(finalDraft.severity)}/5` : '',
        finalDraft.startedAt ? `Started: ${new Date(finalDraft.startedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : '',
        finalDraft.resolvedAt ? `Resolved: ${new Date(finalDraft.resolvedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : '',
        finalDraft.treatment ? `Taken for it: ${finalDraft.treatment}` : '',
        finalDraft.cofactors?.length ? `Context: ${finalDraft.cofactors.join(', ')}` : '',
        finalDraft.epinephrineAvailable ? `Epinephrine on hand: ${finalDraft.epinephrineAvailable}` : '',
        finalDraft.emergencyCare && finalDraft.emergencyCare !== 'none' ? `Emergency care: ${EMERGENCY_LABELS[finalDraft.emergencyCare]}` : '',
        finalDraft.notes ? `Notes: ${finalDraft.notes}` : '',
        finalDraft.followUp ? 'Bea will check in tomorrow' : '',
      ].filter(Boolean);
      setSavedSummary(summary);
      setPhase('done');
      const line = finalDraft.followUp
        ? `Saved. I’ll check in tomorrow to see how the ${finalDraft.name.toLowerCase()} is doing.`
        : 'Saved to your health log.';
      pushTurn('bea', line);
      await speak(line, { muted: mutedRef.current });
    } catch (err) {
      console.error('VoicePage save error:', err);
      setErrorMsg(err instanceof Error ? err.message : 'Could not save. Please try again.');
      setPhase('error');
    }
  }, [pushTurn, activeId]);

  // ── Draft editing (the safety net for a misheard answer) ───────────────────
  const patchDraft = useCallback((patch: Partial<EntryDraft>) => {
    setDraft(prev => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      draftRef.current = next;
      return next;
    });
  }, []);

  // ── Controls ───────────────────────────────────────────────────────────────
  const beginSession = useCallback(async () => {
    abortedRef.current = false;
    resetSession();
    setPhase('speaking');
    pushTurn('bea', OPENING_QUESTION);
    await speak(OPENING_QUESTION, { muted: mutedRef.current });
    if (abortedRef.current) return;
    await startListening();
  }, [pushTurn, resetSession, startListening]);

  const handleMicPress = () => {
    if (phase === 'listening') {
      stopListening();
      return;
    }
    if (phase === 'speaking') {
      // Skip Bea's remaining words and start answering right away.
      cancelSpeech();
      void startListening();
      return;
    }
    if (phase === 'paused') {
      // Resume the question that was already asked instead of repeating it, and
      // give the attempts back so a second quiet moment doesn't end it instantly.
      noAnswerRef.current = 0;
      // The pause message may still be playing; an eager tap should cut it off
      // rather than have Bea talk over the answer.
      cancelSpeech();
      if (slotRef.current && draftRef.current) void startListening();
      else void beginSession();
      return;
    }
    if (phase === 'idle' || phase === 'done' || phase === 'error') {
      if (draftRef.current && phase === 'error' && slotRef.current) {
        void askSlot(slotRef.current, draftRef.current);
      } else {
        void beginSession();
      }
    }
  };

  const handleChip = (label: string) => {
    if (phase === 'listening') stopListening();
    cancelSpeech();
    void handleAnswer(label);
  };

  const busy = phase === 'transcribing' || phase === 'thinking' || phase === 'saving';
  // Chips stay up while paused on purpose: if the mic is the thing that failed,
  // tapping an answer is the way out of the interview.
  const showChips = Boolean(
    (phase === 'listening' || phase === 'speaking' || phase === 'paused') && activeSlot?.chips && draft,
  );
  const stepsLeft = draft ? remainingCount(draft, askedRef.current) : 0;

  const statusLabel: Record<Phase, string> = {
    idle: 'Tap the mic and tell me what happened',
    listening: 'Listening… I’ll stop when you do',
    transcribing: 'Getting that down…',
    thinking: 'Working out what to log…',
    speaking: 'Bea is speaking…',
    paused: 'Tap the mic when you’re ready to answer',
    review: 'Check this over before it’s saved',
    saving: 'Saving to your health log…',
    done: 'Saved to your log',
    error: 'Something went wrong',
  };

  return (
    <div className="voice-screen">
      <button className="back-dark" onClick={() => onNavigate('home')}>
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
      </button>

      <div className="voice-top-actions">
        <PatientSwitcher onManageFamily={() => onNavigate('profile')} />

      <button
        className="voice-mute-btn"
        onClick={() => { setMuted(m => !m); cancelSpeech(); }}
        title={muted ? 'Unmute Bea' : 'Mute Bea'}
        aria-pressed={muted}
      >
        {muted ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
            <line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>
          </svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>
          </svg>
        )}
      </button>
      </div>

      <div className="voice-content">
        <div className={[
          'voice-orb',
          phase === 'listening' ? 'voice-orb--active' : '',
          phase === 'speaking' ? 'voice-orb--speaking' : '',
          // Give the height back to the conversation once one is underway.
          turns.length > 0 || phase === 'review' ? 'voice-orb--compact' : '',
        ].filter(Boolean).join(' ')}>
          <img src={beaImg} alt="Bea" className="voice-orb-img" />
        </div>

        {phase === 'listening' && <WaveAnimation level={level} />}
        {busy && <Spinner />}

        <p className="voice-status-label">{statusLabel[phase]}</p>

        {phase === 'idle' && turns.length === 0 && (
          <div className="voice-examples">
            <p className="voice-examples-title">Just say what happened:</p>
            {EXAMPLE_PROMPTS.map((ex, i) => (
              <p key={i} className="voice-example-item">{ex}</p>
            ))}
            <p className="voice-examples-hint">
              Bea asks the rest — where it is, how bad it is from 1 to 5, when it started,
              and whether she should check back in tomorrow.
            </p>
          </div>
        )}

        {/* Conversation so far */}
        {turns.length > 0 && phase !== 'done' && (
          <div className="voice-thread">
            {turns.map((t, i) => (
              <div key={i} className={`voice-turn voice-turn--${t.role} ${i === turns.length - 1 ? 'voice-turn--current' : ''}`}>
                {t.text}
              </div>
            ))}
          </div>
        )}

        {/* Tappable answers for the current question */}
        {showChips && (
          <div className="voice-chips">
            {activeSlot!.chips!(draft!).map(label => (
              <button key={label} className="voice-chip" onClick={() => handleChip(label)}>{label}</button>
            ))}
            {activeSlot!.optional && (
              <button className="voice-chip voice-chip--skip" onClick={() => handleChip('skip')}>Skip</button>
            )}
          </div>
        )}

        {(phase === 'listening' || phase === 'speaking' || phase === 'thinking' || phase === 'paused') && draft && stepsLeft > 0 && (
          <p className="voice-progress">{stepsLeft} quick question{stepsLeft === 1 ? '' : 's'} to go</p>
        )}

        {/* Review — every answer is editable before anything is written */}
        {phase === 'review' && draft && (
          <div className="voice-review">
            <div className="voice-review-row">
              <label className="voice-review-label">What</label>
              <input
                className="voice-review-input"
                value={draft.name}
                onChange={e => patchDraft({ name: e.target.value })}
              />
            </div>

            {draft.type === 'Symptom' && needsBodyArea(draft.name) && (
              <div className="voice-review-row">
                <label className="voice-review-label">Where</label>
                <input
                  className="voice-review-input"
                  value={draft.bodyArea ?? ''}
                  placeholder="e.g. left arm"
                  onChange={e => patchDraft({ bodyArea: e.target.value })}
                />
              </div>
            )}

            {draft.type === 'Symptom' && (
              <div className="voice-review-row">
                <label className="voice-review-label">How bad (1–5)</label>
                <div className="voice-severity-row">
                  {[1, 2, 3, 4, 5].map(n => (
                    <button
                      key={n}
                      className={`voice-severity-btn ${typeof draft.severity === 'number' && toFiveScale(draft.severity) === n ? 'voice-severity-btn--on' : ''}`}
                      onClick={() => patchDraft({ severity: n * 2 })}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {draft.type === 'Medication' && (
              <div className="voice-review-row">
                <label className="voice-review-label">Dose</label>
                <input
                  className="voice-review-input"
                  value={[draft.dose, draft.unit].filter(Boolean).join(' ')}
                  placeholder="e.g. 25 mg"
                  onChange={e => {
                    const [dose, ...rest] = e.target.value.trim().split(/\s+/);
                    patchDraft({ dose, unit: rest.join(' ') });
                  }}
                />
              </div>
            )}

            <div className="voice-review-row">
              <label className="voice-review-label">
                {draft.type === 'Medication' ? 'Taken at' : draft.type === 'Exposure' ? 'Had at' : 'Started'}
              </label>
              <input
                className="voice-review-input"
                type="datetime-local"
                value={draft.startedAt ?? toLocalDatetimeInputValue(new Date())}
                max={toLocalDatetimeInputValue(new Date())}
                onChange={e => patchDraft({ startedAt: e.target.value })}
              />
            </div>

            {draft.resolvedAt && (
              <div className="voice-review-row">
                <label className="voice-review-label">
                  {draft.resolvedPrecision === 'confirmed-by' ? 'Resolved by' : 'Resolved'}
                </label>
                <input
                  className="voice-review-input"
                  type="datetime-local"
                  value={draft.resolvedAt}
                  max={toLocalDatetimeInputValue(new Date())}
                  onChange={e => patchDraft({ resolvedAt: e.target.value, resolvedPrecision: 'exact' })}
                />
              </div>
            )}

            {draft.type === 'Symptom' && (
              <div className="voice-review-row">
                <label className="voice-review-label">Taken for it</label>
                <input
                  className="voice-review-input"
                  value={draft.treatment ?? ''}
                  placeholder="e.g. Cetirizine — leave blank for nothing"
                  onChange={e => patchDraft({ treatment: e.target.value })}
                />
              </div>
            )}

            {draft.type === 'Symptom' && (
              <div className="voice-review-row">
                <label className="voice-review-label">What else was going on</label>
                <div className="voice-cofactor-row">
                  {COFACTOR_OPTIONS.map(c => {
                    const on = draft.cofactors?.includes(c) ?? false;
                    return (
                      <button
                        key={c}
                        className={`voice-cofactor-chip ${on ? 'voice-cofactor-chip--on' : ''}`}
                        onClick={() => patchDraft({
                          cofactors: on
                            ? (draft.cofactors ?? []).filter(x => x !== c)
                            : [...(draft.cofactors ?? []), c],
                        })}
                      >
                        {c}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Red-flag episodes only — these two are what a clinician looks for first. */}
            {isSignificantEpisode(draft) && (
              <>
                <div className="voice-review-row">
                  <label className="voice-review-label">Epinephrine on hand</label>
                  <div className="voice-severity-row">
                    {(['yes', 'no'] as const).map(v => (
                      <button
                        key={v}
                        className={`voice-severity-btn ${draft.epinephrineAvailable === v ? 'voice-severity-btn--on' : ''}`}
                        onClick={() => patchDraft({ epinephrineAvailable: v })}
                      >
                        {v === 'yes' ? 'Yes' : 'No'}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="voice-review-row">
                  <label className="voice-review-label">Emergency care</label>
                  <div className="voice-cofactor-row">
                    {(Object.keys(EMERGENCY_LABELS) as EmergencyCare[]).map(v => (
                      <button
                        key={v}
                        className={`voice-cofactor-chip ${draft.emergencyCare === v ? 'voice-cofactor-chip--on' : ''}`}
                        onClick={() => patchDraft({ emergencyCare: v })}
                      >
                        {EMERGENCY_LABELS[v]}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}

            <div className="voice-review-row">
              <label className="voice-review-label">Notes</label>
              <textarea
                className="voice-review-input voice-review-textarea"
                rows={2}
                value={draft.notes ?? ''}
                placeholder="Anything else worth remembering"
                onChange={e => patchDraft({ notes: e.target.value })}
              />
            </div>

            {draft.type !== 'Medication' && !draft.resolvedAt && (
              <label className="voice-review-checkline">
                <input
                  type="checkbox"
                  checked={!!draft.followUp}
                  onChange={e => patchDraft({ followUp: e.target.checked })}
                />
                <span>Check in tomorrow to see if it has cleared up</span>
              </label>
            )}

            <div className="voice-confirm-actions">
              <button className="voice-confirm-btn voice-confirm-btn--yes" onClick={() => void saveDraft()}>
                Save to my log
              </button>
              <button className="voice-confirm-btn voice-confirm-btn--no" onClick={() => void cancelSession()}>
                Start over
              </button>
            </div>
          </div>
        )}

        {phase === 'done' && savedSummary.length > 0 && (
          <div className="voice-saved-list">
            {savedSummary.map((item, i) => (
              <div key={i} className="voice-saved-item">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
                <span>{item}</span>
              </div>
            ))}
          </div>
        )}

        {phase === 'error' && errorMsg && <p className="voice-error-msg">{errorMsg}</p>}

        {/* Scroll anchor — keeps the newest question and the review card in
            view without the user having to chase them. */}
        <div ref={contentEndRef} />
      </div>

      <div className="voice-controls">
        <button className="voice-side-btn" onClick={() => onNavigate('chat')} title="Switch to text chat">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
        </button>

        <button
          className={[
            'voice-mic-btn',
            phase === 'listening' ? 'voice-mic-btn--active' : '',
            phase === 'done' ? 'voice-mic-btn--done' : '',
            busy || phase === 'review' ? 'voice-mic-btn--disabled' : '',
          ].filter(Boolean).join(' ')}
          onClick={handleMicPress}
          disabled={busy || phase === 'review'}
          title={phase === 'listening' ? 'Tap to stop' : 'Tap to talk'}
        >
          {phase === 'done' ? (
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          ) : (
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
              <line x1="12" y1="19" x2="12" y2="23"/>
              <line x1="8" y1="23" x2="16" y2="23"/>
            </svg>
          )}
        </button>

        <button className="voice-side-btn" onClick={() => onNavigate('symptom-logger')} title="View health log">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
            <polyline points="10 9 9 9 8 9"/>
          </svg>
        </button>
      </div>

      {phase === 'done' && (
        <button className="voice-log-another" onClick={() => { resetSession(); setPhase('idle'); }}>
          + Log something else
        </button>
      )}

      {(phase === 'listening' || phase === 'speaking' || phase === 'paused') && (
        <button className="voice-cancel-link" onClick={() => { stopListening(); cancelSpeech(); void cancelSession(); }}>
          Cancel
        </button>
      )}

      <p className="voice-disclaimer">
        Immuny helps track experiences and patterns and does not provide medical advice.
      </p>
    </div>
  );
}
