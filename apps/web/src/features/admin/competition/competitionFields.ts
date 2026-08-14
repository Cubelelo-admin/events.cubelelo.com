/**
 * One definition of the competition form's fields, shared by the Create and
 * Manage screens.
 *
 * Both screens previously implemented every field independently, so they drifted:
 * different labels for the same thing ("Base Fee (₹)" vs "Base Fee (INR)"),
 * different trimming, different defaults, and fields present in one screen and
 * absent from the other. Anything that describes a field — its label, its unit,
 * its default — belongs here so there is only one of it.
 */

/** Competition-level form state. All values are strings as typed by the user. */
export interface CompetitionDetailsValue {
  title: string;
  description: string;
  rulesMd: string;
  /** Rule sets this competition uses, in display order. */
  ruleSetIds: string[];
  type: "free" | "paid";
  /** Rupees, as typed. Converted to paise at submit. */
  baseFee: string;
  perEventFee: string;
  registrationLimit: string;
  /** Hours as typed. Converted to minutes at submit. */
  videoDeadlineHours: string;
  featured: boolean;
  featuredOrder: string;
  /** `datetime-local` values, converted to ISO at submit. */
  registrationOpensAt: string;
  registrationDeadline: string;
  startsAt: string;
  endsAt: string;
}

export const EMPTY_COMPETITION_DETAILS: CompetitionDetailsValue = {
  title: "",
  description: "",
  rulesMd: "",
  ruleSetIds: [],
  type: "free",
  baseFee: "",
  perEventFee: "",
  registrationLimit: "",
  videoDeadlineHours: "",
  featured: false,
  featuredOrder: "",
  registrationOpensAt: "",
  registrationDeadline: "",
  startsAt: "",
  endsAt: "",
};

/** Per-event form state. Times are seconds as typed; fees are rupees. */
export interface EventFieldsValue {
  eventType: string;
  roundCount: number;
  fee: string;
  cutoffSec: string;
  timeLimitSec: string;
}

export const EMPTY_EVENT_FIELDS: EventFieldsValue = {
  eventType: "333",
  roundCount: 1,
  fee: "",
  cutoffSec: "",
  timeLimitSec: "",
};

/** Labels, so the two screens cannot disagree on what a field is called. */
export const FIELD_LABELS = {
  title: "Title",
  description: "Description",
  rules: "Rules",
  type: "Type",
  baseFee: "Base Fee (₹)",
  perEventFee: "Per-Event Fee (₹)",
  registrationLimit: "Registration Limit",
  videoDeadline: "Video Deadline",
  featured: "Featured",
  featuredOrder: "Featured Order",
  desktopBanner: "Desktop Banner",
  mobileBanner: "Mobile Banner",
  registrationOpensAt: "Registration opens",
  registrationDeadline: "Registration closes",
  startsAt: "Competition starts",
  endsAt: "Competition ends",
  eventType: "Event",
  roundCount: "Rounds",
  eventFee: "Fee (₹)",
  cutoff: "Cutoff (seconds)",
  timeLimit: "Time Limit (seconds)",
} as const;

export const IMAGE_HINTS = {
  desktopBanner: "1200×400 recommended",
  mobileBanner: "600×400 recommended",
} as const;

/** Rounds per event, matching the server's clamp. */
export const MIN_ROUND_COUNT = 1;
export const MAX_ROUND_COUNT = 10;

/**
 * Fallbacks used when the global scheduling settings cannot be loaded. Both
 * screens had their own copy of these, with different values in one case.
 */
export const FALLBACK_EVENT_DURATION: Record<string, number> = {
  "222": 15, "333": 20, "444": 25, "555": 30, "666": 35, "777": 40,
  pyram: 15, skewb: 15, minx: 30, "333oh": 20, "333bf": 25, sq1: 20,
  clock: 15, "444bf": 40, "555bf": 50, "333mbf": 60, fto: 25, "333fm": 60,
};
export const FALLBACK_ROUND_DURATION = 20;
/** Days between registration opening and closing, when not configured. */
export const FALLBACK_REG_DAYS = 5;

export const IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";

