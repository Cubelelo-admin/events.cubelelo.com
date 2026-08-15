"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { CompetitionDetailsFields } from "@/features/admin/competition/CompetitionDetailsFields";
import { shiftRoundsAroundEvent } from "@/features/admin/competition/schedule";
import { ArchivedEventsList } from "@/features/admin/competition/ArchivedEventsList";
import { ImageField } from "@/features/admin/competition/ImageField";
import {
  RoundScheduleList,
  type CriteriaMethod,
  type ScheduleRow,
} from "@/features/admin/competition/RoundScheduleList";
import {
  buildCompetitionPayload,
  competitionToDetailsValue,
} from "@/features/admin/competition/buildCompetitionPayload";
import {
  EMPTY_COMPETITION_DETAILS,
  FIELD_LABELS,
  IMAGE_HINTS,
  MAX_ROUND_COUNT,
  MIN_ROUND_COUNT,
  rupeesToPaise,
  validateCompetitionDetails,
  type CompetitionDetailsValue,
} from "@/features/admin/competition/competitionFields";
import {
  FORMAT_ATTEMPTS,
  FORMAT_CUTOFF_ATTEMPTS,
  FORMAT_RANKS_BY,
  type WcaFormat,
} from "@cubers/types";
import {
  assetUrl,
  removeParticipant,
  createPracticeEvent,
  downloadCertificatesZip,
  downloadCsvCertificates,
  exportCompetitionCSV,
  sendBulkEmail,
  fetchCompetition,
  fetchSchedulingDefaults,
  fetchRuleSets,
  updateCompetition,
  updateCompetitionEvent,
  deleteCompetitionEvent,
  uploadCompetitionBanner,
  uploadCompetitionMobileBanner,
  updateRound,
  type AdvancementCriteria,
  type CompetitionDetail,
  type EventDetail,
  type RoundRef,
  type SchedulingDefaults,
  type RuleSetDto,
  fetchAdminParticipants,
  type AdminParticipantEntry,
} from "@/lib/api";
import { EVENT_IDS } from "@cubers/scramble-core";
import { formatTime } from "@cubers/timer-core";
import { eventDisplayName } from "@/lib/eventNames";
import { EventIcon } from "@/components/EventIcon";
import { StatusBadge } from "./StatusBadge";
import { ConfirmModal, Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Countdown } from "@/components/Countdown";
import { ErrorCard } from "@/components/ui/ErrorCard";

// Only statuses that are manually set — the others are auto-computed from schedule
const MANUAL_STATUSES = ["draft", "published", "cancelled", "completed"];

/** Stored criteria → the row's method dropdown value. */
function rowCriteriaMethod(c: AdvancementCriteria | null | undefined): CriteriaMethod {
  return (c?.method as CriteriaMethod) ?? "none";
}

