import { describe, expect, test } from 'bun:test';

import {
  isTimezone,
  parseDaysOfMonth,
  parseList,
  toggleWeekday,
  windowWeekdays,
  withScheduleEffect,
} from './routeSchedules';

describe('weekdays', () => {
  test('reads names in any form OpenCode accepts, and numbers, skipping what it cannot read', () => {
    expect(windowWeekdays({ daysOfWeek: ['monday', 'tues', 5, 'Mon', 9] })).toEqual([1, 2, 5]);
    expect(windowWeekdays(undefined)).toEqual([]);
  });

  test('a toggle writes short names in week order, and the last day off removes the field', () => {
    expect(toggleWeekday({ daysOfWeek: ['friday'], start: '09:00' }, 1)).toEqual({ daysOfWeek: ['mon', 'fri'], start: '09:00' });
    expect(toggleWeekday({ daysOfWeek: ['fri'], start: '09:00' }, 5)).toEqual({ start: '09:00' });
    expect(toggleWeekday(undefined, 0)).toEqual({ daysOfWeek: ['sun'] });
  });
});

describe('form text', () => {
  test('lists drop blanks, and an empty list is unset', () => {
    expect(parseList(' a/*, , b ')).toEqual(['a/*', 'b']);
    expect(parseList(' , ')).toBeUndefined();
  });

  test('days of the month accept 1 to 31 and -1, and refuse anything else', () => {
    expect(parseDaysOfMonth('1, 15, -1')).toEqual([1, 15, -1]);
    expect(parseDaysOfMonth('')).toBeUndefined();
    expect(parseDaysOfMonth('0')).toBeNull();
    expect(parseDaysOfMonth('32')).toBeNull();
    expect(parseDaysOfMonth('1.5')).toBeNull();
    expect(parseDaysOfMonth('first')).toBeNull();
  });

  test('timezones are checked against the runtime', () => {
    expect(isTimezone('America/Chicago')).toBe(true);
    expect(isTimezone('UTC')).toBe(true);
    expect(isTimezone('Mars/Olympus')).toBe(false);
  });
});

describe('withScheduleEffect', () => {
  test('keeps exactly one of factor and weight', () => {
    expect(withScheduleEffect({ when: {}, factor: 0.5, weight: 3 }, 'weight', 2)).toEqual({ when: {}, weight: 2 });
    expect(withScheduleEffect({ when: {}, weight: 3 }, 'factor', 0.5)).toEqual({ when: {}, factor: 0.5 });
  });
});
