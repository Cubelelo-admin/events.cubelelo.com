"use client";

import { useEffect, useState } from "react";
import { EVENT_IDS } from "@cubers/scramble-core";
import { eventDisplayName } from "@/lib/eventNames";
import { EventIcon } from "@/components/EventIcon";
import { FIELD_LABELS } from "./competitionFields";

const CELL =
  "w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";

/**
 * The event picker, sized to its own content rather than the column.
 *
 * Event names are short, so a full-width select left a wide empty field and
 * squeezed the columns that actually need room.
 */
const EVENT_SELECT = `${CELL} min-w-0 max-w-[8.5rem] px-1`;

export type CriteriaMethod = "none" | "rank" | "time" | "best_single";

/**
 * An input that keeps what you type locally and only reports it on blur.
 *
 * The rows are driven by server state, so committing on every keystroke fired a
 * save per character and the reload overwrote the half-typed value — which made
 * these fields impossible to edit. Buffering locally and committing once on blur
 * is what makes typing work.
 */
function BufferedInput({
  value,
  onCommit,
  className,
  ...rest
}: {
  value: string;
  onCommit: (next: string) => void;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "onBlur" | "onFocus">) {
  const [local, setLocal] = useState(value);
  const [focused, setFocused] = useState(false);

  // Adopt server changes only while the field is not being edited.
  useEffect(() => {
    if (!focused) setLocal(value);
  }, [value, focused]);

  return (
    <input
      {...rest}
      value={local}
      className={className}
      onChange={(e) => setLocal(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        if (local !== value) onCommit(local);
      }}
    />
  );
}

/**
 * The shortlist method and its value.
 *
 * The method is held locally because "method chosen, value not yet typed" has no
 * server representation — persisting it immediately saved a null criteria and
 * snapped the dropdown back to None before you could type the number. Only a
 * complete criteria, or an explicit None, is committed.
 */
function CriteriaCells({
  method,
  value,
  onCommit,
}: {
  method: CriteriaMethod;
  value: string;
  onCommit: (method: CriteriaMethod, value: string) => void;
}) {
  const [localMethod, setLocalMethod] = useState(method);
  useEffect(() => setLocalMethod(method), [method]);

  return (
    <>
      <td className="px-2 py-1.5">
        <select
          value={localMethod}
          onChange={(e) => {
            const next = e.target.value as CriteriaMethod;
            setLocalMethod(next);
            // Clearing is immediately representable; any other method waits for
            // its value so we never save a half-formed criteria.
            if (next === "none") onCommit("none", "");
          }}
          className={CELL}
        >
          {(Object.keys(CRITERIA_LABELS) as CriteriaMethod[]).map((m) => (
            <option key={m} value={m}>{CRITERIA_LABELS[m]}</option>
          ))}
        </select>
      </td>

      <td className="px-2 py-1.5">
        {localMethod === "none" ? (
          <span className="text-zinc-600">—</span>
        ) : (
          <BufferedInput
            type="number"
            min={1}
            value={value}
            placeholder={criteriaUnit(localMethod)}
            onCommit={(next) => onCommit(localMethod, next)}
            className={CELL}
          />
        )}
      </td>
    </>
  );
}

/**
 * One round, flattened out of its event.
 *
 * The schedule is the unit organisers think in, so the list is one row per round
 * across all events in start-time order rather than events with rounds nested
 * inside them.
 */
export interface ScheduleRow {
  /** Stable key: the round id on Manage, or `eventIndex:roundIndex` on Create. */
  key: string;
  /** Identifies the owning event — a competition-event id, or its index on Create. */
  eventKey: string;
  eventType: string;
  roundNumber: number;
  /** True for this event's earliest row in the sorted list. Event controls live there. */
  isFirstOfEvent: boolean;
  /** True for this event's final round — the only row that may be removed. */
  isLastOfEvent: boolean;

  startTime: string;        // datetime-local
  durationMinutes: string;
  criteriaMethod: CriteriaMethod;
  criteriaValue: string;    // rank = count; time / best_single = seconds

  /** Event-level, rendered on the first row only. */
  fee: string;

  /** Why this round cannot be removed, e.g. results already submitted. */
  removeBlockedReason?: string;
}

export interface RoundScheduleListProps {
  rows: ScheduleRow[];
  isPaid: boolean;
  onRoundChange: (row: ScheduleRow, patch: Partial<ScheduleRow>) => void;
  onEventChange: (eventKey: string, patch: { eventType?: string; fee?: string; archived?: boolean }) => void;
  onAddRound: (eventKey: string) => void;
  onRemoveRound: (eventKey: string) => void;
  onAddEvent: () => void;
  /** Event types already in use, so the picker cannot create a duplicate. */
  takenEventTypes: string[];
}

const CRITERIA_LABELS: Record<CriteriaMethod, string> = {
  none: "None",
  rank: "Top N",
  time: "Average ≤",
  best_single: "Best single ≤",
};

/** Unit hint for the criteria value input, which changes with the method. */
function criteriaUnit(method: CriteriaMethod): string {
  return method === "rank" ? "competitors" : "seconds";
}

/**
 * The competition's rounds as one time-ordered schedule.
 *
 * Shared by Create and Manage. Event-level controls — event type, fee, archive
 * and the round +/− — sit on the event's first row, because a flat list has no
 * row of its own for an event.
 *
 * Archived events never appear here; they live in the archived list, so this
 * table shows only what is actually being run.
 *
 * Column widths are fixed so a row's controls do not move as neighbouring rows
 * change; `table-fixed` plus explicit widths keeps every row aligned.
 */
export function RoundScheduleList({
  rows,
  isPaid,
  onRoundChange,
  onEventChange,
  onAddRound,
  onRemoveRound,
  onAddEvent,
  takenEventTypes,
}: RoundScheduleListProps) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          Schedule
        </label>
        <button
          type="button"
          onClick={onAddEvent}
          className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          + Add Event
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-xs text-zinc-500 dark:border-zinc-700">
          No events yet — add one to build the schedule.
        </div>
      ) : (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
          {/* Percentage widths rather than fixed ones, so the table always fits
              its container and never needs horizontal scrolling. */}
          <table className="w-full table-fixed text-left text-xs">
            <colgroup>
              <col style={{ width: isPaid ? "19%" : "20%" }} />
              <col style={{ width: isPaid ? "18%" : "20%" }} />
              <col style={{ width: isPaid ? "11%" : "12%" }} />
              <col style={{ width: isPaid ? "17%" : "19%" }} />
              <col style={{ width: isPaid ? "12%" : "13%" }} />
              {isPaid && <col style={{ width: "9%" }} />}
              <col style={{ width: isPaid ? "6%" : "8%" }} />
              {/* Archive only, now that the round actions and status are gone. */}
              <col style={{ width: "8%" }} />
            </colgroup>
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/60">
                <th className="px-2 py-2 font-medium text-zinc-500">Event / Round</th>
                <th className="px-2 py-2 font-medium text-zinc-500">Start</th>
                <th className="px-2 py-2 font-medium text-zinc-500">Duration</th>
                <th className="px-2 py-2 font-medium text-zinc-500">Shortlist</th>
                <th className="px-2 py-2 font-medium text-zinc-500">Value</th>
                {isPaid && <th className="px-2 py-2 font-medium text-zinc-500">{FIELD_LABELS.eventFee}</th>}
                <th className="px-2 py-2 font-medium text-zinc-500">Rounds</th>
                <th className="px-2 py-2 font-medium text-zinc-500" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const available = EVENT_IDS.filter(
                  (id) => id === row.eventType || !takenEventTypes.includes(id),
                );

                return (
                  <tr key={row.key} className="border-b border-zinc-100 dark:border-zinc-800/60">
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-1.5">
                        <EventIcon eventId={row.eventType} size={16} />
                        {row.isFirstOfEvent ? (
                          // The event type belongs to the event, so it is only
                          // editable where the event's controls live.
                          <select
                            value={row.eventType}
                            onChange={(e) => onEventChange(row.eventKey, { eventType: e.target.value })}
                            className={EVENT_SELECT}
                          >
                            {available.map((id) => (
                              <option key={id} value={id}>{eventDisplayName(id)}</option>
                            ))}
                          </select>
                        ) : (
                          <span className="truncate text-zinc-500">{eventDisplayName(row.eventType)}</span>
                        )}
                        <span className="whitespace-nowrap font-medium text-zinc-400">
                          R{row.roundNumber}
                        </span>
                      </div>
                    </td>

                    <td className="px-2 py-1.5">
                      <BufferedInput
                        type="datetime-local"
                        value={row.startTime}
                        onCommit={(next) => onRoundChange(row, { startTime: next })}
                        className={CELL}
                      />
                    </td>

                    <td className="px-2 py-1.5">
                      <BufferedInput
                        type="number"
                        min={1}
                        value={row.durationMinutes}
                        placeholder="min"
                        onCommit={(next) => onRoundChange(row, { durationMinutes: next })}
                        className={CELL}
                      />
                    </td>

                    <CriteriaCells
                      method={row.criteriaMethod}
                      value={row.criteriaValue}
                      onCommit={(method, value) =>
                        onRoundChange(row, { criteriaMethod: method, criteriaValue: value })
                      }
                    />

                    {isPaid && (
                      <td className="px-2 py-1.5">
                        {/* Fee belongs to the event, so it shows once. */}
                        {row.isFirstOfEvent ? (
                          <BufferedInput
                            type="number"
                            min={0}
                            value={row.fee}
                            placeholder="Default"
                            onCommit={(next) => onEventChange(row.eventKey, { fee: next })}
                            className={CELL}
                          />
                        ) : (
                          <span className="text-zinc-600">—</span>
                        )}
                      </td>
                    )}

                    <td className="px-2 py-1.5">
                      {row.isFirstOfEvent ? (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => onRemoveRound(row.eventKey)}
                            disabled={Boolean(row.removeBlockedReason)}
                            title={row.removeBlockedReason ?? "Remove the last round of this event"}
                            className="rounded border border-zinc-300 px-1.5 text-zinc-500 transition hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700"
                          >
                            −
                          </button>
                          <button
                            type="button"
                            onClick={() => onAddRound(row.eventKey)}
                            title="Add a round to this event"
                            className="rounded border border-zinc-300 px-1.5 text-zinc-500 transition hover:text-zinc-200 dark:border-zinc-700"
                          >
                            +
                          </button>
                        </div>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>

                    <td className="px-2 py-1.5">
                      <div className="flex items-center justify-end gap-2 whitespace-nowrap">
                        {row.isFirstOfEvent && (
                          <button
                            type="button"
                            onClick={() => onEventChange(row.eventKey, { archived: true })}
                            className="text-zinc-400 transition hover:text-amber-400"
                          >
                            Archive
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
