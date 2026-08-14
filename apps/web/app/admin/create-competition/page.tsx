"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CompetitionDetailsFields,
  CompetitionScheduleFields,
} from "@/features/admin/competition/CompetitionDetailsFields";
import { buildCompetitionPayload } from "@/features/admin/competition/buildCompetitionPayload";
import {
  computeRoundSchedules,
  mergeRoundSlots,
  toLocalDatetime,
  type RoundSlot,
} from "@/features/admin/competition/schedule";
import { ArchivedEventsList } from "@/features/admin/competition/ArchivedEventsList";
import {
  RoundScheduleList,
  type CriteriaMethod,
  type ScheduleRow,
} from "@/features/admin/competition/RoundScheduleList";
import {
  FIELD_LABELS,
  IMAGE_ACCEPT,
  IMAGE_HINTS,
  MAX_ROUND_COUNT,
  MIN_ROUND_COUNT,
  validateCompetitionDetails,
  type CompetitionDetailsValue,
} from "@/features/admin/competition/competitionFields";
import {
  createCompetition,
  updateCompetition,
  uploadCompetitionBanner,
  uploadCompetitionMobileBanner,
  fetchSchedulingDefaults,
  fetchRuleSets,
  type AdvancementCriteria,
  type SchedulingDefaults,
  type RuleSetDto,
} from "@/lib/api";
import { ErrorCard } from "@/components/ui/ErrorCard";

interface EventSpec {
  eventType: string;
  roundCount: number;
  cutoffMs?: number;
  timeLimitMs?: number;
  fee?: number;
  /** Created but hidden from competitors. Create offers Archive in place of a discard. */
  archived?: boolean;
  durationMinutes?: number;
  // Per-round format / cutoff / time-limit overrides are supported by the API
  // but not exposed here — rounds take the event's WCA default format and the
  // event's cutoff and time limit.
  roundCriteria?: (AdvancementCriteria | undefined)[];
  roundSchedule?: (RoundSlot | undefined)[];
}

const FALLBACK_EVENT_DURATION: Record<string, number> = {
  "222": 15, "333": 20, "444": 25, "555": 30, "666": 35, "777": 40,
  pyram: 15, skewb: 15, minx: 30, "333oh": 20, "333bf": 25, sq1: 20,
  clock: 15, "444bf": 40, "555bf": 50, "333mbf": 60, fto: 25, "333fm": 60,
};
const FALLBACK_DURATION = 20;
const FALLBACK_REG_DAYS = 5;

type ScheduleField = "regOpens" | "regClose" | "compStart" | "compEnd";

/** Identifies one planned round for pinning purposes. */
const roundKey = (eventIndex: number, roundIndex: number) => `${eventIndex}:${roundIndex}`;

/** Shared form keys → this page's internal cascade field names. */
const SCHEDULE_KEY_TO_FIELD: Record<string, ScheduleField> = {
  registrationOpensAt: "regOpens",
  registrationDeadline: "regClose",
  startsAt: "compStart",
  endsAt: "compEnd",
};

/** Stored criteria → the row's method dropdown value. */
function rowCriteriaMethod(c: AdvancementCriteria | undefined): CriteriaMethod {
  return (c?.method as CriteriaMethod) ?? "none";
}

/** Stored criteria → the row's value input (rank as a count, others in seconds). */
function rowCriteriaValue(c: AdvancementCriteria | undefined): string {
  if (!c) return "";
  if (c.method === "rank") return c.rankLimit ? String(c.rankLimit) : "";
  if (c.method === "time") return c.timeLimitMs ? String(c.timeLimitMs / 1000) : "";
  if (c.method === "best_single") return c.bestSingleMs ? String(c.bestSingleMs / 1000) : "";
  return "";
}

/** Row inputs → stored criteria. Returns undefined for "none" or a blank value. */
function buildCriteria(method: CriteriaMethod, raw: string): AdvancementCriteria | undefined {
  const n = Number(raw);
  if (method === "none" || !raw.trim() || Number.isNaN(n) || n < 1) return undefined;
  if (method === "rank") return { method: "rank", rankLimit: Math.round(n) };
  if (method === "time") return { method: "time", timeLimitMs: Math.round(n * 1000) };
  return { method: "best_single", bestSingleMs: Math.round(n * 1000) };
}

