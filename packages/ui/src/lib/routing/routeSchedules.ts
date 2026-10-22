import type { GlobalSchedule, ScheduleWindow } from '@/lib/routing/modelRoutesApi';

/** The day names OpenCode accepts, by weekday number, 0 for Sunday. Written back as the short form. */
const SHORT_DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

const DAY_NUMBERS = new Map<string, number>([
  ['sun', 0],
  ['sunday', 0],
  ['mon', 1],
  ['monday', 1],
  ['tue', 2],
  ['tues', 2],
  ['tuesday', 2],
  ['wed', 3],
  ['wednesday', 3],
  ['thu', 4],
  ['thur', 4],
  ['thurs', 4],
  ['thursday', 4],
  ['fri', 5],
  ['friday', 5],
  ['sat', 6],
  ['saturday', 6],
]);

export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

// A number is one of the seven weekdays; a string is one of the names OpenCode accepts.
const dayNumber = (day: string | number): number | undefined =>
  WEEKDAYS.find((weekday) => weekday === day) ?? DAY_NUMBERS.get(String(day));

/** The weekdays a window names, as numbers; an entry the editor cannot read is left out. */
export const windowWeekdays = (window: ScheduleWindow | undefined): number[] =>
  (window?.daysOfWeek ?? []).flatMap((day) => {
    const number = dayNumber(day);
    return number === undefined ? [] : [number];
  });

/** Turns one weekday on or off. No day left means every day, so the field is removed. */
export const toggleWeekday = (window: ScheduleWindow | undefined, day: number): ScheduleWindow => {
  const current = new Set(windowWeekdays(window));
  if (current.has(day)) current.delete(day);
  else current.add(day);
  const days = [...current].sort((left, right) => left - right).map((number) => SHORT_DAY_NAMES[number]);
  return withWindowField(window, 'daysOfWeek', days.length > 0 ? days : undefined);
};

/** Sets or removes one window field; an undefined value removes it. */
export const withWindowField = <K extends keyof ScheduleWindow>(
  window: ScheduleWindow | undefined,
  key: K,
  value: ScheduleWindow[K] | undefined,
): ScheduleWindow => {
  const next: ScheduleWindow = { ...(window ?? {}) };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
};

/** A comma-separated list as trimmed entries, without blanks; an empty list is undefined. */
export const parseList = (text: string): string[] | undefined => {
  const items = text.split(',').map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
};

/**
 * Days of the month typed as "1, 15, -1". Returns undefined for an empty field
 * (every day) and null when an entry is not 1 to 31 or -1.
 */
export const parseDaysOfMonth = (text: string): number[] | undefined | null => {
  const items = parseList(text);
  if (!items) return undefined;
  const days = items.map(Number);
  return days.every((day) => day === -1 || (Number.isInteger(day) && day >= 1 && day <= 31)) ? days : null;
};

/** Whether the runtime knows an IANA timezone name. */
export const isTimezone = (name: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
};

type ScheduleEffect = 'factor' | 'weight';

export const scheduleEffect = (schedule: GlobalSchedule): ScheduleEffect => (schedule.weight !== undefined ? 'weight' : 'factor');

/** Sets the schedule's change as a factor or an outright weight; the other one is removed. */
export const withScheduleEffect = (schedule: GlobalSchedule, effect: ScheduleEffect, value: number): GlobalSchedule => {
  const next: GlobalSchedule = { ...schedule };
  delete next.factor;
  delete next.weight;
  next[effect] = value;
  return next;
};

/** Sets or removes one schedule field; an undefined value removes it. */
export const withScheduleField = <K extends keyof GlobalSchedule>(
  schedule: GlobalSchedule,
  key: K,
  value: GlobalSchedule[K] | undefined,
): GlobalSchedule => {
  const next: GlobalSchedule = { ...schedule };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
};

/** A new entry: every day, all day, weight unchanged until the user picks a change. */
export const newSchedule = (): GlobalSchedule => ({ when: {}, factor: 1 });
