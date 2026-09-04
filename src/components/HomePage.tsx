import { useEffect, useState } from 'react';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '../../amplify/data/resource';
import type { Page } from '../types';
import beaImg from '../assets/bea.png';
import { useActivePatient } from '../contexts/useActivePatient';
import { getNextUpcoming } from '../utils/medications';
import { listAll } from '../utils/listAll';
import type { TodayDoseEntry } from '../utils/medications';
import SymptomOverviewCard from './SymptomOverviewCard';
import ImmunyCalendarCard from './ImmunyCalendarCard';
import ProgressCard from './ProgressCard';
import CheckInCard from './CheckInCard';
import type { DueCheckIn } from './CheckInCard';
import {
  ArrowRightIcon,
  BarChartIcon,
  BookIcon,
  CameraIcon,
  ChatBubbleIcon,
  ClockIcon,
  SearchIcon,
  SparkleIcon,
  ThermometerIcon,
  UserIcon,
  UtensilsIcon,
  WaveformIcon,
} from './icons';

const client = generateClient<Schema>();

interface HealthEntryRow {
  type: string;
  time: string;
  severity?: number | null;
}

interface HomePageProps {
  onNavigate: (page: Page, tab?: string) => void;
  userName?: string;
}

export default function HomePage({ onNavigate, userName }: HomePageProps) {
  const { activeId } = useActivePatient();
  const [healthEntries, setHealthEntries] = useState<HealthEntryRow[]>([]);
  const [checkIns, setCheckIns] = useState<DueCheckIn[]>([]);
  const [testedAllergens, setTestedAllergens] = useState<string[]>([]);
  const [nextMed, setNextMed] = useState<TodayDoseEntry | null>(null);
  const [profileName, setProfileName] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await client.models.UserProfile.list();
        if (data && data.length > 0 && data[0].name) setProfileName(data[0].name);
      } catch (e) {
        console.warn('HomePage: failed to load profile name', e);
      }
    })();
  }, []);

  // Refetches every time the Home page mounts (component key is the current
  // page in App.tsx), so newly logged entries always show up on return.
  useEffect(() => {
    (async () => {
      try {
        const data = await listAll(nextToken => client.models.HealthEntry.list({ nextToken }));
        if (data) {
          // The home dashboard speaks for whoever the switcher is on.
          const mine = data.filter(d => (d.familyMemberId ?? undefined) === activeId);
          setHealthEntries(mine.map(d => ({ type: d.type, time: d.time, severity: d.severity ?? null })));

          // Check-ins the voice logger scheduled, once they come due.
          const now = Date.now();
          setCheckIns(
            mine
              .filter(d => d.followUpAt && d.followUpStatus !== 'resolved' && new Date(d.followUpAt).getTime() <= now)
              .sort((a, b) => new Date(a.followUpAt!).getTime() - new Date(b.followUpAt!).getTime())
              .map(d => ({
                id: d.id,
                type: d.type,
                name: d.name,
                bodyArea: d.bodyArea,
                notes: d.notes,
                time: d.time,
                followUpAt: d.followUpAt!,
              })),
          );
        }
      } catch (e) {
        console.warn('HomePage: failed to load health entries', e);
      }
    })();
  }, [activeId]);

  useEffect(() => {
    (async () => {
      try {
        const data = await listAll(nextToken =>
          client.models.ExposureTest.list({ filter: { status: { eq: 'completed' } }, nextToken }),
        );
        setTestedAllergens(data.map(t => t.allergen));
      } catch (e) {
        console.warn('HomePage: failed to load exposure tests', e);
      }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [meds, logs] = await Promise.all([
          listAll(nextToken => client.models.Medication.list({ nextToken })),
          listAll(nextToken => client.models.MedicationLog.list({ nextToken })),
        ]);
        if (meds) {
          const mapped = meds.map(m => ({
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
          }));
          const mappedLogs = (logs ?? []).map(l => ({ id: l.id, medicationId: l.medicationId, takenAt: l.takenAt }));
          setNextMed(getNextUpcoming(mapped, mappedLogs, new Date()));
        }
      } catch (e) {
        console.warn('HomePage: failed to load medications', e);
      }
    })();
  }, []);

  // Prefer the saved profile name; fall back to the local part of the login
  // email (never show the raw email — it reads oddly as a "name").
  const displayName = profileName?.trim() || userName?.split('@')[0];
  const greeting = displayName ? `Hello, ${displayName.split(' ')[0]}!` : "Hello, I'm Bea,";

  return (
    <div className="home-screen">
      {/* ── Gradient hero ── */}
      <div className="home-hero">
        <div className="home-rings">
          <div className="ring ring-1" />
          <div className="ring ring-2" />
        </div>
        <img src={beaImg} alt="Bea" className="bea-hero" />
        <p className="home-greeting">{greeting}</p>
        <h2 className="home-question">How can I help?</h2>
      </div>

      {/* ── Follow-ups Bea promised during a voice log ── */}
      <CheckInCard
        items={checkIns}
        onAnswered={id => setCheckIns(prev => prev.filter(c => c.id !== id))}
      />

      {/* ── Next medication reminder ── */}
      {nextMed && (
        <button className="home-med-card" onClick={() => onNavigate('medications')}>
          <span className="home-med-icon"><ClockIcon /></span>
          <div className="home-med-info">
            <span className="home-med-label">Coming up {nextMed.medication.timeLabel ?? ''}</span>
            <span className="home-med-name">{nextMed.medication.name}</span>
            <span className="home-med-subtitle">
              {[nextMed.medication.dose, nextMed.medication.unit].filter(Boolean).join('')} {nextMed.medication.frequency ?? ''}
            </span>
          </div>
          <span className="home-med-arrow"><ArrowRightIcon /></span>
        </button>
      )}

      {/* ── Action tiles ── */}
      <div className="home-tiles">
        <button className="home-tile home-tile--tall" onClick={() => onNavigate('voice')}>
          <span className="tile-top-row">
            <span className="tile-icon"><WaveformIcon /></span>
            <span className="tile-arrow"><ArrowRightIcon /></span>
          </span>
          <span className="tile-label">voice chat with Bea</span>
        </button>

        <button className="home-tile" onClick={() => onNavigate('chat')}>
          <span className="tile-top-row">
            <span className="tile-icon"><ChatBubbleIcon /></span>
            <span className="tile-arrow"><ArrowRightIcon /></span>
          </span>
          <span className="tile-label">text with Bea</span>
        </button>

        <button className="home-tile" onClick={() => onNavigate('insights')}>
          <span className="tile-top-row">
            <span className="tile-icon"><SparkleIcon /></span>
            <span className="tile-arrow"><ArrowRightIcon /></span>
          </span>
          <span className="tile-label">Bea's insight explanation</span>
        </button>
      </div>

      {/* ── Add New Food / Tracker ── */}
      <div className="home-food-row">
        <div className="home-food-col">
          <span className="home-food-col-title">Add New Food</span>
          <button className="home-food-card" onClick={() => onNavigate('food-tracker')}>
            <span className="home-food-card-icon"><CameraIcon /></span>
            <span className="home-food-card-label">Scan Meal</span>
          </button>
        </div>
        <div className="home-food-col">
          <span className="home-food-col-title">Tracker</span>
          <button className="home-food-card" onClick={() => onNavigate('insights')}>
            <span className="home-food-card-icon"><BarChartIcon /></span>
            <span className="home-food-card-label">View Allergies</span>
          </button>
        </div>
      </div>

      {/* ── Progress: Big 9 allergens tested ── */}
      <ProgressCard
        testedAllergens={testedAllergens}
        onClick={() => onNavigate('exposure-testing', 'big9')}
      />

      {/* ── Symptom overview chart ── */}
      <SymptomOverviewCard entries={healthEntries} />

      {/* ── Month calendar of everything logged ── */}
      <ImmunyCalendarCard entries={healthEntries} />

      {/* ── Resource Hub & External Links ── */}
      <div className="home-resource-hub">
        <h3 className="home-section-title">Resource Hub &amp; External Links</h3>
        <button className="home-resource-links-card" onClick={() => onNavigate('resource-hub')}>
          <div className="home-resource-link">
            <span className="home-resource-link-icon"><BookIcon /></span>
            <span>Allergy Education</span>
          </div>
          <div className="home-resource-link">
            <span className="home-resource-link-icon"><ClockIcon /></span>
            <span>Food Guidance</span>
          </div>
          <div className="home-resource-link">
            <span className="home-resource-link-icon"><UserIcon /></span>
            <span>Cross Reactors &amp; FDA Recalls</span>
          </div>
        </button>

        <div className="home-resource-grid">
          <button className="home-resource-tile" onClick={() => onNavigate('symptom-logger', 'Symptom')}>
            <ThermometerIcon /> <span>Log symptoms</span>
          </button>
          <button className="home-resource-tile" onClick={() => onNavigate('food-tracker')}>
            <UtensilsIcon /> <span>Log food</span>
          </button>
          <button className="home-resource-tile" onClick={() => onNavigate('resource-hub')}>
            <SearchIcon /> <span>Resources</span>
          </button>
          <button className="home-resource-tile" onClick={() => onNavigate('profile')}>
            <UserIcon /> <span>Profile</span>
          </button>
          <button className="home-resource-tile home-resource-tile--wide" onClick={() => onNavigate('insights')}>
            <SparkleIcon /> <span>Insights</span>
          </button>
        </div>
      </div>
    </div>
  );
}