/** Green "Choose file" button, shared by both admin screens. */
const FILE_BUTTON =
  "file:mr-3 file:rounded file:border-0 file:bg-emerald-600 file:px-3 file:py-1 file:text-xs file:font-semibold file:text-white hover:file:bg-emerald-500";

const INPUT =
  "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none";

/** File input for an image that is uploaded once the competition exists. */
function ImagePicker({
  label,
  hint,
  file,
  onPick,
}: {
  label: string;
  hint: string;
  file: File | null;
  onPick: (f: File | null) => void;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-zinc-500">
        {label} <span className="text-zinc-400">({hint})</span>
      </label>
      {file && <p className="mb-1 text-xs text-emerald-500">Selected: {file.name}</p>}
      <input
        type="file"
        accept={IMAGE_ACCEPT}
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
        className={`${INPUT} ${FILE_BUTTON}`}
      />
    </div>
  );
}

export default function CreateCompetitionPage() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [rulesMd, setRulesMd] = useState("");
  const [ruleSets, setRuleSets] = useState<RuleSetDto[]>([]);
  const [ruleSetIds, setRuleSetIds] = useState<string[]>([]);
  const [type, setType] = useState<"free" | "paid">("free");
  const [baseFee, setBaseFee] = useState("");
  const [perEventFee, setPerEventFee] = useState("");
  const [registrationOpensAt, setRegistrationOpensAt] = useState("");
  const [registrationDeadline, setRegistrationDeadline] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [events, setEvents] = useState<EventSpec[]>([
    { eventType: "333", roundCount: 1 },
  ]);
  const [bannerFile, setBannerFile] = useState<File | null>(null);
  const [mobileBannerFile, setMobileBannerFile] = useState<File | null>(null);
  const [registrationLimit, setRegistrationLimit] = useState("");
  const [featured, setFeatured] = useState(false);
  const [featuredOrder, setFeaturedOrder] = useState("");
  const [videoDeadlineHours, setVideoDeadlineHours] = useState("");
  const [gapMinutes, setGapMinutes] = useState(0);
  const [regDays, setRegDays] = useState(FALLBACK_REG_DAYS);
  const [durationOverrides, setDurationOverrides] = useState<Record<string, number>>({});
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const draftIdRef = useRef<string | null>(null);
  const [autoSaveStatus, setAutoSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load scheduling defaults and rule sets
  useEffect(() => {
    fetchSchedulingDefaults()
      .then((s) => {
        setRegDays(s.registrationDurationDays);
        setGapMinutes(s.gapBetweenEventsMinutes);
        setDurationOverrides(s.eventDurations);
        setSettingsLoaded(true);
      })
      .catch(() => setSettingsLoaded(true));
    fetchRuleSets().then(setRuleSets).catch(() => {});
  }, []);

  /**
   * Competition-level form state as one value, so the shared
   * `CompetitionDetailsFields` can render it. The individual `useState`s stay the
   * source of truth because the schedule cascade below drives them directly.
   */
  const details: CompetitionDetailsValue = useMemo(
    () => ({
      title, description, rulesMd, ruleSetIds, type,
      baseFee, perEventFee, registrationLimit, videoDeadlineHours,
      featured, featuredOrder,
      registrationOpensAt, registrationDeadline, startsAt, endsAt,
    }),
    [title, description, rulesMd, ruleSetIds, type, baseFee, perEventFee,
     registrationLimit, videoDeadlineHours, featured, featuredOrder,
     registrationOpensAt, registrationDeadline, startsAt, endsAt],
  );

  /** Shared client-side validation, so Manage cannot accept what Create rejects. */
  const fieldErrors = useMemo(() => validateCompetitionDetails(details), [details]);

  const archivedRows = useMemo(
    () =>
      events
        .map((ev, i) => ({ ev, i }))
        .filter(({ ev }) => ev.archived)
        .map(({ ev, i }) => ({
          key: String(i),
          eventType: ev.eventType,
          roundCount: ev.roundCount,
        })),
    [events],
  );

  /**
   * Flatten the planned events into one time-ordered list of rounds.
   *
   * Rounds without a start time sort last, grouped by event then round number,
   * so a partially-scheduled competition still reads sensibly.
   */
  const scheduleRows: ScheduleRow[] = useMemo(() => {
    const rows = events.flatMap((ev, eventIndex) =>
      ev.archived ? [] :
      Array.from({ length: ev.roundCount }, (_, ri) => {
        const slot = ev.roundSchedule?.[ri];
        const criteria = ev.roundCriteria?.[ri];
        return {
          key: `${eventIndex}:${ri}`,
          eventKey: String(eventIndex),
          eventType: ev.eventType,
          roundNumber: ri + 1,
          isFirstOfEvent: false, // set below, once sorted
          isLastOfEvent: ri === ev.roundCount - 1,
          startTime: slot?.startTime ?? "",
          durationMinutes: slot?.durationMinutes ? String(slot.durationMinutes) : "",
          criteriaMethod: rowCriteriaMethod(criteria),
          criteriaValue: rowCriteriaValue(criteria),
          fee: ev.fee != null ? String(ev.fee) : "",
          eventIndex,
        };
      }),
    );

    rows.sort((a, b) => {
      if (a.startTime && b.startTime) return a.startTime.localeCompare(b.startTime);
      if (a.startTime) return -1;
      if (b.startTime) return 1;
      return a.eventIndex - b.eventIndex || a.roundNumber - b.roundNumber;
    });

    // Event-level controls belong to whichever of an event's rows comes first.
    const seen = new Set<string>();
    for (const row of rows) {
      if (!seen.has(row.eventKey)) {
        row.isFirstOfEvent = true;
        seen.add(row.eventKey);
      }
    }
    return rows;
  }, [events]);

  const setDetails = useCallback((patch: Partial<CompetitionDetailsValue>) => {
    if (patch.title !== undefined) setTitle(patch.title);
    if (patch.description !== undefined) setDescription(patch.description);
    if (patch.rulesMd !== undefined) setRulesMd(patch.rulesMd);
    if (patch.ruleSetIds !== undefined) setRuleSetIds(patch.ruleSetIds);
    if (patch.type !== undefined) setType(patch.type);
    if (patch.baseFee !== undefined) setBaseFee(patch.baseFee);
    if (patch.perEventFee !== undefined) setPerEventFee(patch.perEventFee);
    if (patch.registrationLimit !== undefined) setRegistrationLimit(patch.registrationLimit);
    if (patch.videoDeadlineHours !== undefined) setVideoDeadlineHours(patch.videoDeadlineHours);
    if (patch.featured !== undefined) setFeatured(patch.featured);
    if (patch.featuredOrder !== undefined) setFeaturedOrder(patch.featuredOrder);
  }, []);

  const buildBody = useCallback(() => {
    return {
      // Competition-level fields come from the shared builder, so Create and
      // Manage cannot produce different requests from the same values.
      ...buildCompetitionPayload(details),
      events: events.map((ev) => ({
        ...ev,
        fee: ev.fee != null ? Math.round(ev.fee * 100) : undefined,
        cutoffMs: ev.cutoffMs || undefined,
        timeLimitMs: ev.timeLimitMs || undefined,
        roundSchedule: ev.roundSchedule?.map((rs) =>
          rs ? { ...rs, startTime: rs.startTime ? new Date(rs.startTime).toISOString() : undefined } : undefined,
        ),
      })) as Parameters<typeof createCompetition>[0]["events"],
    } as Parameters<typeof createCompetition>[0];
  }, [details, events]);

  const doAutoSave = useCallback(async () => {
    if (!title.trim()) return;
    setAutoSaveStatus("saving");
    try {
      if (!draftIdRef.current) {
        const { id } = await createCompetition(buildBody());
        draftIdRef.current = id;
      } else {
        await updateCompetition(draftIdRef.current, buildBody() as Parameters<typeof updateCompetition>[1]);
      }
      setAutoSaveStatus("saved");
    } catch {
      setAutoSaveStatus("error");
    }
  }, [title, buildBody]);

  useEffect(() => {
    if (!title.trim()) return;
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    setAutoSaveStatus("idle");
    autoSaveTimer.current = setTimeout(() => { doAutoSave(); }, 3000);
    return () => { if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current); };
  }, [title, description, rulesMd, ruleSetIds, type, baseFee, perEventFee, registrationOpensAt, registrationDeadline, startsAt, endsAt, events, featured, registrationLimit, doAutoSave]);

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (autoSaveTimer.current) {
        clearTimeout(autoSaveTimer.current);
        autoSaveTimer.current = null;
        doAutoSave();
      }
      if (autoSaveStatus === "idle" && title.trim()) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [doAutoSave, autoSaveStatus, title]);

  // Track which schedule fields the admin has manually set
  const userSetRef = useRef<Set<ScheduleField>>(new Set());
  /**
   * Round slots the admin typed by hand. The cascade leaves these alone and
   * recomputes everything else, so archiving an event closes the gap around
   * them rather than rewriting the whole day.
   */
  const roundPinnedRef = useRef<Set<string>>(new Set());

  // Cascade: derive all downstream fields that the user hasn't manually set.
  // changedField = the field the user just edited (anchor point).
  // All fields downstream of it that aren't in userSetRef get auto-derived.
  const cascade = useCallback(
    (
      changedField: ScheduleField,
      vals: { regOpens: string; regClose: string; compStart: string; compEnd: string },
      currentEvents: EventSpec[],
      gap: number,
      durOverrides: Record<string, number>,
    ): RoundSlot[][] | null => {
      const pinned = userSetRef.current;
      let roundSchedulesOut: RoundSlot[][] | null = null;

      // ── Forward cascade (downstream) ──

      // regOpens → regClose (+5 days)
      if (changedField === "regOpens" && vals.regOpens && !pinned.has("regClose")) {
        const d = new Date(new Date(vals.regOpens).getTime() + regDays * 86400000);
        vals.regClose = toLocalDatetime(d);
      }

      // regClose → compStart (same time) — only if compStart not pinned
      if ((changedField === "regOpens" || changedField === "regClose") && vals.regClose && !pinned.has("compStart")) {
        vals.compStart = vals.regClose;
      }

      // ── Backward cascade (upstream adjustments) ──

      // If compStart was set and it's before regClose, pull regClose back (if not pinned)
      if (changedField === "compStart" && vals.compStart && vals.regClose && !pinned.has("regClose")) {
        if (new Date(vals.compStart) < new Date(vals.regClose)) {
          vals.regClose = vals.compStart;
        }
      }

      // If regClose was set and it's before regOpens, pull regOpens back (if not pinned)
      if ((changedField === "regClose" || changedField === "compStart") && vals.regClose && vals.regOpens && !pinned.has("regOpens")) {
        if (new Date(vals.regClose) < new Date(vals.regOpens)) {
          vals.regOpens = vals.regClose;
          setRegistrationOpensAt(vals.regOpens);
        }
      }

      // ── Round schedules + compEnd (always recompute from compStart) ──

      if (vals.compStart && currentEvents.length > 0) {
        const { schedules, endsAt } = computeRoundSchedules(
          new Date(vals.compStart),
          currentEvents,
          gap,
          (type) => durOverrides[type] ?? FALLBACK_EVENT_DURATION[type] ?? FALLBACK_DURATION,
        );
        roundSchedulesOut = schedules;
        // compEnd always follows round schedules unless admin explicitly set it
        if (!pinned.has("compEnd")) {
          vals.compEnd = toLocalDatetime(endsAt);
        }
      }

      setRegistrationDeadline(vals.regClose);
      setStartsAt(vals.compStart);
      setEndsAt(vals.compEnd);
      return roundSchedulesOut;
    },
    [regDays],
  );

  const handleScheduleChange = (field: ScheduleField, value: string) => {
    userSetRef.current.add(field);
    const vals = {
      regOpens: field === "regOpens" ? value : registrationOpensAt,
      regClose: field === "regClose" ? value : registrationDeadline,
      compStart: field === "compStart" ? value : startsAt,
      compEnd: field === "compEnd" ? value : endsAt,
    };
    if (field === "regOpens") setRegistrationOpensAt(value);
    const schedules = cascade(field, vals, events, gapMinutes, durationOverrides);
    if (schedules) {
      setEvents((prev) =>
        prev.map((ev, i) => ({
          ...ev,
          roundSchedule: schedules[i] ?? ev.roundSchedule,
        })),
      );
    }
  };

  /** Unpin everything and re-derive the schedule from the registration open date. */
  const resetScheduleToAuto = useCallback(() => {
    userSetRef.current.clear();
    userSetRef.current.add("regOpens");
    roundPinnedRef.current.clear();
    if (!registrationOpensAt) return;
    const schedules = cascade(
      "regOpens",
      { regOpens: registrationOpensAt, regClose: "", compStart: "", compEnd: "" },
      events,
      gapMinutes,
      durationOverrides,
    );
    if (schedules) {
      setEvents((prev) =>
        prev.map((ev, i) => ({ ...ev, roundSchedule: schedules[i] ?? ev.roundSchedule })),
      );
    }
  }, [registrationOpensAt, cascade, events, gapMinutes, durationOverrides]);

  // Recalculate compEnd from the actual round schedule entries
  const recalcCompEnd = useCallback(
    (evts: EventSpec[]) => {
      if (!startsAt) return;
      let latest = new Date(startsAt);
      for (const ev of evts) {
        for (const rs of ev.roundSchedule ?? []) {
          if (rs?.startTime && rs.durationMinutes) {
            const end = new Date(new Date(rs.startTime).getTime() + rs.durationMinutes * 60000);
            if (end > latest) latest = end;
          }
        }
      }
      setEndsAt(toLocalDatetime(latest));
      userSetRef.current.delete("compEnd");
    },
    [startsAt],
  );

  // Re-cascade when events, gap, or durations change (recompute round schedules + compEnd)
  const recascadeRounds = useCallback(
    (newEvents: EventSpec[], gap: number, durOverrides: Record<string, number>) => {
      if (!startsAt || newEvents.length === 0) return;
      const { schedules, endsAt: newEnd } = computeRoundSchedules(
        new Date(startsAt),
        newEvents,
        gap,
        (type) => durOverrides[type] ?? FALLBACK_EVENT_DURATION[type] ?? FALLBACK_DURATION,
      );
      setEvents((prev) =>
        prev.map((ev, i) => {
          const computed = schedules[i];
          if (!computed) return ev;
          const merged = mergeRoundSlots(computed, ev.roundSchedule ?? [], (ri) =>
            roundPinnedRef.current.has(roundKey(i, ri)),
          );
          return { ...ev, roundSchedule: merged };
        }),
      );
      setEndsAt(toLocalDatetime(newEnd));
      userSetRef.current.delete("compEnd");
    },
    [startsAt],
  );

  const addEvent = () => {
    const next = [...events, { eventType: "333", roundCount: 1 }];
    setEvents(next);
    recascadeRounds(next, gapMinutes, durationOverrides);
  };
  const updateEvent = (i: number, patch: Partial<EventSpec>) => {
    const next = events.map((e, idx) => (idx === i ? { ...e, ...patch } : e));
    setEvents(next);
    if ("roundCount" in patch || "eventType" in patch || "archived" in patch) {
      recascadeRounds(next, gapMinutes, durationOverrides);
    } else if ("roundSchedule" in patch) {
      recalcCompEnd(next);
    }
  };

  /**
   * Drop an archived event from the form entirely.
   *
   * Nothing is saved yet on this screen, so deleting is simply removing it from
   * the list — and archive-then-delete is how you discard an event added by
   * mistake, since the rows themselves offer Archive rather than Remove.
   */
  const removeEvent = (i: number) => {
    const next = events.filter((_, idx) => idx !== i);
    setEvents(next);
    // Round pins are keyed by event index, so they no longer line up.
    roundPinnedRef.current.clear();
    recascadeRounds(next, gapMinutes, durationOverrides);
  };

  /** +/− on the event's first row. Rounds are clamped to the WCA range. */
  const changeRoundCount = (i: number, delta: number) => {
    const ev = events[i];
    if (!ev) return;
    const next = Math.max(MIN_ROUND_COUNT, Math.min(ev.roundCount + delta, MAX_ROUND_COUNT));
    if (next === ev.roundCount) return;
    updateEvent(i, { roundCount: next });
  };

  /**
   * Apply a row edit back onto the event's parallel per-round arrays.
   *
   * Create has no round records — a round is an index into these arrays, so a
   * change has to be written positionally rather than by id.
   */
  const applyRoundPatch = (
    eventIndex: number,
    roundIndex: number,
    patch: Partial<ScheduleRow>,
  ) => {
    const ev = events[eventIndex];
    if (!ev) return;

    /** Grow a sparse per-round array to the event's round count before writing. */
    const sized = <T,>(arr: (T | undefined)[] | undefined): (T | undefined)[] => {
      const out = [...(arr ?? [])];
      while (out.length < ev.roundCount) out.push(undefined);
      return out;
    };

    const next: Partial<EventSpec> = {};

    if (patch.startTime !== undefined || patch.durationMinutes !== undefined) {
      // Typing a time pins the slot so later recascades keep it.
      roundPinnedRef.current.add(roundKey(eventIndex, roundIndex));
      const schedule = sized<RoundSlot>(ev.roundSchedule);
      const slot = { ...(schedule[roundIndex] ?? {}) };
      if (patch.startTime !== undefined) slot.startTime = patch.startTime || undefined;
      if (patch.durationMinutes !== undefined) {
        slot.durationMinutes = patch.durationMinutes ? Number(patch.durationMinutes) : undefined;
      }
      schedule[roundIndex] = slot;
      next.roundSchedule = schedule;
    }

    if (patch.criteriaMethod !== undefined || patch.criteriaValue !== undefined) {
      const criteria = sized<AdvancementCriteria>(ev.roundCriteria);
      const method = patch.criteriaMethod ?? rowCriteriaMethod(criteria[roundIndex]);
      const raw = patch.criteriaValue ?? rowCriteriaValue(criteria[roundIndex]);
      criteria[roundIndex] = buildCriteria(method, raw);
      next.roundCriteria = criteria;
    }

    if (Object.keys(next).length > 0) updateEvent(eventIndex, next);
  };

  const onSubmit = async (status: "draft" | "published") => {
    if (!title.trim()) return;
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    setCreating(true);
    setError(null);
    setValidationErrors([]);
    try {
      const body = buildBody();
      let id = draftIdRef.current;
      if (!id) {
        const res = await createCompetition(body);
        id = res.id;
        draftIdRef.current = id;
      } else {
        await updateCompetition(id, body as Parameters<typeof updateCompetition>[1]);
      }
      // Upload images BEFORE the status change — the server requires a banner
      // to publish.
      if (bannerFile) await uploadCompetitionBanner(id, bannerFile);
      if (mobileBannerFile) await uploadCompetitionMobileBanner(id, mobileBannerFile);

      // `featured` now travels in the main body like every other field, so this
      // second call is only ever about publishing.
      if (status !== "draft") {
        await updateCompetition(id, { status } as Parameters<typeof updateCompetition>[1]);
      }
      router.push("/admin");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const jsonMatch = msg.match(/\{.*\}/s);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.errors && Array.isArray(parsed.errors)) {
            setValidationErrors(parsed.errors);
            setError(parsed.error ?? "Validation failed");
          } else if (parsed.error === "duplicate_title") {
            setError("A competition with this name already exists");
          } else {
            setError(parsed.error ?? msg);
          }
        } catch {
          setError(msg);
        }
      } else {
        setError(msg);
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="mx-auto max-w-[1400px] px-8 py-10">
      <h1 className="mb-6 text-2xl font-bold text-zinc-900 dark:text-zinc-100">
        Create Competition
      </h1>

      {error && (
        <div className="mb-4">
          <ErrorCard error={error} onRetry={() => setError(null)} onBack={false} />
          {validationErrors.length > 0 && (
            <ul className="mt-2 list-disc rounded-lg border border-zinc-200 bg-zinc-50 px-6 py-3 text-xs text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
              {validationErrors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="space-y-6">
        <CompetitionDetailsFields
          value={details}
          onChange={setDetails}
          errors={fieldErrors}
          ruleSets={ruleSets}
          imageSlot={
            <div className="grid gap-4 md:grid-cols-2">
              <ImagePicker
                label={FIELD_LABELS.desktopBanner}
                hint={IMAGE_HINTS.desktopBanner}
                file={bannerFile}
                onPick={setBannerFile}
              />
              <ImagePicker
                label={FIELD_LABELS.mobileBanner}
                hint={IMAGE_HINTS.mobileBanner}
                file={mobileBannerFile}
                onPick={setMobileBannerFile}
              />
            </div>
          }
        />

        <CompetitionScheduleFields
          value={details}
          errors={fieldErrors}
          onReset={resetScheduleToAuto}
          onChange={(patch) => {
            for (const [key, val] of Object.entries(patch)) {
              const field = SCHEDULE_KEY_TO_FIELD[key as keyof typeof SCHEDULE_KEY_TO_FIELD];
              if (field) handleScheduleChange(field, val as string);
            }
          }}
        />
        <p className="text-xs text-zinc-500">
          Dates auto-fill as you go. Override any field and everything downstream adjusts.
          Durations and gaps are configured in{" "}
          <a href="/admin/settings" className="text-emerald-400 hover:underline">System Settings</a>.
        </p>

        <RoundScheduleList
          rows={scheduleRows}
          isPaid={type === "paid"}
          takenEventTypes={events.map((e) => e.eventType)}
          onAddEvent={addEvent}
          onAddRound={(eventKey) => changeRoundCount(Number(eventKey), +1)}
          onRemoveRound={(eventKey) => changeRoundCount(Number(eventKey), -1)}
          onEventChange={(eventKey, patch) => {
            const i = Number(eventKey);
            const next: Partial<EventSpec> = {};
            if (patch.eventType !== undefined) next.eventType = patch.eventType;
            if (patch.fee !== undefined) next.fee = patch.fee ? Number(patch.fee) : undefined;
            if (patch.archived !== undefined) next.archived = patch.archived;
            updateEvent(i, next);
          }}
          onRoundChange={(row, patch) => applyRoundPatch(Number(row.eventKey), row.roundNumber - 1, patch)}
        />
        <ArchivedEventsList
          rows={archivedRows}
          onRestore={(key) => updateEvent(Number(key), { archived: false })}
          onDelete={(key) => removeEvent(Number(key))}
        />


        {/* Actions */}
        <div className="sticky bottom-0 z-10 -mx-6 flex items-center gap-3 border-t border-zinc-200 bg-white/95 px-6 py-4 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95">
          <button
            onClick={() => onSubmit("draft")}
            disabled={creating || !title.trim()}
            className="rounded-lg border border-zinc-300 px-5 py-2 text-sm font-semibold text-zinc-600 transition hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {creating ? "Saving…" : draftIdRef.current ? "Update Draft" : "Save as Draft"}
          </button>
          <button
            onClick={() => onSubmit("published")}
            disabled={creating || !title.trim()}
            className="rounded-lg bg-emerald-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
          >
            {creating ? "Publishing…" : "Publish"}
          </button>
          <span className="ml-auto text-xs text-zinc-400">
            {autoSaveStatus === "saving" && "Auto-saving…"}
            {autoSaveStatus === "saved" && "✓ Draft saved"}
            {autoSaveStatus === "error" && "Auto-save failed"}
          </span>
        </div>
      </div>
    </div>
  );
}
