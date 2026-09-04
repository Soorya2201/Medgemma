import { useMemo, useRef, useState } from 'react';
import { buildMonthGrid, KIND_ORDER } from '../utils/calendarMonth';
import type { LogKind } from '../utils/calendarMonth';
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon } from './icons';

interface ImmunyCalendarCardProps {
  entries: { type: string; time: string }[];
}

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const KIND_LABEL: Record<LogKind, string> = {
  food: 'Food',
  symptom: 'Symptom',
  medication: 'Medication',
};

// Below this a swipe reads as a tap or as vertical page scrolling.
const SWIPE_PX = 44;

export default function ImmunyCalendarCard({ entries }: ImmunyCalendarCardProps) {
  const [view, setView] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [slide, setSlide] = useState<'forward' | 'back' | null>(null);
  const swipeStart = useRef<number | null>(null);

  const days = useMemo(
    () => buildMonthGrid(view.year, view.month, entries),
    [view, entries],
  );
  const loggedDays = days.filter(d => d.kinds.length > 0).length;
  const monthName = new Date(view.year, view.month, 1).toLocaleString('en-US', { month: 'long' });

  const shiftMonth = (delta: number) => {
    const next = new Date(view.year, view.month + delta, 1);
    setView({ year: next.getFullYear(), month: next.getMonth() });
    setSlide(delta > 0 ? 'forward' : 'back');
  };

  const shiftYear = (delta: number) => {
    setView(v => ({ ...v, year: v.year + delta }));
    setSlide(delta > 0 ? 'forward' : 'back');
  };

  const endSwipe = (clientX: number) => {
    if (swipeStart.current == null) return;
    const dx = clientX - swipeStart.current;
    swipeStart.current = null;
    if (dx <= -SWIPE_PX) shiftMonth(1);
    else if (dx >= SWIPE_PX) shiftMonth(-1);
  };

  return (
    <div className="cal-card">
      <div className="cal-header">
        <span className="cal-title"><CalendarIcon /> Immuny Calendar</span>
        <div className="cal-year-stepper">
          <button className="cal-step" onClick={() => shiftYear(-1)} aria-label={`Show ${view.year - 1}`}>
            <ChevronLeftIcon />
          </button>
          <span className="cal-year">{view.year}</span>
          <button className="cal-step" onClick={() => shiftYear(1)} aria-label={`Show ${view.year + 1}`}>
            <ChevronRightIcon />
          </button>
        </div>
      </div>

      <div
        className="cal-swipe"
        tabIndex={0}
        role="group"
        aria-label={`${monthName} ${view.year}. Swipe or press the left and right arrow keys to change month.`}
        onPointerDown={e => { swipeStart.current = e.clientX; }}
        onPointerUp={e => endSwipe(e.clientX)}
        onPointerLeave={() => { swipeStart.current = null; }}
        onKeyDown={e => {
          if (e.key === 'ArrowLeft') shiftMonth(-1);
          else if (e.key === 'ArrowRight') shiftMonth(1);
        }}
      >
        <div className="cal-month">{monthName}</div>

        <div className="cal-weekdays">
          {WEEKDAYS.map((letter, i) => <span key={i}>{letter}</span>)}
        </div>

        {/* Keyed on the month so the entrance animation replays on every change. */}
        <div
          key={`${view.year}-${view.month}`}
          className={`cal-grid${slide ? ` cal-grid--${slide}` : ''}`}
        >
          {days.map((d, i) => (
            <div
              key={i}
              className={[
                'cal-day',
                d.inMonth ? '' : 'cal-day--out',
                d.kinds.length > 0 ? 'cal-day--logged' : '',
                d.isToday ? 'cal-day--today' : '',
              ].filter(Boolean).join(' ')}
              title={d.kinds.length > 0 ? `${d.kinds.map(k => KIND_LABEL[k]).join(', ')} logged` : undefined}
            >
              <span className="cal-day-num">{d.day}</span>
              <span className="cal-day-dots">
                {d.kinds.map(k => <i key={k} className={`cal-dot cal-dot--${k}`} />)}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="cal-legend">
        {KIND_ORDER.map(k => (
          <span key={k} className="cal-legend-item">
            <i className={`cal-dot cal-dot--${k}`} />{KIND_LABEL[k]}
          </span>
        ))}
      </div>

      <p className="cal-caption">
        {loggedDays} day{loggedDays === 1 ? '' : 's'} logged in {monthName} {view.year}
      </p>
    </div>
  );
}