// ── Unit conversions ────────────────────────────────────────────────────────
// Money is stored in paise and typed in rupees; durations are stored in
// milliseconds and typed in seconds. Getting these inconsistent between the two
// screens is exactly the kind of drift this module exists to prevent.

/** Rupees as typed → paise, or undefined when blank. */
export function rupeesToPaise(input: string): number | undefined {
  const n = Number(input);
  if (input.trim() === "" || Number.isNaN(n)) return undefined;
  return Math.round(n * 100);
}

/** Paise → rupees for display in an input. */
export function paiseToRupees(paise: number | null | undefined): string {
  return paise === null || paise === undefined ? "" : String(paise / 100);
}

/** Seconds as typed → milliseconds, or undefined when blank. */
export function secondsToMs(input: string): number | undefined {
  const n = Number(input);
  if (input.trim() === "" || Number.isNaN(n) || n <= 0) return undefined;
  return Math.round(n * 1000);
}

/** Milliseconds → seconds for display in an input. */
export function msToSeconds(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? "" : String(ms / 1000);
}

/**
 * Hours as typed → minutes, or undefined when blank.
 *
 * The video deadline is stored in minutes and always will be — every deadline
 * calculation in the API and on the public page works in minutes. Admins think
 * in hours, so the conversion lives at the form boundary only. Decimals are
 * allowed, so 1.5 h becomes 90 min.
 */
export function hoursToMinutes(input: string): number | undefined {
  const n = Number(input);
  if (input.trim() === "" || !Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 60);
}

/**
 * Minutes → hours for display. Trims trailing zeros so 1440 reads as "24" and
 * 90 as "1.5" rather than "24.00" / "1.50".
 */
export function minutesToHours(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return "";
  const hours = minutes / 60;
  return String(Number(hours.toFixed(2)));
}

/** A positive integer from a form string, or undefined when blank/invalid. */
export function toPositiveInt(input: string): number | undefined {
  const n = Number(input);
  if (input.trim() === "" || !Number.isFinite(n) || n < 1) return undefined;
  return Math.round(n);
}

// ── Date helpers ────────────────────────────────────────────────────────────

/** ISO string → `datetime-local` value in the viewer's timezone. */
export function toLocalDatetime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `datetime-local` value → ISO string, or null when blank. */
export function toISO(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ── Client-side validation ──────────────────────────────────────────────────

/**
 * Field-level problems, keyed by field name. Both screens render these the same
 * way, so Manage can no longer save an empty title where Create refuses to.
 */
export function validateCompetitionDetails(
  value: CompetitionDetailsValue,
): Partial<Record<keyof CompetitionDetailsValue, string>> {
  const errors: Partial<Record<keyof CompetitionDetailsValue, string>> = {};

  if (!value.title.trim()) errors.title = "Title is required.";

  if (value.type === "paid") {
    for (const key of ["baseFee", "perEventFee"] as const) {
      const raw = value[key];
      if (raw.trim() === "") continue;
      const n = Number(raw);
      if (Number.isNaN(n) || n < 0) errors[key] = "Enter a valid amount, or leave blank for none.";
    }
  }

  for (const key of ["registrationLimit", "featuredOrder", "videoDeadlineHours"] as const) {
    const raw = value[key];
    if (raw.trim() === "") continue;
    const n = Number(raw);
    if (Number.isNaN(n) || n < 0) errors[key] = "Enter a whole number, or leave blank.";
  }

  const opens = value.registrationOpensAt ? +new Date(value.registrationOpensAt) : null;
  const closes = value.registrationDeadline ? +new Date(value.registrationDeadline) : null;
  const starts = value.startsAt ? +new Date(value.startsAt) : null;
  const ends = value.endsAt ? +new Date(value.endsAt) : null;

  if (opens !== null && closes !== null && opens >= closes) {
    errors.registrationDeadline = "Registration must close after it opens.";
  }
  if (closes !== null && starts !== null && closes > starts) {
    errors.startsAt = "Competition must start at or after registration closes.";
  }
  if (starts !== null && ends !== null && starts >= ends) {
    errors.endsAt = "Competition must end after it starts.";
  }

  return errors;
}
