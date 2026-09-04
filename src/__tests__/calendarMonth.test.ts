import { describe, it, expect } from 'vitest';
import { buildMonthGrid } from '../utils/calendarMonth';

// Local-time throughout: a log belongs to the day the person lived it, which is
// a local calendar day, not a UTC one.
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h);
const entry = (type: string, when: Date) => ({ type, time: when.toISOString() });

const NOW = at(2026, 9, 4);

describe('buildMonthGrid', () => {
  it('runs whole weeks starting on Sunday', () => {
    // 1 Sep 2026 is a Tuesday, so the grid opens with two trailing August days.
    const grid = buildMonthGrid(2026, 8, [], NOW);
    expect(grid).toHaveLength(35);
    expect(grid[0].date.getDay()).toBe(0);
    expect(grid[0].inMonth).toBe(false);
    expect(grid[2].day).toBe(1);
    expect(grid[2].inMonth).toBe(true);
  });

  it('covers every day of the month', () => {
    const grid = buildMonthGrid(2026, 8, [], NOW);
    const inMonth = grid.filter(d => d.inMonth).map(d => d.day);
    expect(inMonth).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  });

  it('handles a February that starts on a Sunday', () => {
    const grid = buildMonthGrid(2026, 1, [], NOW);
    expect(grid[0].day).toBe(1);
    expect(grid[0].inMonth).toBe(true);
    expect(grid).toHaveLength(28);
  });

  it('marks a leap day', () => {
    const grid = buildMonthGrid(2028, 1, [], NOW);
    expect(grid.filter(d => d.inMonth)).toHaveLength(29);
  });

  it('tags each day with the kinds logged on it', () => {
    const grid = buildMonthGrid(2026, 8, [
      entry('Exposure', at(2026, 9, 3)),
      entry('Symptom', at(2026, 9, 3, 18)),
      entry('Medication', at(2026, 9, 10)),
    ], NOW);
    const third = grid.find(d => d.inMonth && d.day === 3)!;
    const tenth = grid.find(d => d.inMonth && d.day === 10)!;
    expect(third.kinds).toEqual(['food', 'symptom']);
    expect(tenth.kinds).toEqual(['medication']);
  });

  it('collapses repeat logs of one kind into a single marker', () => {
    const grid = buildMonthGrid(2026, 8, [
      entry('Exposure', at(2026, 9, 3, 8)),
      entry('Exposure', at(2026, 9, 3, 13)),
      entry('Exposure', at(2026, 9, 3, 19)),
    ], NOW);
    expect(grid.find(d => d.inMonth && d.day === 3)!.kinds).toEqual(['food']);
  });

  it('leaves days without logs unmarked', () => {
    const grid = buildMonthGrid(2026, 8, [entry('Symptom', at(2026, 9, 3))], NOW);
    expect(grid.filter(d => d.kinds.length > 0)).toHaveLength(1);
  });

  it('ignores logs from other months and unparseable or unknown entries', () => {
    const grid = buildMonthGrid(2026, 8, [
      entry('Symptom', at(2026, 8, 3)),
      { type: 'Symptom', time: 'not-a-date' },
      entry('Note', at(2026, 9, 3)),
    ], NOW);
    expect(grid.every(d => d.kinds.length === 0)).toBe(true);
  });

  it('flags today only in the month it belongs to', () => {
    const september = buildMonthGrid(2026, 8, [], NOW);
    expect(september.filter(d => d.isToday).map(d => d.day)).toEqual([4]);
    expect(buildMonthGrid(2026, 10, [], NOW).some(d => d.isToday)).toBe(false);
  });
});
