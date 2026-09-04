export type LogKind = 'food' | 'symptom' | 'medication';

// HealthEntry.type is 'Exposure' | 'Symptom' | 'Medication'; 'Exposure' is what
// the food tracker writes, so it reads as "food" on a calendar.
const KIND_BY_TYPE: Record<string, LogKind> = {
  exposure: 'food',
  symptom: 'symptom',
  medication: 'medication',
};

export const KIND_ORDER: LogKind[] = ['food', 'symptom', 'medication'];

export interface CalendarDay {
  date: Date;
  day: number;
  inMonth: boolean;
  isToday: boolean;
  kinds: LogKind[];
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// Builds the day cells for one month, each carrying which kinds of log that day
// holds. The grid always starts on a Sunday and runs whole weeks, so it ends up
// 28/35/42 cells depending on where the month falls.
export function buildMonthGrid(
  year: number,
  month: number,
  entries: { type: string; time: string }[],
  now: Date = new Date(),
): CalendarDay[] {
  const byDay = new Map<string, Set<LogKind>>();
  for (const entry of entries) {
    const at = new Date(entry.time);
    if (Number.isNaN(at.getTime())) continue;
    const kind = KIND_BY_TYPE[entry.type?.toLowerCase()];
    if (!kind) continue;
    const key = dayKey(at);
    const kinds = byDay.get(key) ?? new Set<LogKind>();
    kinds.add(kind);
    byDay.set(key, kinds);
  }

  const leading = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cellCount = Math.ceil((leading + daysInMonth) / 7) * 7;
  const todayKey = dayKey(now);

  const grid: CalendarDay[] = [];
  for (let i = 0; i < cellCount; i++) {
    const date = new Date(year, month, i - leading + 1);
    const inMonth = date.getMonth() === month && date.getFullYear() === year;
    const logged = byDay.get(dayKey(date));
    grid.push({
      date,
      day: date.getDate(),
      inMonth,
      isToday: dayKey(date) === todayKey,
      kinds: inMonth && logged ? KIND_ORDER.filter(k => logged.has(k)) : [],
    });
  }
  return grid;
}
