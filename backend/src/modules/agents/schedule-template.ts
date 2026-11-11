import { localTime, resolveTimeZone } from '../../common/utils/current-time';

/**
 * Values a schedule's message can use, filled in at each run in the
 * organization's time zone:
 *
 *   {{today}}        the date of the run, 2026-11-11
 *   {{now}}          the date and time of the run, 2026-11-11T08:00:00+01:00
 *   {{last_run_at}}  when the schedule's previous successful run started;
 *                    on the first run, when the schedule was created
 *
 * Only the message text is filled in. Anything else in `{{ }}` is left as
 * it was written.
 */
export const SCHEDULE_TEMPLATE_NAMES = ['last_run_at', 'today', 'now'] as const;
export type ScheduleTemplateName = (typeof SCHEDULE_TEMPLATE_NAMES)[number];
export type ScheduleTemplateValues = Record<ScheduleTemplateName, string>;

const PLACEHOLDER = /\{\{\s*(last_run_at|today|now)\s*\}\}/g;

/** Whether `text` uses any of the values. */
export function usesScheduleTemplate(text: unknown): text is string {
  return typeof text === 'string' && new RegExp(PLACEHOLDER.source).test(text);
}

/** The values for a run at `now` whose schedule last ran (or was created) at `lastRunAt`. */
export function scheduleTemplateValues(now: Date, lastRunAt: Date, timeZone: string): ScheduleTemplateValues {
  const zone = resolveTimeZone(timeZone);
  const at = localTime(now, zone);
  return { today: at.date, now: at.iso, last_run_at: localTime(lastRunAt, zone).iso };
}

/** `text` with every value it uses filled in. */
export function fillScheduleTemplate(text: string, values: ScheduleTemplateValues): string {
  return text.replace(PLACEHOLDER, (_match, name: ScheduleTemplateName) => values[name]);
}

/**
 * A scheduled run's input with its message filled in. Only `input.message`
 * is touched, and only when it is text; every other field, and the input's
 * shape, are left exactly as they were.
 */
export function withFilledMessage<T extends Record<string, any> | null | undefined>(input: T, values: ScheduleTemplateValues): T {
  if (!inputUsesScheduleTemplate(input)) return input;
  const filled: Record<string, any> = { ...input };
  for (const [key, value] of Object.entries(filled)) {
    if (usesScheduleTemplate(value)) filled[key] = fillScheduleTemplate(value, values);
  }
  return filled as T;
}

/**
 * Whether any top-level text field of a run input uses a value. The input
 * is shaped before it is filled, so the text sits in the agent's declared
 * input field, which is not always `message`.
 */
export function inputUsesScheduleTemplate(input: Record<string, any> | null | undefined): boolean {
  return !!input && Object.values(input).some((value) => usesScheduleTemplate(value));
}