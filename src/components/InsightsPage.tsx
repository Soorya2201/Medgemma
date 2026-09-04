import { useEffect, useState, type ComponentType } from 'react';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '../../amplify/data/resource';
import type { Page } from '../types';
import beaImg from '../assets/bea.png';
import { buildAllergenChartData, buildDataSummary, parseInsights } from '../utils/parseInsights';
import type { AllergenBar, InsightCard } from '../utils/parseInsights';
import AllergenChart from './AllergenChart';
import { useActivePatient } from '../contexts/useActivePatient';
import { listAll } from '../utils/listAll';
import { AlertTriangleIcon, ArrowRightIcon, BarChartIcon, ClipboardIcon, LightbulbIcon } from './icons';

const client = generateClient<Schema>();

interface InsightsState {
  cards: InsightCard[];
  raw: string;
  hasData: boolean;
  chartData: AllergenBar[];
}

const INSIGHT_ICONS: Record<string, ComponentType> = {
  '⚠': AlertTriangleIcon,
  '📊': BarChartIcon,
  '💡': LightbulbIcon,
  '📋': ClipboardIcon,
};

const NO_DATA_CARDS: InsightCard[] = [
  {
    emoji: '📋',
    label: 'Get started',
    text: 'Log your first symptom, exposure, or medication to unlock AI-powered pattern insights.',
  },
  {
    emoji: '💡',
    label: 'Tip',
    text: 'The more you log, the smarter Bea gets. Even 5–7 entries reveal meaningful patterns.',
  },
];

// Below this many combined logs, there isn't enough signal for a real pattern —
// asking the model anyway tends to produce generic, near-identical boilerplate
// for every low-data user. Say so plainly instead.
const MIN_LOGS_FOR_INSIGHTS = 5;

const LOW_DATA_CARDS: InsightCard[] = [
  {
    emoji: '📋',
    label: 'Almost there',
    text: "There's not quite enough logged yet for Bea to spot a real pattern. Keep logging symptoms and exposures — personalized insights kick in once you've got a few more entries.",
  },
];

interface InsightsPageProps {
  onNavigate: (page: Page) => void;
}

export default function InsightsPage({ onNavigate }: InsightsPageProps) {
  const { activeId } = useActivePatient();
  const [state, setState] = useState<InsightsState>({
    cards: [],
    raw: '',
    hasData: false,
    chartData: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [entries, tests] = await Promise.all([
          listAll(nextToken => client.models.HealthEntry.list({ nextToken })),
          listAll(nextToken => client.models.ExposureTest.list({ nextToken })),
        ]);

        if (cancelled) return;

        // Insights are a claim about one person's patterns. Pooling a household
        // would invent correlations between two children's unrelated symptoms.
        const safeEntries = (entries ?? [])
          .filter(e => (e.familyMemberId ?? undefined) === activeId)
          .map(e => ({
            type: e.type,
            name: e.name,
            severity: e.severity ?? null,
            time: e.time,
          }));
        const safeTests = (tests ?? []).filter(t => (t.familyMemberId ?? undefined) === activeId).map(t => ({
          allergen: t.allergen,
          status: t.status,
          reactions: t.reactions ?? null,
          // Feed the allergen chart's progress clocks.
          testDate: t.testDate ?? null,
          testTime: t.testTime ?? null,
          monitoringDuration: t.monitoringDuration ?? null,
        }));

        const summary = buildDataSummary(safeEntries, safeTests);
        const aggregatedChart = buildAllergenChartData(safeEntries, safeTests);

        if (summary === 'NO_DATA') {
          setState({ cards: NO_DATA_CARDS, raw: '', hasData: false, chartData: [] });
          return;
        }

        if (safeEntries.length + safeTests.length < MIN_LOGS_FOR_INSIGHTS) {
          setState({ cards: LOW_DATA_CARDS, raw: '', hasData: true, chartData: aggregatedChart });
          return;
        }

        const result = await client.queries.askNovaMicro({
          question:
            'Based on this health data, generate exactly 3 insights in this format — ' +
            'PATTERN: [one sentence] TREND: [one sentence] TIP: [one actionable sentence]. ' +
            'Be specific to the numbers provided. Keep each under 25 words.',
          history: '[]',
          context: `Health data summary: ${summary}`,
        });

        if (cancelled) return;

        const raw = String(result.data ?? '').trim();
        const cards = parseInsights(raw);
        setState({
          cards,
          raw,
          hasData: true,
          chartData: aggregatedChart,
        });
      } catch (err) {
        if (!cancelled) {
          console.error('InsightsPage error:', err);
          setError('Could not load insights. Please try again.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [activeId]);

  return (
    <div className="insights-screen">
      <div className="insights-top-bar">
        <button className="insights-back-btn" onClick={() => onNavigate('home')}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
        </button>
        <h1 className="insights-title-text">Bea</h1>
        <div className="profile-dot" />
      </div>

      <div className="insights-body">
        <img src={beaImg} alt="Bea" className="insights-bea" />
        <h2 className="insights-heading">User Insight</h2>

        {loading ? (
          <div className="insights-loading">
            <div className="insights-spinner" />
            <p>Analyzing your health data…</p>
          </div>
        ) : error ? (
          <div className="insights-error">
            <p>{error}</p>
            <button onClick={() => window.location.reload()} className="insights-retry-btn">
              Retry
            </button>
          </div>
        ) : (
          <div className="insights-card">
            {state.cards.map((card, i) => {
              const Icon = INSIGHT_ICONS[card.emoji] ?? LightbulbIcon;
              return (
                <div key={i} className="insight-row">
                  <span className="insight-emoji"><Icon /></span>
                  <p>
                    <strong>{card.label}:</strong> {card.text}
                  </p>
                </div>
              );
            })}
            {state.hasData && (
              <p className="insights-summary-link">
                For more information view{' '}
                <button
                  className="link-btn"
                  onClick={() => onNavigate('symptom-logger')}
                >
                  Health Logger
                </button>
              </p>
            )}
          </div>
        )}

        {!loading && !error && (
          <AllergenChart data={state.chartData} />
        )}

        <div className="insights-actions">
          <button
            className="insights-action-secondary"
            onClick={() => onNavigate('chat')}
          >
            Chat with AI <ArrowRightIcon />
          </button>
          <button
            className="insights-action-primary"
            onClick={() => onNavigate('resource-hub')}
          >
            Chat with an Allergist
          </button>
        </div>

        {!loading && !error && (
          <p className="insights-disclaimer">
            Bea's insights are generated from your own logged data and can be wrong or incomplete.
            This isn't medical advice or a diagnosis — always check with a healthcare provider.
          </p>
        )}
      </div>
    </div>
  );
}
