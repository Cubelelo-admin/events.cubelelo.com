"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  cancelRound,
  createPracticeEvent,
  downloadCertificatesZip,
  downloadCsvCertificates,
  exportCompetitionCSV,
  sendBulkEmail,
  sendRoundNotification,
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
  const maxRounds = Math.max(...events.map((e) => e.roundCount));
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

    for (const ev of events) {
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

export function AdminCompetition({ id }: { id: string }) {
  const [detail, setDetail] = useState<CompetitionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [cancelModal, setCancelModal] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [publishModal, setPublishModal] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<EventDetail | null>(null);

  // Detail editor local state
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editRules, setEditRules] = useState("");
  const [editBaseFee, setEditBaseFee] = useState("");
  const [editPerEventFee, setEditPerEventFee] = useState("");
  const [editRegLimit, setEditRegLimit] = useState("");
  const [bannerFile, setBannerFile] = useState<File | null>(null);
  const [mobileBannerFile, setMobileBannerFile] = useState<File | null>(null);

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
  const [gapMinutes, setGapMinutes] = useState(0);
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [showPracticeModal, setShowPracticeModal] = useState(false);
  const csvCertRef = useRef<HTMLInputElement>(null);
  const [ruleSets, setRuleSets] = useState<RuleSetDto[]>([]);
  const [selectedRuleSetIds, setSelectedRuleSetIds] = useState<string[]>([]);
  const [showRuleDropdown, setShowRuleDropdown] = useState(false);
  const schedSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [adminParticipants, setAdminParticipants] = useState<AdminParticipantEntry[]>([]);
  const [participantsLoading, setParticipantsLoading] = useState(false);
  const [showParticipants, setShowParticipants] = useState(false);
  const [participantsError, setParticipantsError] = useState<string | null>(null);
  const [showAddEvent, setShowAddEvent] = useState(false);
  const [newEventType, setNewEventType] = useState("333");
  const [newRoundCount, setNewRoundCount] = useState(1);
  const [newCutoffMs, setNewCutoffMs] = useState("");
  const [newTimeLimitMs, setNewTimeLimitMs] = useState("");
  const [newEventFee, setNewEventFee] = useState("");

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

  // Restore selectedRuleSetIds from saved rulesMd by matching content
  useEffect(() => {
    if (!detail?.rulesMd || ruleSets.length === 0) return;
    const saved = detail.rulesMd.trim();
    if (!saved) return;
    // Split by --- separator and match each chunk to a rule set
    const chunks = saved.split(/\n\n---\n\n/).map((c) => c.trim());
    const matched: string[] = [];
    for (const rs of ruleSets) {
      const rsTrimmed = rs.content.trim();
      if (chunks.some((ch) => ch === rsTrimmed)) {
        matched.push(rs.id);
      }
    }
    if (matched.length > 0) setSelectedRuleSetIds(matched);
  }, [detail?.rulesMd, ruleSets]);

  // Sync inputs whenever detail refreshes — schedule fields only on first load
  useEffect(() => {
    if (detail) {
      setEditTitle(detail.title);
      setEditDescription(detail.description ?? "");
      setEditRules(detail.rulesMd ?? "");
      setEditBaseFee(detail.baseFee ? String(detail.baseFee / 100) : "");
      setEditPerEventFee(String((detail.perEventFee ?? 0) / 100));
      setEditRegLimit(detail.registrationLimit ? String(detail.registrationLimit) : "");
      setBannerFile(null);
      setMobileBannerFile(null);
      if (!schedInitRef.current) {
        setRegOpens(toLocal(detail.registrationOpensAt));
        setRegCloses(toLocal(detail.registrationDeadline));
        setCompStarts(toLocal(detail.startsAt));
        setCompEnds(toLocal(detail.endsAt));
        schedInitRef.current = true;
      }
    }
  }, [detail]);

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

        <div className="flex flex-wrap items-center gap-x-8 gap-y-2 text-sm text-zinc-600 dark:text-zinc-400">
          <span><span className="text-zinc-400 dark:text-zinc-500">Type</span> {detail.type}</span>
          <span>
            <span className="text-zinc-400 dark:text-zinc-500">Events</span>{" "}
            {detail.events.map((e) => e.eventType).join(", ")}
          </span>
          <span><span className="text-zinc-400 dark:text-zinc-500">Registered</span> {detail.registrationCount ?? 0}{detail.registrationLimit != null && detail.registrationLimit > 0 ? `/${detail.registrationLimit}` : ""}</span>
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
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs text-zinc-500">Title</label>
              <input
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs text-zinc-500">Description</label>
              <textarea
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                rows={3}
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs text-zinc-500">Rules</label>
              {/* Rule sets container — chips + add more */}
              {ruleSets.length > 0 && (
                <div className="mb-2 rounded-lg border border-zinc-300 bg-white px-3 py-2.5 dark:border-zinc-700 dark:bg-zinc-900">
                  {selectedRuleSetIds.length > 0 ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {selectedRuleSetIds.map((rsId) => {
                        const rs = ruleSets.find((r) => r.id === rsId);
                        return (
                          <span key={rsId} className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
                            {rs?.name ?? rsId}
                            <button
                              type="button"
                              onClick={() => {
                                const remaining = selectedRuleSetIds.filter((id) => id !== rsId);
                                setSelectedRuleSetIds(remaining);
                                setEditRules(remaining.map((id) => ruleSets.find((r) => r.id === id)?.content ?? "").join("\n\n---\n\n"));
                              }}
                              className="ml-0.5 rounded-full p-0.5 text-emerald-600 transition hover:bg-emerald-200 hover:text-emerald-900 dark:text-emerald-400 dark:hover:bg-emerald-800 dark:hover:text-emerald-200"
                              aria-label={`Remove ${rs?.name}`}
                            >
                              ✕
                            </button>
                          </span>
                        );
                      })}
                      {/* Show "Add More" only if there are remaining rule sets */}
                      {ruleSets.filter((rs) => !selectedRuleSetIds.includes(rs.id)).length > 0 && (
                        <button
                          type="button"
                          onClick={() => setShowRuleDropdown((v) => !v)}
                          className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-zinc-400 px-2.5 py-1 text-xs font-medium text-zinc-600 transition hover:border-emerald-500 hover:text-emerald-600 dark:border-zinc-600 dark:text-zinc-400 dark:hover:border-emerald-500 dark:hover:text-emerald-400"
                        >
                          + Add More
                        </button>
                      )}
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setShowRuleDropdown((v) => !v)}
                      className="text-sm text-zinc-500 transition hover:text-emerald-600 dark:text-zinc-400 dark:hover:text-emerald-400"
                    >
                      + Select rule sets
                    </button>
                  )}
                  {/* Dropdown shown only when toggled */}
                  {showRuleDropdown && (
                    <select
                      value=""
                      onChange={(e) => {
                        const rsId = e.target.value;
                        if (!rsId || selectedRuleSetIds.includes(rsId)) return;
                        const next = [...selectedRuleSetIds, rsId];
                        setSelectedRuleSetIds(next);
                        setEditRules(next.map((id) => ruleSets.find((r) => r.id === id)?.content ?? "").join("\n\n---\n\n"));
                        // Auto-hide if no more remaining
                        if (ruleSets.filter((rs) => !next.includes(rs.id)).length === 0) {
                          setShowRuleDropdown(false);
                        }
                      }}
                      className="mt-2 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-900 focus:border-emerald-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                    >
                      <option value="">— Select a rule set —</option>
                      {ruleSets.filter((rs) => !selectedRuleSetIds.includes(rs.id)).map((rs) => (
                        <option key={rs.id} value={rs.id}>{rs.name}</option>
                      ))}
                    </select>
                  )}
                </div>
              )}
              <textarea
                value={editRules}
                onChange={(e) => setEditRules(e.target.value)}
                rows={6}
                placeholder={selectedRuleSetIds.length > 0 ? "Rules loaded from selected sets. Edit below to customize." : "Write custom rules (Markdown)..."}
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-600"
              />
            </div>
            {detail.type !== "free" && (
              <>
                <div>
                  <label className="mb-1 block text-xs text-zinc-500">Base Fee (INR)</label>
                  <input
                    type="number"
                    min={0}
                    value={editBaseFee}
                    onChange={(e) => setEditBaseFee(e.target.value)}
                    className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-zinc-500">Per-Event Fee (INR)</label>
                  <input
                    type="number"
                    min={0}
                    value={editPerEventFee}
                    onChange={(e) => setEditPerEventFee(e.target.value)}
                    className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                  />
                </div>
              </>
            )}
            <div>
              <label className="mb-1 block text-xs text-zinc-500">Desktop Banner <span className="text-zinc-400 dark:text-zinc-500">(1200×400 recommended)</span></label>
              {detail.bannerUrl && !bannerFile && (
                <div className="mb-2">
                  <img src={detail.bannerUrl} alt="Current desktop banner" className="h-16 rounded-lg object-cover" />
                  <p className="mt-1 text-xs text-zinc-500">Current — upload a new one to replace</p>
                </div>
              )}
              {busy === "banner" && <p className="mb-1 text-xs text-amber-500">Uploading…</p>}
              {bannerFile && <p className="mb-1 text-xs text-emerald-500">Uploaded: {bannerFile.name}</p>}
              <input
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                onChange={(e) => {
                  const file = e.target.files?.[0] ?? null;
                  if (file) run("banner", async () => { await uploadCompetitionBanner(id, file); setBannerFile(file); });
                }}
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 file:mr-3 file:rounded file:border-0 file:bg-emerald-600 file:px-3 file:py-1 file:text-xs file:font-semibold file:text-white"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-500">Mobile Banner <span className="text-zinc-400 dark:text-zinc-500">(600×400 recommended)</span></label>
              {detail.mobileBannerUrl && !mobileBannerFile && (
                <div className="mb-2">
                  <img src={detail.mobileBannerUrl} alt="Current mobile banner" className="h-16 rounded-lg object-cover" />
                  <p className="mt-1 text-xs text-zinc-500">Current — upload a new one to replace</p>
                </div>
              )}
              {busy === "mobileBanner" && <p className="mb-1 text-xs text-amber-500">Uploading…</p>}
              {mobileBannerFile && <p className="mb-1 text-xs text-emerald-500">Uploaded: {mobileBannerFile.name}</p>}
              <input
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                onChange={(e) => {
                  const file = e.target.files?.[0] ?? null;
                  if (file) run("mobileBanner", async () => { await uploadCompetitionMobileBanner(id, file); setMobileBannerFile(file); });
                }}
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 file:mr-3 file:rounded file:border-0 file:bg-zinc-600 file:px-3 file:py-1 file:text-xs file:font-semibold file:text-white"
              />
            </div>
          </div>
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
          {/* Gap + auto-fill rounds */}
          {detail.events.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-zinc-200 bg-white/50 p-3 dark:border-zinc-800 dark:bg-zinc-900/30">
              <label className="flex items-center gap-1.5 text-xs text-zinc-500">
                Gap between events
                <input
                  type="number"
                  min={0}
                  value={gapMinutes}
                  onChange={(e) => setGapMinutes(Number(e.target.value))}
                  className="w-14 rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                />
                <span className="text-zinc-400">min</span>
              </label>
              <button
                disabled={busy === "autoRounds" || !compStarts}
                onClick={() =>
                  run("autoRounds", async () => {
                    const times = computeRoundTimes(
                      new Date(compStarts),
                      detail.events,
                      gapMinutes,
                      schedDefaults?.eventDurations ?? DEFAULT_EVENT_DURATION,
                      schedDefaults?.defaultRoundDurationMinutes ?? DEFAULT_DURATION,
                    );
                    for (const t of times) {
                      const closesAt = new Date(
                        new Date(t.opensAt).getTime() + t.durationMinutes * 60000,
                      ).toISOString();
                      await updateRound(t.roundId, {
                        opensAt: t.opensAt,
                        closesAt,
                        durationMinutes: t.durationMinutes,
                      });
                    }
                    // Update compEnd to match last round close
                    if (times.length > 0) {
                      const last = times[times.length - 1]!;
                      const lastClose = new Date(
                        new Date(last.opensAt).getTime() + last.durationMinutes * 60000,
                      );
                      setCompEnds(toLocal(lastClose.toISOString()));
                      schedPinnedRef.current.delete("compEnd");
                    }
                  })
                }
                className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-40"
              >
                {busy === "autoRounds" ? "Filling…" : "Auto-fill Round Times"}
              </button>
              <span className="text-xs text-zinc-500">
                Schedules all rounds from competition start
              </span>
            </div>
          )}

        </div>

        {/* ── Events table ── */}
        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Events</h3>
            <button
              onClick={() => setShowAddEvent(true)}
              className="rounded border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            >
              + Add Event
            </button>
          </div>
        {detail.events.filter((e) => !e.archived).length > 0 && (
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900/80">
                    <th className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-zinc-500">Event</th>
                    <th className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-zinc-500">Rounds</th>
                    {detail.type !== "free" && (
                      <th className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-zinc-500">Fee (INR)</th>
                    )}
                    <th className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-zinc-500">Cutoff</th>
                    <th className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-zinc-500">Time Limit</th>
                    <th className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-zinc-500" />
                  </tr>
                </thead>
                <tbody>
                  {detail.events.filter((e) => !e.archived).map((ev) => (
                    <EventRow
                      key={ev.id}
                      event={ev}
                      competitionId={id}
                      defaultPerEventFee={detail.perEventFee ?? 0}
                      isFreeComp={detail.type === "free"}
                      busy={busy}
                      onRun={run}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        </div>

        {/* ── Archived events ── */}
        {detail.events.filter((e) => e.archived).length > 0 && (
          <div className="mt-5">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Archived Events</h3>
            <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 overflow-hidden opacity-60">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900/80">
                      <th className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-zinc-500">Event</th>
                      <th className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-zinc-500">Rounds</th>
                      <th className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-zinc-500" />
                    </tr>
                  </thead>
                  <tbody>
                    {detail.events.filter((e) => e.archived).map((ev) => (
                      <tr key={ev.id} className="border-b border-zinc-200 dark:border-zinc-800">
                        <td className="px-4 py-3 text-zinc-500">{ev.eventType}</td>
                        <td className="px-4 py-3 text-zinc-500">{ev.roundCount}</td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <button
                              disabled={busy === `unarchive-${ev.id}`}
                              onClick={() =>
                                run(`unarchive-${ev.id}`, () =>
                                  updateCompetitionEvent(ev.id, { archived: false }),
                                )
                              }
                              className="rounded px-2.5 py-1 text-xs font-medium text-indigo-400 transition hover:bg-indigo-500/10"
                            >
                              Restore
                            </button>
                            <button
                              disabled={busy === `delete-${ev.id}`}
                              onClick={() => setDeleteTarget(ev)}
                              className="rounded px-2.5 py-1 text-xs font-medium text-red-400 transition hover:bg-red-500/10"
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
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
                if (!showParticipants) {
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
                }
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
                    <th className="px-4 py-3">Payment</th>
                    <th className="px-4 py-3 text-right">Amount</th>
                    <th className="px-4 py-3">Registered</th>
                  </tr>
                </thead>
                <tbody>
                  {adminParticipants.map((p) => (
                    <tr key={p.userId} className="border-b border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800/50 dark:hover:bg-zinc-900/40">
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
                      <td className="px-4 py-2.5 text-xs text-zinc-500">
                        {new Date(p.registeredAt).toLocaleDateString()}
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
                await updateCompetition(id, {
                  title: editTitle,
                  description: editDescription,
                  rulesMd: editRules,
                  ...(detail.type !== "free" ? {
                    baseFee: editBaseFee ? Math.round(Number(editBaseFee) * 100) : 0,
                    perEventFee: editPerEventFee ? Math.round(Number(editPerEventFee) * 100) : 0,
                  } : {}),
                  registrationLimit: editRegLimit ? Number(editRegLimit) : null,
                  registrationOpensAt: toISO(regOpens),
                  registrationDeadline: toISO(regCloses),
                  startsAt: toISO(compStarts),
                  endsAt: toISO(compEnds),
                });
                // Banners auto-upload on file selection — no need to re-upload here
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

      {/* ── Add Event Modal ── */}
      <Modal open={showAddEvent} onClose={() => setShowAddEvent(false)} title="Add Event" size="md">
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-zinc-500">Event Type</label>
            <div className="flex items-center gap-2">
              <EventIcon eventId={newEventType} size={20} />
              <select
                value={newEventType}
                onChange={(e) => setNewEventType(e.target.value)}
                className="flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              >
                {EVENT_IDS
                  .filter((eid) => !detail.events.some((ev) => ev.eventType === eid && !ev.archived))
                  .map((eid) => (
                    <option key={eid} value={eid}>{eventDisplayName(eid)}</option>
                  ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="mb-1 block text-xs text-zinc-500">Rounds</label>
              <input
                type="number"
                min={1}
                max={10}
                value={newRoundCount}
                onChange={(e) => setNewRoundCount(Number(e.target.value))}
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-500">Cutoff (sec)</label>
              <input
                type="number"
                min={0}
                value={newCutoffMs}
                onChange={(e) => setNewCutoffMs(e.target.value)}
                placeholder="—"
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-500">Time Limit (sec)</label>
              <input
                type="number"
                min={0}
                value={newTimeLimitMs}
                onChange={(e) => setNewTimeLimitMs(e.target.value)}
                placeholder="—"
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              />
            </div>
          </div>
          {detail.type !== "free" && (
            <div>
              <label className="mb-1 block text-xs text-zinc-500">Event Fee (₹)</label>
              <input
                type="number"
                min={0}
                value={newEventFee}
                onChange={(e) => setNewEventFee(e.target.value)}
                placeholder="Use default per-event fee"
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              />
            </div>
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setShowAddEvent(false)}>Cancel</Button>
          <Button
            loading={busy === "addEvent"}
            onClick={() => {
              setShowAddEvent(false);
              run("addEvent", async () => {
                await updateCompetition(id, {
                  events: [{
                    eventType: newEventType,
                    roundCount: newRoundCount,
                    cutoffMs: newCutoffMs ? Number(newCutoffMs) * 1000 : undefined,
                    timeLimitMs: newTimeLimitMs ? Number(newTimeLimitMs) * 1000 : undefined,
                    fee: newEventFee ? Math.round(Number(newEventFee) * 100) : undefined,
                  }],
                });
                // Reset form
                setNewEventType("333");
                setNewRoundCount(1);
                setNewCutoffMs("");
                setNewTimeLimitMs("");
                setNewEventFee("");
              });
            }}
          >
            Add Event
          </Button>
        </div>
      </Modal>

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
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (!deleteTarget) return;
          setDeleteTarget(null);
          run(`delete-${deleteTarget.id}`, () => deleteCompetitionEvent(deleteTarget.id));
        }}
        title="Delete Event"
        description={<>Permanently delete <strong>{deleteTarget?.eventType}</strong>? This cannot be undone.</>}
        confirmLabel="Delete"
      />

    </div>
  );
}

/* ── Event row with inline fee editor ── */

function EventRow({
  event,
  competitionId,
  defaultPerEventFee,
  isFreeComp,
  busy,
  onRun,
}: {
  event: EventDetail;
  competitionId: string;
  defaultPerEventFee: number;
  isFreeComp: boolean;
  busy: string | null;
  onRun: (key: string, fn: () => Promise<unknown>) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [feeInput, setFeeInput] = useState(
    event.fee != null ? String(event.fee / 100) : "",
  );
  const [feeError, setFeeError] = useState<string | null>(null);
  const [feeSaved, setFeeSaved] = useState(false);

  useEffect(() => {
    setFeeInput(event.fee != null ? String(event.fee / 100) : "");
  }, [event.fee]);

  const saveFee = async () => {
    setFeeError(null);
    setFeeSaved(false);
    const trimmed = feeInput.trim();
    const feePaise = trimmed === "" ? null : Math.round(Number(trimmed) * 100);
    if (trimmed !== "" && (isNaN(feePaise!) || feePaise! < 0)) {
      setFeeError("Enter a valid amount or leave blank to use the default");
      return;
    }
    try {
      await updateCompetitionEvent(event.id, { fee: feePaise });
      setFeeSaved(true);
      onRun(`fee-${event.id}`, () => Promise.resolve());
      setTimeout(() => setFeeSaved(false), 2000);
    } catch (e) {
      setFeeError(e instanceof Error ? e.message : String(e));
    }
  };

  const feeDisplay = event.fee != null
    ? `₹${(event.fee / 100).toFixed(0)}`
    : `₹${(defaultPerEventFee / 100).toFixed(0)}`;

  return (
    <>
      <tr
        className="border-b border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900/40 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <td className="px-4 py-3 font-medium text-zinc-800 dark:text-zinc-200">{event.eventType}</td>
        <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">{event.roundCount}</td>
        {!isFreeComp && (
          <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">{feeDisplay}</td>
        )}
        <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
          {event.cutoffMs ? formatTime(event.cutoffMs) : "—"}
        </td>
        <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
          {event.timeLimitMs ? formatTime(event.timeLimitMs) : "—"}
        </td>
        <td className="px-4 py-3 text-right">
          <div className="flex items-center justify-end gap-2">
            <button
              disabled={busy === `archive-${event.id}`}
              onClick={(e) => {
                e.stopPropagation();
                onRun(`archive-${event.id}`, () =>
                  updateCompetitionEvent(event.id, { archived: true }),
                );
              }}
              className="flex items-center gap-1 rounded bg-amber-600/30 px-2.5 py-1 text-xs text-zinc-800 transition hover:bg-amber-600/40 dark:bg-amber-500/25 dark:text-zinc-100 dark:hover:bg-amber-500/35"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 8V21H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>
              Archive
            </button>
            <span className="text-xs text-zinc-400">{expanded ? "▲" : "▼"}</span>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={isFreeComp ? 5 : 6} className="bg-zinc-50 px-4 py-3 dark:bg-zinc-900/30">
            {!isFreeComp && (
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <span className="text-xs text-zinc-500">Fee override (INR)</span>
                <div className="relative flex items-center">
                  <span className="pointer-events-none absolute left-2 text-xs text-zinc-400">₹</span>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={feeInput}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => { setFeeInput(e.target.value); setFeeSaved(false); }}
                    placeholder={String(defaultPerEventFee / 100)}
                    title={`Leave blank to use competition default (₹${defaultPerEventFee / 100})`}
                    className="w-24 rounded-lg border border-zinc-300 bg-white py-1 pl-6 pr-2 text-xs text-zinc-900 focus:border-emerald-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                  />
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); saveFee(); }}
                  disabled={busy?.startsWith(`fee-${event.id}`) ?? false}
                  className="rounded-lg bg-emerald-700 px-3 py-1 text-xs font-semibold text-white transition hover:bg-emerald-600 disabled:opacity-50"
                >
                  {feeSaved ? "✓ Saved" : "Save"}
                </button>
                {feeError && <span className="text-xs text-red-400">{feeError}</span>}
              </div>
            )}
            <div className="space-y-2">
              {event.rounds.map((r) => (
                <RoundRow
                  key={r.id}
                  round={r}
                  competitionId={competitionId}
                  busy={busy}
                  onRun={onRun}
                />
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/* ── Bulk email modal ── */

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

function RoundRow({
  round,
  competitionId,
  busy,
  onRun,
}: {
  round: RoundRef;
  competitionId: string;
  busy: string | null;
  onRun: (key: string, fn: () => Promise<unknown>) => void;
}) {
  const [showSchedule, setShowSchedule] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [roundError, setRoundError] = useState<string | null>(null);
  const [opensAt, setOpensAt] = useState(toLocal(round.opensAt));
  const [closesAt, setClosesAt] = useState(toLocal(round.closesAt));
  const [duration, setDuration] = useState<string>("");
  const [criteriaMethod, setCriteriaMethod] = useState<"none" | "rank" | "time" | "best_single">(
    round.advancementCriteria?.method ?? "none",
  );
  const [criteriaLimit, setCriteriaLimit] = useState<string>(
    round.advancementCriteria?.method === "rank"
      ? String(round.advancementCriteria.rankLimit ?? "")
      : round.advancementCriteria?.method === "time"
        ? String((round.advancementCriteria.timeLimitMs ?? 0) / 1000)
        : round.advancementCriteria?.method === "best_single"
          ? String((round.advancementCriteria.bestSingleMs ?? 0) / 1000)
          : "",
  );

  // Keep local inputs in sync when parent refreshes
  useEffect(() => {
    setOpensAt(toLocal(round.opensAt));
    setClosesAt(toLocal(round.closesAt));
  }, [round.opensAt, round.closesAt]);

  // Auto-compute closesAt when opensAt + duration are set
  useEffect(() => {
    if (opensAt && duration && Number(duration) > 0) {
      const open = new Date(opensAt);
      const close = new Date(open.getTime() + Number(duration) * 60_000);
      setClosesAt(toLocal(close.toISOString()));
    }
  }, [opensAt, duration]);

  const buildCriteria = (): AdvancementCriteria | null => {
    if (criteriaMethod === "rank" && Number(criteriaLimit) > 0)
      return { method: "rank", rankLimit: Number(criteriaLimit) };
    if (criteriaMethod === "time" && Number(criteriaLimit) > 0)
      return { method: "time", timeLimitMs: Number(criteriaLimit) * 1000 };
    if (criteriaMethod === "best_single" && Number(criteriaLimit) > 0)
      return { method: "best_single", bestSingleMs: Number(criteriaLimit) * 1000 };
    return null;
  };

  const saveSchedule = async () => {
    setRoundError(null);
    try {
      await updateRound(round.id, {
        opensAt: toISO(opensAt),
        closesAt: toISO(closesAt),
        advancementCriteria: buildCriteria(),
        ...(duration ? { durationMinutes: Number(duration) } : {}),
      });
      onRun(`sched-${round.id}`, () => Promise.resolve());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      try {
        const jsonMatch = msg.match(/\{.*\}/s);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          setRoundError(
            parsed.errors?.join(", ") ?? parsed.error ?? msg,
          );
        } else {
          setRoundError(msg);
        }
      } catch {
        setRoundError(msg);
      }
    }
  };

  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/60">
      {/* Main row */}
      <div className="flex flex-wrap items-center gap-4 px-5 py-3.5">
        <span className="font-mono text-sm font-semibold text-zinc-700 dark:text-zinc-300">R{round.roundNumber}</span>
        <StatusBadge status={round.status} domain="round" />

        {/* Show scheduled times if set */}
        {(round.opensAt || round.closesAt) && (
          <span className="text-xs text-zinc-500">
            {round.opensAt
              ? round.status === "pending"
                ? <>Starts in <Countdown target={round.opensAt} className="font-semibold text-accent-primary" /> ({new Date(round.opensAt).toLocaleString()})</>
                : `opens ${new Date(round.opensAt).toLocaleString()}`
              : ""}
            {round.opensAt && round.closesAt ? " · " : ""}
            {round.closesAt ? `closes ${new Date(round.closesAt).toLocaleString()}` : ""}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          {/* Schedule toggle */}
          <button
            onClick={() => setShowSchedule((v) => !v)}
            className={`rounded border px-2.5 py-1.5 text-xs font-medium transition ${
              showSchedule
                ? "border-emerald-700 bg-emerald-900/40 text-emerald-300"
                : round.opensAt || round.closesAt
                  ? "border-emerald-800 text-emerald-500 hover:bg-emerald-900/30 hover:text-emerald-300"
                  : "border-zinc-300 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            }`}
            title="Set open / close times — round auto-transitions when the time is reached"
          >
            ⏱ {"Edit Round"}
          </button>

          {/* Cancel round */}
          {round.status !== "cancelled" && round.status !== "advanced" && round.status !== "closed" && (
            <button
              disabled={busy === `cancel-${round.id}`}
              onClick={() => setConfirmingCancel(true)}
              className="rounded border border-red-800 px-3 py-1.5 text-xs font-semibold text-red-400 transition hover:bg-red-900/30 disabled:opacity-40"
            >
              {busy === `cancel-${round.id}` ? "Cancelling…" : "Cancel"}
            </button>
          )}
          <ConfirmModal
            open={confirmingCancel}
            onClose={() => setConfirmingCancel(false)}
            onConfirm={() => {
              setConfirmingCancel(false);
              onRun(`cancel-${round.id}`, () => cancelRound(round.id));
            }}
            title="Cancel this round?"
            description="Competitors currently in this round will no longer be able to submit results. This cannot be undone."
            confirmLabel="Cancel round"
          />

          <button
            disabled={busy === `notify-${round.id}`}
            onClick={() => onRun(`notify-${round.id}`, () => sendRoundNotification(round.id))}
            className="rounded border border-zinc-300 px-3 py-1.5 text-xs font-semibold text-zinc-700 transition hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {busy === `notify-${round.id}` ? "Sending…" : "Notify"}
          </button>

        </div>
      </div>

      {/* Collapsible schedule editor */}
      {showSchedule && (
        <div className="border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <p className="mb-3 text-xs font-semibold text-zinc-600 dark:text-zinc-400">
            Round {round.roundNumber} — Open &amp; Close Times
          </p>
          <p className="mb-2 text-xs text-zinc-500">
            The round status changes automatically when each time is reached.
            The manual Open / Close buttons above override this at any time.
          </p>
          {roundError && (
            <div className="mb-3 rounded bg-red-100 px-3 py-2 text-xs text-red-700 dark:bg-red-900/30 dark:text-red-300">
              {roundError}
            </div>
          )}
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="mb-1 block text-xs text-zinc-500">Opens at</label>
              <input
                type="datetime-local"
                value={opensAt}
                onChange={(e) => setOpensAt(e.target.value)}
                className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-500">Duration (min)</label>
              <input
                type="number"
                min={1}
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                placeholder="—"
                className="w-24 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-500">Closes at</label>
              <input
                type="datetime-local"
                value={closesAt}
                onChange={(e) => { setClosesAt(e.target.value); setDuration(""); }}
                className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              />
            </div>
            <div className="w-full" />
            <div>
              <label className="mb-1 block text-xs text-zinc-500">Shortlist Method</label>
              <select
                value={criteriaMethod}
                onChange={(e) => { setCriteriaMethod(e.target.value as "none" | "rank" | "time" | "best_single"); setCriteriaLimit(""); }}
                className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              >
                <option value="none">None</option>
                <option value="rank">Rank Based (Top N)</option>
                <option value="time">Time Based (ao5 ≤ X)</option>
                <option value="best_single">Best Single (≤ X)</option>
              </select>
            </div>
            {criteriaMethod !== "none" && (
              <div>
                <label className="mb-1 block text-xs text-zinc-500">
                  {criteriaMethod === "rank" ? "Top N" : criteriaMethod === "best_single" ? "Best single ≤ (seconds)" : "ao5 ≤ (seconds)"}
                </label>
                <input
                  type="number"
                  min={1}
                  value={criteriaLimit}
                  onChange={(e) => setCriteriaLimit(e.target.value)}
                  placeholder={criteriaMethod === "rank" ? "e.g. 10" : "e.g. 30"}
                  className="w-28 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                />
              </div>
            )}
            <button
              disabled={busy === `sched-${round.id}`}
              onClick={saveSchedule}
              className="rounded-lg bg-zinc-800 px-4 py-2 text-xs font-semibold text-white transition hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-600"
            >
              {busy === `sched-${round.id}` ? "Saving…" : "Save"}
            </button>
            {(opensAt || closesAt) && (
              <button
                onClick={() => {
                  setOpensAt("");
                  setClosesAt("");
                  onRun(`sched-${round.id}`, () =>
                    updateRound(round.id, { opensAt: null, closesAt: null }),
                  );
                }}
                className="text-xs text-zinc-600 hover:text-red-400"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Practice event modal ── */

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