/** Stored criteria → the row's value input (rank as a count, others in seconds). */
function rowCriteriaValue(c: AdvancementCriteria | null | undefined): string {
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

/** A round's duration, derived from its open/close times when not stored. */
function roundDurationMinutes(r: RoundRef): string {
  if (r.durationMinutes) return String(r.durationMinutes);
  if (r.opensAt && r.closesAt) {
    const mins = Math.round((+new Date(r.closesAt) - +new Date(r.opensAt)) / 60_000);
    return mins > 0 ? String(mins) : "";
  }
  return "";
}

function toLocal(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function toISO(val: string): string | null {
  return val ? new Date(val).toISOString() : null;
}

type ScheduleField = "regOpens" | "regClose" | "compStart" | "compEnd";
const SCHEDULE_CHAIN: ScheduleField[] = ["regOpens", "regClose", "compStart", "compEnd"];
const REG_TO_COMP_DAYS = 5;

const DEFAULT_EVENT_DURATION: Record<string, number> = {
  "222": 15, "333": 20, "444": 25, "555": 30, "666": 35, "777": 40,
  pyram: 15, skewb: 15, minx: 30, "333oh": 20, "333bf": 25, sq1: 20,
  clock: 15, "444bf": 40, "555bf": 50, "333mbf": 60, fto: 25, "333fm": 60,
};
const DEFAULT_DURATION = 20;

function computeRoundTimes(
  compStart: Date,
  events: EventDetail[],
  gapMinutes: number,
  eventDurations: Record<string, number>,
  defaultDuration: number,
): { roundId: string; opensAt: string; durationMinutes: number }[] {
  // Archived events are not run, so they take no slot in the timeline.
  const active = events.filter((e) => !e.archived);
  if (active.length === 0) return [];
  const maxRounds = Math.max(...active.map((e) => e.roundCount));
  const result: { roundId: string; opensAt: string; durationMinutes: number }[] = [];

  for (let dayOffset = 0; dayOffset < maxRounds; dayOffset++) {
    const dayBase =
      dayOffset === 0
        ? new Date(compStart)
        : new Date(
            compStart.getFullYear(),
            compStart.getMonth(),
            compStart.getDate() + dayOffset,
            compStart.getHours(),
            compStart.getMinutes(),
          );

    let cursor = new Date(dayBase);

    for (const ev of active) {
      if (dayOffset >= ev.roundCount) continue;
      const round = ev.rounds.find((r) => r.roundNumber === dayOffset + 1);
      if (!round) continue;

      const dur = eventDurations[ev.eventType] ?? defaultDuration;

      result.push({
        roundId: round.id,
        opensAt: new Date(cursor).toISOString(),
        durationMinutes: dur,
      });

      cursor = new Date(cursor.getTime() + (dur + gapMinutes) * 60000);
    }
  }

  return result;
}

function cascadeSchedule(
  changedField: ScheduleField,
  vals: { regOpens: string; regClose: string; compStart: string; compEnd: string },
  pinned: Set<ScheduleField>,
  regDurationDays = REG_TO_COMP_DAYS,
) {
  // ── Forward cascade (downstream) ──

  if (changedField === "regOpens" && vals.regOpens && !pinned.has("regClose")) {
    const d = new Date(new Date(vals.regOpens).getTime() + regDurationDays * 86400000);
    vals.regClose = toLocal(d.toISOString());
  }

  if ((changedField === "regOpens" || changedField === "regClose") && vals.regClose && !pinned.has("compStart")) {
    vals.compStart = vals.regClose;
  }

  // compStart → compEnd: shift end by same delta, or default to compStart + 1 day
  if (
    (changedField === "regOpens" || changedField === "regClose" || changedField === "compStart") &&
    vals.compStart &&
    !pinned.has("compEnd")
  ) {
    if (vals.compEnd) {
      // Preserve the original duration between compStart and compEnd
      const oldStart = pinned.has("compStart") ? new Date(vals.compStart) : null;
      if (!oldStart) {
        // compStart was auto-cascaded — default compEnd to compStart + 1 day
        const d = new Date(new Date(vals.compStart).getTime() + 86400000);
        vals.compEnd = toLocal(d.toISOString());
      }
    } else {
      const d = new Date(new Date(vals.compStart).getTime() + 86400000);
      vals.compEnd = toLocal(d.toISOString());
    }
  }

  // ── Backward cascade (upstream adjustments) ──

  if (changedField === "compStart" && vals.compStart && vals.regClose && !pinned.has("regClose")) {
    if (new Date(vals.compStart) < new Date(vals.regClose)) {
      vals.regClose = vals.compStart;
    }
  }

  if ((changedField === "regClose" || changedField === "compStart") && vals.regClose && vals.regOpens && !pinned.has("regOpens")) {
    if (new Date(vals.regClose) < new Date(vals.regOpens)) {
      vals.regOpens = vals.regClose;
    }
  }
}

/**
 * Image field that uploads as soon as a file is chosen — the Manage screen's
 * behaviour, since the competition already exists.
 */
export function AdminCompetition({ id }: { id: string }) {
  const [detail, setDetail] = useState<CompetitionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [cancelModal, setCancelModal] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [publishModal, setPublishModal] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<EventDetail | null>(null);
  const [removeTarget, setRemoveTarget] = useState<AdminParticipantEntry | null>(null);

  // Competition-level form state, shared in shape with the Create screen.
  const [detailsForm, setDetailsForm] = useState<CompetitionDetailsValue>(EMPTY_COMPETITION_DETAILS);

  // Schedule editor local state — synced from detail on load
  const [regOpens, setRegOpens] = useState("");
  const [regCloses, setRegCloses] = useState("");
  const [compStarts, setCompStarts] = useState("");
  const [compEnds, setCompEnds] = useState("");
  // Track which schedule fields admin has manually edited in this session.
  // On load, all existing fields are pinned (from server). Editing a field
  // unpins everything downstream so cascade auto-fills them.
  const schedPinnedRef = useRef<Set<ScheduleField>>(new Set(SCHEDULE_CHAIN));
  const schedInitRef = useRef(false); // only sync schedule fields on first load
  const [schedDefaults, setSchedDefaults] = useState<SchedulingDefaults | null>(null);
  // Gap between events. There is no per-competition input for this — it comes
  // from System Settings and feeds the competition-start re-timing and the
  // gap-closing when an event is archived.
  const [gapMinutes, setGapMinutes] = useState(0);
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [showPracticeModal, setShowPracticeModal] = useState(false);
  const csvCertRef = useRef<HTMLInputElement>(null);
  const [ruleSets, setRuleSets] = useState<RuleSetDto[]>([]);
  const schedSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [adminParticipants, setAdminParticipants] = useState<AdminParticipantEntry[]>([]);
  const [participantsLoading, setParticipantsLoading] = useState(false);
  const [showParticipants, setShowParticipants] = useState(false);
  const [participantsError, setParticipantsError] = useState<string | null>(null);

  /** Shared by the Show toggle and by removal, so the table refreshes in place. */
  const loadParticipants = useCallback(async () => {
    setParticipantsLoading(true);
    setParticipantsError(null);
    try {
      const res = await fetchAdminParticipants(id);
      setAdminParticipants(res.participants);
    } catch (e) {
      console.error("Failed to fetch participants:", e);
      setParticipantsError(e instanceof Error ? e.message : String(e));
    }
    setParticipantsLoading(false);
  }, [id]);

  const load = useCallback(() => {
    fetchCompetition(id)
      .then(setDetail)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    fetchSchedulingDefaults()
      .then((s) => {
        setSchedDefaults(s);
        setGapMinutes(s.gapBetweenEventsMinutes);
      })
      .catch(() => {});
    fetchRuleSets().then(setRuleSets).catch(() => {});
  }, []);

  // The rule set is now a stored `ruleSetId` rather than being reverse-matched
  // from the saved markdown by content, which only worked while the text was
  // byte-identical to the rule set and never survived an edit.

  // Sync inputs whenever detail refreshes — schedule fields only on first load
  useEffect(() => {
    if (detail) {
      // Same hydration the Create screen's payload builder inverts, so a
      // competition made there round-trips into these inputs unchanged.
      setDetailsForm(competitionToDetailsValue(detail));
      if (!schedInitRef.current) {
        setRegOpens(toLocal(detail.registrationOpensAt));
        setRegCloses(toLocal(detail.registrationDeadline));
        setCompStarts(toLocal(detail.startsAt));
        setCompEnds(toLocal(detail.endsAt));
        schedInitRef.current = true;
      }
    }
  }, [detail]);

  /** Schedule fields live in their own state because the cascade drives them. */
  const details: CompetitionDetailsValue = useMemo(
    () => ({
      ...detailsForm,
      registrationOpensAt: regOpens,
      registrationDeadline: regCloses,
      startsAt: compStarts,
      endsAt: compEnds,
    }),
    [detailsForm, regOpens, regCloses, compStarts, compEnds],
  );

  const setDetails = useCallback((patch: Partial<CompetitionDetailsValue>) => {
    setDetailsForm((prev) => ({ ...prev, ...patch }));
  }, []);

  const fieldErrors = useMemo(() => validateCompetitionDetails(details), [details]);


  const dismissError = useCallback(() => {
    setError(null);
    setValidationErrors([]);
  }, []);

  const handleScheduleChange = useCallback(
    (field: ScheduleField, value: string) => {
      const pinned = schedPinnedRef.current;
      // Pin the changed field, unpin everything downstream
      pinned.add(field);
      const idx = SCHEDULE_CHAIN.indexOf(field);
      for (let i = idx + 1; i < SCHEDULE_CHAIN.length; i++) {
        pinned.delete(SCHEDULE_CHAIN[i]!);
      }

      const vals = {
        regOpens: field === "regOpens" ? value : regOpens,
        regClose: field === "regClose" ? value : regCloses,
        compStart: field === "compStart" ? value : compStarts,
        compEnd: field === "compEnd" ? value : compEnds,
      };

      const regDuration = schedDefaults?.registrationDurationDays ?? REG_TO_COMP_DAYS;
      cascadeSchedule(field, vals, pinned, regDuration);

      setRegOpens(vals.regOpens);
      setRegCloses(vals.regClose);
      setCompStarts(vals.compStart);
      setCompEnds(vals.compEnd);

      // Auto-recompute round times when compStart changes (directly or via cascade)
      const newCompStart = vals.compStart;
      const prevCompStart = compStarts;
      const compStartChanged = !!(newCompStart && newCompStart !== prevCompStart);

      // Debounced auto-save schedule to server (skip when recompute handles it)
      if (schedSaveTimer.current) clearTimeout(schedSaveTimer.current);
      if (!compStartChanged && detail) {
        schedSaveTimer.current = setTimeout(() => {
          updateCompetition(detail.id, {
            registrationOpensAt: toISO(vals.regOpens),
            registrationDeadline: toISO(vals.regClose),
            startsAt: toISO(vals.compStart),
            endsAt: toISO(vals.compEnd),
          }).catch(() => {});
        }, 800);
      }

      if (compStartChanged && detail) {
        const times = computeRoundTimes(
          new Date(newCompStart),
          detail.events,
          gapMinutes,
          schedDefaults?.eventDurations ?? DEFAULT_EVENT_DURATION,
          schedDefaults?.defaultRoundDurationMinutes ?? DEFAULT_DURATION,
        );
        // Update competition + rounds on server, then patch local detail to avoid load() race
        (async () => {
          try {
            let newEnd: string | undefined;
            if (times.length > 0) {
              const last = times[times.length - 1]!;
              newEnd = new Date(
                new Date(last.opensAt).getTime() + last.durationMinutes * 60000,
              ).toISOString();
            }
            await updateCompetition(detail.id, {
              registrationOpensAt: toISO(vals.regOpens),
              registrationDeadline: toISO(vals.regClose),
              startsAt: toISO(newCompStart)!,
              endsAt: newEnd ?? toISO(newCompStart)!,
            });
            if (newEnd) setCompEnds(toLocal(newEnd));

            for (const t of times) {
              const closesAt = new Date(
                new Date(t.opensAt).getTime() + t.durationMinutes * 60000,
              ).toISOString();
              await updateRound(t.roundId, { opensAt: t.opensAt, closesAt, durationMinutes: t.durationMinutes });
            }
            // Patch local detail instead of load() to avoid state race with user edits
            setDetail((prev) => {
              if (!prev) return prev;
              const updated = { ...prev, startsAt: toISO(newCompStart)!, endsAt: newEnd ?? toISO(newCompStart)! };
              updated.events = updated.events.map((ev) => ({
                ...ev,
                rounds: ev.rounds.map((r) => {
                  const match = times.find((t) => t.roundId === r.id);
                  if (!match) return r;
                  const closesAt = new Date(new Date(match.opensAt).getTime() + match.durationMinutes * 60000).toISOString();
                  return { ...r, opensAt: match.opensAt, closesAt, durationMinutes: match.durationMinutes };
                }),
              }));
              return updated;
            });
          } catch (e) {
            console.error("Auto-recompute round schedule failed:", e);
            setError(e instanceof Error ? e.message : String(e));
          }
        })();
      }
    },
    [regOpens, regCloses, compStarts, compEnds, schedDefaults, detail, gapMinutes, load],
  );

  const resetScheduleToAuto = useCallback(() => {
    schedPinnedRef.current = new Set<ScheduleField>(["regOpens"]);
    if (regOpens) {
      const vals = { regOpens, regClose: "", compStart: "", compEnd: "" };
      const regDuration = schedDefaults?.registrationDurationDays ?? REG_TO_COMP_DAYS;
      cascadeSchedule("regOpens", vals, schedPinnedRef.current, regDuration);
      setRegOpens(vals.regOpens);
      setRegCloses(vals.regClose);
      setCompStarts(vals.compStart);
      setCompEnds(vals.compEnd);
    }
  }, [regOpens, schedDefaults]);

  const run = useCallback(
    async (key: string, fn: () => Promise<unknown>) => {
      setBusy(key);
      setError(null);
      setValidationErrors([]);
      try {
        await fn();
        load();
      } catch (e) {
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
        setBusy(null);
      }
    },
    [load],
  );

  /**
   * The competition's rounds as one time-ordered schedule.
   *
   * Rounds without a start time sort last, grouped by event then round number,
   * so a partially-scheduled competition still reads sensibly.
   */
  const scheduleRows: ScheduleRow[] = useMemo(() => {
    if (!detail) return [];

    const rows = detail.events.filter((ev) => !ev.archived).flatMap((ev) =>
      ev.rounds.map((r) => ({
        key: r.id,
        eventKey: ev.id,
        eventType: ev.eventType,
        roundNumber: r.roundNumber,
        isFirstOfEvent: false, // set below, once sorted
        isLastOfEvent: r.roundNumber === ev.rounds.length,
        startTime: toLocal(r.opensAt),
        durationMinutes: roundDurationMinutes(r),
        criteriaMethod: rowCriteriaMethod(r.advancementCriteria),
        criteriaValue: rowCriteriaValue(r.advancementCriteria),
        fee: ev.fee != null ? String(ev.fee / 100) : "",
        eventOrder: detail.events.indexOf(ev),
      })),
    );

    rows.sort((a, b) => {
      if (a.startTime && b.startTime) return a.startTime.localeCompare(b.startTime);
      if (a.startTime) return -1;
      if (b.startTime) return 1;
      return a.eventOrder - b.eventOrder || a.roundNumber - b.roundNumber;
    });

    const seen = new Set<string>();
    for (const row of rows) {
      if (!seen.has(row.eventKey)) {
        row.isFirstOfEvent = true;
        seen.add(row.eventKey);
      }
    }
    return rows;
  }, [detail]);

  const archivedRows = useMemo(
    () =>
      (detail?.events ?? [])
        .filter((ev) => ev.archived)
        .map((ev) => ({ key: ev.id, eventType: ev.eventType, roundCount: ev.rounds.length })),
    [detail],
  );

  /** A round-level edit. Each field maps straight onto `PATCH /admin/rounds/:id`. */
  const handleRoundChange = useCallback(
    (row: ScheduleRow, patch: Partial<ScheduleRow>) => {
      const body: Parameters<typeof updateRound>[1] = {};

      if (patch.startTime !== undefined) {
        body.opensAt = toISO(patch.startTime);
        // Keep closesAt consistent with the duration already on the round.
        const mins = Number(patch.durationMinutes ?? row.durationMinutes);
        if (body.opensAt && mins > 0) {
          body.closesAt = new Date(new Date(body.opensAt).getTime() + mins * 60_000).toISOString();
        }
      }
      if (patch.durationMinutes !== undefined) {
        const mins = Number(patch.durationMinutes);
        if (mins > 0) {
          body.durationMinutes = mins;
          const opensAt = toISO(patch.startTime ?? row.startTime);
          if (opensAt) {
            body.closesAt = new Date(new Date(opensAt).getTime() + mins * 60_000).toISOString();
          }
        }
      }
      if (patch.criteriaMethod !== undefined || patch.criteriaValue !== undefined) {
        const method = patch.criteriaMethod ?? row.criteriaMethod;
        const raw = patch.criteriaValue ?? row.criteriaValue;
        body.advancementCriteria = buildCriteria(method, raw) ?? null;
      }

      if (Object.keys(body).length === 0) return;
      run(`round-${row.key}`, () => updateRound(row.key, body));
    },
    [run],
  );

  /** An event-level edit: type, fee, or archive. */
  const handleEventChange = useCallback(
    (eventKey: string, patch: { eventType?: string; fee?: string; archived?: boolean }) => {
      // Event type is immutable server-side once the event exists, so it is not
      // sent here — the picker is disabled for saved events.
      const body: Parameters<typeof updateCompetitionEvent>[1] = {};
      if (patch.fee !== undefined) body.fee = rupeesToPaise(patch.fee) ?? null;
      if (patch.archived !== undefined) body.archived = patch.archived;
      if (Object.keys(body).length === 0) return;

      // Archiving frees this event's slots, so the rest of the day closes up
      // behind it; restoring pushes them back out again.
      const shifts =
        patch.archived !== undefined && detail
          ? shiftRoundsAroundEvent(
              // Durations are resolved here — a round may store one, or only
              // imply it through its open and close times.
              detail.events.map((ev) => ({
                id: ev.id,
                archived: ev.archived,
                rounds: ev.rounds.map((r) => ({
                  id: r.id,
                  opensAt: r.opensAt,
                  durationMinutes: Number(roundDurationMinutes(r)) || 0,
                })),
              })),
              eventKey,
              patch.archived ? "archive" : "restore",
              gapMinutes,
            )
          : [];

      run(`event-${eventKey}`, async () => {
        await updateCompetitionEvent(eventKey, body);
        for (const s of shifts) {
          await updateRound(s.roundId, { opensAt: s.opensAt, closesAt: s.closesAt });
        }
      });
    },
    [detail, gapMinutes, run],
  );

  /**
   * +/− on the event's first row. Round count goes through the competition
   * PATCH, which reconciles the round rows — creating missing ones and deleting
   * excess ones that have no results.
   */
  const handleRoundCount = useCallback(
    (eventKey: string, delta: number) => {
      const ev = detail?.events.find((e) => e.id === eventKey);
      if (!ev) return;
      const next = Math.max(MIN_ROUND_COUNT, Math.min(ev.rounds.length + delta, MAX_ROUND_COUNT));
      if (next === ev.rounds.length) return;
      run(`rounds-${eventKey}`, () =>
        updateCompetition(id, { events: [{ eventType: ev.eventType, roundCount: next }] }),
      );
    },
    [detail, id, run],
  );

  /**
   * Adding an event writes it immediately with defaults, matching how the rest
   * of this screen saves as you go. The row then appears and is edited in place.
   */
  const handleAddEvent = useCallback(() => {
    const taken = new Set(detail?.events.map((e) => e.eventType) ?? []);
    const eventType = EVENT_IDS.find((eid) => !taken.has(eid));
    if (!eventType) return;
    run("addEvent", () =>
      updateCompetition(id, { events: [{ eventType, roundCount: 1 }] }),
    );
  }, [detail, id, run]);

  const handleCsvCertUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const text = reader.result as string;
        const lines = text.split(/\r?\n/).filter((l) => l.trim());
        if (lines.length < 2) {
          setError("CSV must have a header row and at least one data row");
          return;
        }
        const headers = lines[0]!.split(",").map((h) => h.trim().toLowerCase());
        const nameIdx = headers.indexOf("name");
        if (nameIdx === -1) {
          setError("CSV must have a 'name' column");
          return;
        }
        const clIdIdx = headers.indexOf("clid");
        const eventIdx = headers.indexOf("event");
        const rankIdx = headers.indexOf("rank");
        const bestIdx = headers.indexOf("bestsingle");
        const avgIdx = headers.indexOf("average");

        const winners = lines.slice(1).map((line) => {
          const cols = line.split(",").map((c) => c.trim());
          return {
            name: cols[nameIdx] ?? "",
            clId: clIdIdx >= 0 ? cols[clIdIdx] : undefined,
            event: eventIdx >= 0 ? cols[eventIdx] : undefined,
            rank: rankIdx >= 0 && cols[rankIdx] ? Number(cols[rankIdx]) : undefined,
            bestSingle: bestIdx >= 0 ? cols[bestIdx] : undefined,
            average: avgIdx >= 0 ? cols[avgIdx] : undefined,
          };
        }).filter((w) => w.name);

        if (winners.length === 0) {
          setError("No valid rows found in CSV");
          return;
        }
        run("csvCerts", () => downloadCsvCertificates(id, winners));
      };
      reader.readAsText(file);
      e.target.value = "";
    },
    [id, run],
  );

  if (error && !detail) {
    return (
      <div className="mx-auto max-w-[1400px] px-8 py-10">
        <Link href="/admin" className="text-emerald-500 hover:underline">
          ← Back
        </Link>
        <div className="mt-4">
          <ErrorCard error={error} onRetry={() => window.location.reload()} />
        </div>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="mx-auto max-w-[1400px] px-8 py-10">
        <p className="text-zinc-500">Loading…</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1400px] px-8 py-10">
      {/* ── Competition details banner ── */}
      <section className="mb-6 rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/30 p-6">
        <div className="mb-3 flex items-center justify-between">
          <Link
            href="/admin"
            className="text-xs text-zinc-500 transition hover:text-zinc-300"
          >
            ← All competitions
          </Link>
          <div className="flex items-center gap-2">
            <StatusBadge status={detail.status} />
            <button
              disabled={busy === "featured"}
              onClick={() =>
                run("featured", () =>
                  updateCompetition(id, { featured: !detail.featured }),
                )
              }
              className={`rounded px-2 py-1 text-xs font-medium transition ${
                detail.featured
                  ? "bg-amber-500/20 text-amber-400 hover:bg-amber-500/30"
                  : "bg-zinc-200 text-zinc-500 hover:bg-zinc-300 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"
              }`}
              title="Toggle featured status on homepage"
            >
              {detail.featured ? "★ Featured" : "☆ Feature"}
            </button>
          </div>
        </div>

        <h1 className="mb-1 text-2xl font-bold text-zinc-900 dark:text-zinc-100">{detail.title}</h1>

        {/* Events lead the first row; the registration count anchors its right edge. */}
        <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-2 text-sm text-zinc-600 dark:text-zinc-400">
          <span>
            {/* Archived events are not being run, so they do not belong in the
                summary — they remain visible in the schedule below, where they
                can be restored. */}
            <span className="text-zinc-400 dark:text-zinc-500">Events</span>{" "}
            {detail.events.filter((e) => !e.archived).map((e) => e.eventType).join(", ") || "—"}
          </span>
          <span><span className="text-zinc-400 dark:text-zinc-500">Registered</span> {detail.registrationCount ?? 0}{detail.registrationLimit != null && detail.registrationLimit > 0 ? `/${detail.registrationLimit}` : ""}</span>
        </div>

        {/* Second row: the remaining metadata, with the actions pushed right. */}
        <div className="mt-2 flex flex-wrap items-center gap-x-8 gap-y-2 text-sm text-zinc-600 dark:text-zinc-400">
          <span><span className="text-zinc-400 dark:text-zinc-500">Type</span> {detail.type}</span>
          {detail.publishedByName && (
            <span><span className="text-zinc-400 dark:text-zinc-500">Published by</span> {detail.publishedByName}</span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => setShowEmailModal(true)}
              className="rounded border border-zinc-300 px-3 py-1.5 text-xs font-semibold text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              Send Email
            </button>
            <button
              disabled={busy === "certs"}
              onClick={() => run("certs", () => downloadCertificatesZip(id))}
              className="rounded border border-zinc-300 px-3 py-1.5 text-xs font-semibold text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800 disabled:opacity-40"
            >
              {busy === "certs" ? "Generating…" : "Certificates"}
            </button>
            <input
              ref={csvCertRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={handleCsvCertUpload}
            />
            <button
              disabled={busy === "csvCerts"}
              onClick={() => csvCertRef.current?.click()}
              className="rounded border border-zinc-300 px-3 py-1.5 text-xs font-semibold text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800 disabled:opacity-40"
            >
              {busy === "csvCerts" ? "Generating…" : "CSV Certificates"}
            </button>
            <button
              disabled={busy === "export"}
              onClick={() => run("export", () => exportCompetitionCSV(id))}
              className="rounded border border-zinc-300 px-3 py-1.5 text-xs font-semibold text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800 disabled:opacity-40"
            >
              {busy === "export" ? "Exporting…" : "Export CSV"}
            </button>
            <button
              onClick={() => setShowPracticeModal(true)}
              className="rounded border border-emerald-800/50 px-3 py-1.5 text-xs font-semibold text-emerald-400 transition hover:bg-emerald-900/30"
            >
              Practice Event
            </button>
          </div>
        </div>

        {/* ── Details editor ── */}
        <div className="mt-5 rounded-lg border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/50 p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Details
          </h3>
          <CompetitionDetailsFields
            value={details}
            onChange={setDetails}
            errors={fieldErrors}
            ruleSets={ruleSets}
            canChangeType={detail.status === "draft"}
            globalVideoDeadlineMinutes={schedDefaults?.videoDeadlineMinutes}
            imageSlot={
              <div className="grid gap-4 md:grid-cols-2">
                <ImageField
                  label={FIELD_LABELS.desktopBanner}
                  hint={IMAGE_HINTS.desktopBanner}
                  currentUrl={detail.bannerUrl}
                  busy={busy === "banner"}
                  required
                  // Manage saves as you go, so a pick uploads straight away.
                  onPick={(f) => f && run("banner", () => uploadCompetitionBanner(id, f))}
                />
                <ImageField
                  label={FIELD_LABELS.mobileBanner}
                  hint={IMAGE_HINTS.mobileBanner}
                  currentUrl={detail.mobileBannerUrl}
                  busy={busy === "mobileBanner"}
                  onPick={(f) => f && run("mobileBanner", () => uploadCompetitionMobileBanner(id, f))}
                />
              </div>
            }
          />
        </div>

        {/* ── Schedule editor ── */}
        <div className="mt-5 rounded-lg border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/50 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
              Schedule
            </h3>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={resetScheduleToAuto}
                className="text-xs text-indigo-400 transition hover:text-indigo-300"
              >
                Reset to auto
              </button>
              <p className="text-xs text-zinc-600">
                Dates cascade as you edit
              </p>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {(
              [
                { label: "Registration opens", field: "regOpens" as ScheduleField, value: regOpens },
                { label: "Registration closes", field: "regClose" as ScheduleField, value: regCloses },
                { label: "Competition starts", field: "compStart" as ScheduleField, value: compStarts },
                { label: "Competition ends", field: "compEnd" as ScheduleField, value: compEnds },
              ] as const
            ).map(({ label, field, value }) => (
              <div key={field}>
                <label className="mb-1 flex items-center gap-1.5 text-xs text-zinc-500">
                  {label}
                  {field !== "regOpens" && !schedPinnedRef.current.has(field) && value && (
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500">
                      auto
                    </span>
                  )}
                </label>
                <input
                  type="datetime-local"
                  value={value}
                  onChange={(e) => handleScheduleChange(field, e.target.value)}
                  className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                />
              </div>
            ))}
          </div>
        </div>

        <div className="mt-5">
          <RoundScheduleList
            rows={scheduleRows}
            isPaid={detail.type !== "free"}
            takenEventTypes={detail.events.map((e) => e.eventType)}
            onAddEvent={handleAddEvent}
            onAddRound={(eventKey) => handleRoundCount(eventKey, +1)}
            onRemoveRound={(eventKey) => handleRoundCount(eventKey, -1)}
            onEventChange={handleEventChange}
            onRoundChange={handleRoundChange}
          />
          <ArchivedEventsList
            rows={archivedRows}
            onRestore={(key) => handleEventChange(key, { archived: false })}
            onDelete={(key) => {
              const ev = detail.events.find((e) => e.id === key);
              if (ev) setDeleteTarget(ev);
            }}
          />
        </div>
      </section>

      {/* ── Participants section ── */}
      <section className="mb-6">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Participants</h3>
          <div className="flex gap-2">
            {showParticipants && adminParticipants.length > 0 && (
              <button
                onClick={() => {
                  const header = "CL ID,Name,Email,Phone,Events,Payment Status,Amount,Registered";
                  const rows = adminParticipants.map((p) =>
                    [
                      p.clId,
                      `"${p.name}"`,
                      p.email,
                      p.mobileNo ?? "",
                      `"${p.eventTypes.join(", ")}"`,
                      p.paymentStatus,
                      `₹${(p.paymentAmount / 100).toFixed(2)}`,
                      new Date(p.registeredAt).toLocaleDateString(),
                    ].join(",")
                  );
                  const csv = [header, ...rows].join("\n");
                  const blob = new Blob([csv], { type: "text/csv" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `participants-${detail.title.replace(/\s+/g, "-")}-${new Date().toISOString().slice(0, 10)}.csv`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
                className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                ↓ Export CSV
              </button>
            )}
            <button
              onClick={async () => {
                if (!showParticipants) await loadParticipants();
                setShowParticipants((v) => !v);
              }}
              className="w-[90px] text-xs font-medium text-emerald-600 hover:text-emerald-500 dark:text-emerald-400 dark:hover:text-emerald-300"
            >
              {showParticipants ? "▲ Hide" : "▼ Show"} ({detail.registrationCount ?? 0})
            </button>
          </div>
        </div>
        {showParticipants && (
          participantsLoading ? (
            <p className="text-sm text-zinc-500">Loading participants…</p>
          ) : participantsError ? (
            <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-6 text-center text-sm text-red-600 dark:border-red-800 dark:bg-red-900/30 dark:text-red-400">
              Error loading participants: {participantsError}
            </p>
          ) : adminParticipants.length === 0 ? (
            <p className="rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-6 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/30">
              No participants registered yet.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/60 text-left text-[11px] uppercase tracking-wider text-zinc-500">
                    <th className="px-4 py-3">Name</th>
                    <th className="px-4 py-3">CL ID</th>
                    <th className="px-4 py-3">Email</th>
                    <th className="px-4 py-3">Phone</th>
                    <th className="px-4 py-3">Events</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Payment</th>
                    <th className="px-4 py-3 text-right">Amount</th>
                    <th className="px-4 py-3">Razorpay</th>
                    <th className="px-4 py-3">Registered</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {adminParticipants.map((p) => (
                    <tr
                      key={p.userId}
                      className={`border-b border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800/50 dark:hover:bg-zinc-900/40 ${
                        p.status === "active" ? "" : "opacity-50"
                      }`}
                    >
                      <td className="px-4 py-2.5 font-medium text-zinc-800 dark:text-zinc-200">{p.name}</td>
                      <td className="px-4 py-2.5 font-mono text-xs text-emerald-500">{p.clId}</td>
                      <td className="px-4 py-2.5 text-zinc-500">{p.email}</td>
                      <td className="px-4 py-2.5 text-zinc-500">{p.mobileNo ?? "—"}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          {p.eventTypes.map((et) => (
                            <span key={et} className="rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">{et}</span>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          p.status === "active"
                            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400"
                            : "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                        }`}>
                          {p.status}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          p.paymentStatus === "paid"
                            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400"
                            : p.paymentStatus === "pending"
                              ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                              : "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                        }`}>
                          {p.paymentStatus.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-zinc-700 dark:text-zinc-300">
                        {p.paymentAmount ? `₹${(p.paymentAmount / 100).toFixed(0)}` : "—"}
                      </td>
                      {/* The refund is issued by hand, so the ids have to be here. */}
                      <td
                        className="max-w-[10rem] truncate px-4 py-2.5 font-mono text-[11px] text-zinc-500"
                        title={[p.razorpayOrderId, p.razorpayPaymentId].filter(Boolean).join(" / ")}
                      >
                        {p.razorpayPaymentId ?? p.razorpayOrderId ?? "—"}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-zinc-500">
                        {new Date(p.registeredAt).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {p.status === "active" && (
                          <button
                            type="button"
                            onClick={() => setRemoveTarget(p)}
                            className="text-xs text-zinc-400 transition hover:text-red-400"
                          >
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </section>

      {/* ── Bottom action bar ── */}
      <div className="sticky bottom-0 z-20 -mx-8 mt-6 border-t border-zinc-200 bg-white/90 px-8 py-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90">
        <div className="mx-auto flex max-w-[1400px] items-center justify-end gap-3">
          <button
            disabled={busy === "details"}
            onClick={() =>
              run("details", async () => {
                // Identical body to the Create screen's, from the shared builder.
                await updateCompetition(
                  id,
                  buildCompetitionPayload(details) as Parameters<typeof updateCompetition>[1],
                );
                // Images auto-upload on file selection — no need to re-upload here
              })
            }
            className="rounded-lg bg-emerald-700 px-5 py-2 text-sm font-semibold text-white transition hover:bg-emerald-600 disabled:opacity-50"
          >
            {busy === "details" ? "Saving…" : "Save"}
          </button>
          {(detail.status === "draft") && (
            <button
              disabled={busy === "status"}
              onClick={() => setPublishModal(true)}
              className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
            >
              Publish
            </button>
          )}
          {(detail.status === "published" || detail.status === "registration_open" || detail.status === "live") && (
            <button
              disabled={busy === "status"}
              onClick={() => { setCancelReason(""); setCancelModal(true); }}
              className="rounded-lg bg-red-700 px-5 py-2 text-sm font-semibold text-white transition hover:bg-red-600 disabled:opacity-50"
            >
              Cancel Competition
            </button>
          )}
        </div>
      </div>

      {/* ── Bulk Email Modal ── */}
      {showEmailModal && (
        <BulkEmailModal
          competitionId={id}
          onClose={() => setShowEmailModal(false)}
        />
      )}

      {/* ── Practice Event Modal ── */}
      {showPracticeModal && (
        <PracticeEventModal
          competitionId={id}
          onClose={() => setShowPracticeModal(false)}
        />
      )}

      <Modal open={cancelModal} onClose={() => setCancelModal(false)} title="Cancel Competition" size="md">
        <CancelConsequences status={detail.status} title={detail.title} />
        <div className="mb-4">
          <label className="mb-1 block text-xs text-zinc-500">Reason for cancellation *</label>
          <textarea
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            placeholder="e.g., Insufficient registrations, scheduling conflict…"
            rows={2}
            className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setCancelModal(false)}>Go Back</Button>
          <Button
            variant="destructive"
            disabled={!cancelReason.trim()}
            loading={busy === "status"}
            onClick={() => {
              setCancelModal(false);
              run("status", () =>
                updateCompetition(id, { status: "cancelled", cancellationReason: cancelReason.trim() }),
              );
            }}
          >
            Cancel Competition
          </Button>
        </div>
      </Modal>

      <Modal open={publishModal} onClose={() => setPublishModal(false)} title="Publish Competition" size="md">
        <p className="mb-2 text-sm text-zinc-300">
          You are about to publish <strong>{detail.title}</strong>.
        </p>
        <ul className="mb-4 list-disc pl-5 text-xs text-zinc-400 space-y-1">
          <li>The competition will become visible to all users.</li>
          <li>Registration will open according to the schedule.</li>
          <li>Make sure all event details and schedule are finalized.</li>
        </ul>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setPublishModal(false)}>Go Back</Button>
          <Button
            loading={busy === "status"}
            onClick={() => {
              setPublishModal(false);
              run("status", () => updateCompetition(id, { status: "published" }));
            }}
          >
            Publish
          </Button>
        </div>
      </Modal>

      <Modal open={!!error} onClose={dismissError} title="Something Went Wrong" size="sm">
        <div className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
          {validationErrors.length > 0 ? (
            <ul className="list-disc pl-5 space-y-1">
              {validationErrors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          ) : (
            <p>{error?.replace(/_/g, " ")}</p>
          )}
        </div>
        <div className="flex justify-end">
          <Button variant="secondary" onClick={dismissError}>Dismiss</Button>
        </div>
      </Modal>

      <ConfirmModal
        open={!!removeTarget}
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => {
          if (!removeTarget) return;
          const target = removeTarget;
          setRemoveTarget(null);
          run(`remove-${target.registrationId}`, async () => {
            await removeParticipant(id, target.registrationId);
            await loadParticipants();
          });
        }}
        title="Remove Participant"
        description={
          <>
            Remove <strong>{removeTarget?.name}</strong> from this competition? Their slot is freed
            and they stop appearing as a participant. The registration is kept on record, and this
            is refused if they have already submitted results.
          </>
        }
        confirmLabel="Remove"
      />

      <ConfirmModal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (!deleteTarget) return;
          setDeleteTarget(null);
          run(`delete-${deleteTarget.id}`, () => deleteCompetitionEvent(deleteTarget.id));
        }}
        title="Delete Event"
        description={
          <>
            Permanently delete{" "}
            <strong>{deleteTarget ? eventDisplayName(deleteTarget.eventType) : ""}</strong> and its{" "}
            {deleteTarget?.rounds.length ?? 0} round(s)? This cannot be undone — leave it archived
            if you only want it off the schedule.
          </>
        }
        confirmLabel="Delete"
      />

    </div>
  );
}

/* ── Event row with inline fee editor ── */


function BulkEmailModal({
  competitionId,
  onClose,
}: {
  competitionId: string;
  onClose: () => void;
}) {
  const [subject, setSubject] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{
    sent: boolean;
    message: string;
    recipientCount: number;
    recipients: string[];
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [csvRecipients, setCsvRecipients] = useState<Array<{ email: string; name: string }>>([]);
  const [csvFileName, setCsvFileName] = useState<string | null>(null);
  const csvRef = useRef<HTMLInputElement>(null);

  const handleCsvUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length < 2) {
        setErr("CSV must have a header row and at least one data row");
        return;
      }
      const headers = lines[0]!.split(",").map((h) => h.trim().toLowerCase());
      const emailIdx = headers.indexOf("email");
      const nameIdx = headers.indexOf("name");
      if (emailIdx === -1) {
        setErr("CSV must have an 'email' column");
        return;
      }
      const parsed = lines.slice(1).map((line) => {
        const cols = line.split(",").map((c) => c.trim());
        return {
          email: cols[emailIdx] ?? "",
          name: nameIdx >= 0 ? (cols[nameIdx] ?? "") : "",
        };
      }).filter((r) => r.email);

      if (parsed.length === 0) {
        setErr("No valid email rows found in CSV");
        return;
      }
      setCsvRecipients(parsed);
      setCsvFileName(file.name);
      setErr(null);
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleSend = async () => {
    setSending(true);
    setErr(null);
    try {
      const body: { subject: string; bodyHtml: string; recipients?: Array<{ email: string; name: string }> } = {
        subject,
        bodyHtml,
      };
      if (csvRecipients.length > 0) body.recipients = csvRecipients;
      const res = await sendBulkEmail(competitionId, body);
      setResult(res);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-xl border border-zinc-200 bg-white p-6 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">Send Bulk Email</h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300">
            ✕
          </button>
        </div>

        {result ? (
          <div className="space-y-3">
            <div className="rounded-lg border border-emerald-800 bg-emerald-950/30 p-4">
              <p className="text-sm text-emerald-300">{result.message}</p>
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                {result.recipientCount} recipient{result.recipientCount !== 1 ? "s" : ""}
              </p>
            </div>
            <button
              onClick={onClose}
              className="w-full rounded-lg bg-zinc-800 py-2 text-sm font-semibold text-white transition hover:bg-zinc-700 dark:bg-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-600"
            >
              Close
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-xs text-zinc-500">Recipients</label>
              <div className="flex items-center gap-2">
                <input
                  ref={csvRef}
                  type="file"
                  accept=".csv"
                  className="hidden"
                  onChange={handleCsvUpload}
                />
                <button
                  type="button"
                  onClick={() => csvRef.current?.click()}
                  className="rounded border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600 transition hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  Upload CSV
                </button>
                {csvFileName ? (
                  <span className="flex items-center gap-1 text-xs text-emerald-400">
                    {csvFileName} ({csvRecipients.length} recipients)
                    <button
                      type="button"
                      onClick={() => { setCsvRecipients([]); setCsvFileName(null); }}
                      className="ml-1 text-zinc-500 hover:text-zinc-300"
                    >
                      ✕
                    </button>
                  </span>
                ) : (
                  <span className="text-xs text-zinc-500">
                    All registrants (default)
                  </span>
                )}
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-500">Subject</label>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="e.g. Round 1 results are out!"
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-600"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-500">
                Body (HTML supported)
              </label>
              <textarea
                value={bodyHtml}
                onChange={(e) => setBodyHtml(e.target.value)}
                rows={6}
                placeholder="Write your email content here..."
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-600"
              />
            </div>
            {err && <div className="rounded bg-red-100 px-4 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">{err}</div>}
            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="flex-1 rounded-lg border border-zinc-300 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                disabled={sending || !subject.trim() || !bodyHtml.trim()}
                onClick={handleSend}
                className="flex-1 rounded-lg bg-emerald-600 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-40"
              >
                {sending
                  ? "Sending…"
                  : csvRecipients.length > 0
                    ? `Send to ${csvRecipients.length} CSV Recipients`
                    : "Send to All Registrants"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Round row with inline schedule editor ── */


function PracticeEventModal({
  competitionId,
  onClose,
}: {
  competitionId: string;
  onClose: () => void;
}) {
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<{ id: string; title: string; participantsCopied: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const handleCreate = async () => {
    setCreating(true);
    setErr(null);
    try {
      const res = await createPracticeEvent(competitionId, {
        startsAt: startsAt ? new Date(startsAt).toISOString() : undefined,
        endsAt: endsAt ? new Date(endsAt).toISOString() : undefined,
      });
      setResult(res);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-6 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
        <h3 className="mb-4 text-lg font-bold text-zinc-900 dark:text-zinc-100">Create Practice Event</h3>
        <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
          Creates a practice competition with all registered participants automatically added.
        </p>

        {result ? (
          <div className="space-y-3">
            <div className="rounded bg-emerald-900/30 px-4 py-3 text-sm text-emerald-300">
              Created &ldquo;{result.title}&rdquo; with {result.participantsCopied} participants.
            </div>
            <div className="flex justify-end gap-2">
              <a
                href={`/admin/competitions/${result.id}`}
                className="rounded bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500"
              >
                Open Practice Event
              </a>
              <button
                onClick={onClose}
                className="rounded border border-zinc-300 px-4 py-2 text-sm text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Close
              </button>
            </div>
          </div>
        ) : (
          <>
            {err && <div className="mb-3 rounded bg-red-900/30 px-4 py-2 text-sm text-red-300">{err}</div>}
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">Starts At</label>
                <input
                  type="datetime-local"
                  value={startsAt}
                  onChange={(e) => setStartsAt(e.target.value)}
                  className="w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">Ends At</label>
                <input
                  type="datetime-local"
                  value={endsAt}
                  onChange={(e) => setEndsAt(e.target.value)}
                  className="w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={onClose}
                className="rounded border border-zinc-300 px-4 py-2 text-sm text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                disabled={creating}
                onClick={handleCreate}
                className="rounded bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-40"
              >
                {creating ? "Creating…" : "Create Practice Event"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ── Flagged result card ── */

function formatSolve(solve: { time_ms: number; inspectionPenalty?: string; penalty: string }) {
  const insp = solve.inspectionPenalty ?? "none";
  const base = formatTime(solve.time_ms);
  if (insp === "dnf" || solve.penalty === "dnf") return `DNF(${base})`;
  let extra = 0;
  if (insp === "plus2") extra += 2000;
  if (solve.penalty === "plus2") extra += 2000;
  if (extra > 0) return `${formatTime(solve.time_ms + extra)}+`;
  return base;
}

function CancelConsequences({ status, title }: { status: string; title: string }) {
  const map: Record<string, string[]> = {
    draft: [
      "Competition will be marked as cancelled.",
      "No users are affected — it was never published.",
    ],
    published: [
      "Competition will be removed from the public listing.",
      "No registrations have opened yet, so no users are directly affected.",
    ],
    upcoming: [
      "Competition will be removed from the public listing.",
      "No registrations have opened yet, so no users are directly affected.",
    ],
    registration_open: [
      "Registration will close immediately.",
      "All registered participants will see the competition as cancelled.",
      "Paid registrations may need manual refunds.",
    ],
    registration_closed: [
      "All registered participants will see the competition as cancelled.",
      "Paid registrations may need manual refunds.",
    ],
    live: [
      "The competition will stop immediately for all participants.",
      "Active rounds will be frozen — no more submissions accepted.",
      "Existing results will be preserved but the competition won't be finalized.",
      "Paid registrations may need manual refunds.",
    ],
    results_pending: [
      "Results will not be finalized or published.",
      "Rankings will not be updated from this competition.",
      "Existing submissions are preserved but won't count.",
    ],
    completed: [
      "Competition will be marked as cancelled retroactively.",
      "Published results and rankings may become invalid.",
      "This is unusual — consider whether this is truly necessary.",
    ],
  };
  const items = map[status] ?? ["Competition will be marked as cancelled."];

  return (
    <>
      <p className="mb-1 text-xs text-zinc-500">
        Cancelling <span className="font-medium text-zinc-300">&ldquo;{title}&rdquo;</span>
        {" "}(currently <span className="font-medium text-amber-400">{status.replace(/_/g, " ")}</span>)
      </p>
      <div className="my-3 rounded-lg border border-amber-800/30 bg-amber-950/20 p-3">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-amber-400">What will happen</p>
        <ul className="space-y-1">
          {items.map((c, i) => (
            <li key={i} className="flex gap-2 text-xs text-zinc-400">
              <span className="mt-0.5 text-amber-500">•</span>
              <span>{c}</span>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
