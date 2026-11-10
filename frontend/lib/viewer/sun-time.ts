/**
 * Dates, wall-clock times and time zones for the sun (`sun.ts`). On their own
 * so the project format (`lib/project/manifest.ts`) can check them without
 * loading the map projections.
 */

/** The time zone this computer is set to, e.g. "Europe/Lisbon". */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function isTimeZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || zone === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Every IANA time zone the browser knows, for a picker; at least `extra` and UTC. */
export function timeZones(extra?: string): string[] {
  let zones: string[] = [];
  try {
    zones = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    zones = [];
  }
  const all = new Set(zones);
  all.add("UTC");
  if (extra) all.add(extra);
  return [...all].sort();
}

/** Today's date on this computer, "YYYY-MM-DD". */
export function todayIso(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const CLOCK_TIME = /^\d{2}:\d{2}$/;

/**
 * The instant at which the clocks in `zone` read `date` ("YYYY-MM-DD") and
 * `time` ("HH:MM"). Null for a date or time that does not parse.
 */
export function zonedTimeToUtc(date: string, time: string, zone: string): Date | null {
  if (!ISO_DATE.test(date) || !CLOCK_TIME.test(time)) return null;
  const [year, month, day] = date.split("-").map(Number);
  const [hours, minutes] = time.split(":").map(Number);
  const wall = Date.UTC(year, month - 1, day, hours, minutes);
  if (!Number.isFinite(wall)) return null;
  const offset = (instant: number) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: isTimeZone(zone) ? zone : "UTC",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(instant));
    const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value);
    return Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second")) - instant;
  };
  // Twice: the first guess may fall on the other side of a summer-time change.
  let instant = wall - offset(wall);
  instant = wall - offset(instant);
  return new Date(instant);
}
