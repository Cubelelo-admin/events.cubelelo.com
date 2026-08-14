"use client";

import type { ReactNode } from "react";
import { EVENT_IDS } from "@cubers/scramble-core";
import { eventDisplayName } from "@/lib/eventNames";
import { EventIcon } from "@/components/EventIcon";
import {
  FIELD_LABELS,
  MAX_ROUND_COUNT,
  MIN_ROUND_COUNT,
  type EventFieldsValue,
} from "./competitionFields";

const INPUT =
  "rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";

export interface EventFieldsProps {
  value: EventFieldsValue;
  onChange: (patch: Partial<EventFieldsValue>) => void;
  /** Hides the fee input for free competitions. */
  isPaid: boolean;
  /** Event types already used by this competition; excluded from the picker. */
  takenEventTypes?: string[];
  /** The event type cannot change once the event exists. */
  lockEventType?: boolean;
  /**
   * `td` for the Create screen's table repeater, whose labels live in the
   * column headers; `div` for the Manage screen's stacked dialog.
   */
  as?: "td" | "div";
}

/**
 * The per-event fields.
 *
 * Shared by the Create screen's event repeater and the Manage screen's Add Event
 * dialog, which previously implemented the same five inputs twice with different
 * labels, different placeholders, and different duplicate handling — Create
 * allowed the same event type twice, Manage filtered it out.
 *
 * Cutoff and time limit here are the event's **defaults**: they seed new rounds,
 * and any round may override them.
 */
export function EventFields({
  value,
  onChange,
  isPaid,
  takenEventTypes = [],
  lockEventType = false,
  as = "div",
}: EventFieldsProps) {
  const taken = new Set(takenEventTypes.filter((t) => t !== value.eventType));
  const options = EVENT_IDS.filter((id) => !taken.has(id));

  const Cell = ({ label, children }: { label: string; children: ReactNode }) =>
    as === "td" ? (
      <td className="px-3 py-2 align-top">{children}</td>
    ) : (
      <div>
        <label className="mb-1 block text-xs font-medium text-zinc-500">{label}</label>
        {children}
      </div>
    );

  return (
    <>
      <Cell label={FIELD_LABELS.eventType}>
        <div className="flex items-center gap-2">
          <EventIcon eventId={value.eventType} size={18} />
          <select
            value={value.eventType}
            disabled={lockEventType}
            onChange={(e) => onChange({ eventType: e.target.value })}
            className={`${INPUT} disabled:cursor-not-allowed disabled:opacity-50`}
          >
            {options.map((id) => (
              <option key={id} value={id}>{eventDisplayName(id)}</option>
            ))}
          </select>
        </div>
      </Cell>

      <Cell label={FIELD_LABELS.roundCount}>
        <input
          type="number"
          min={MIN_ROUND_COUNT}
          max={MAX_ROUND_COUNT}
          value={value.roundCount}
          onChange={(e) => {
            const n = Number(e.target.value);
            onChange({
              roundCount: Math.max(MIN_ROUND_COUNT, Math.min(Number.isNaN(n) ? 1 : n, MAX_ROUND_COUNT)),
            });
          }}
          className={`w-20 ${INPUT}`}
        />
      </Cell>

      {isPaid ? (
        <Cell label={FIELD_LABELS.eventFee}>
          <input
            type="number"
            min={0}
            value={value.fee}
            placeholder="Default"
            onChange={(e) => onChange({ fee: e.target.value })}
            className={`w-24 ${INPUT}`}
          />
        </Cell>
      ) : null}

      <Cell label={FIELD_LABELS.cutoff}>
        <input
          type="number"
          min={1}
          value={value.cutoffSec}
          placeholder="None"
          onChange={(e) => onChange({ cutoffSec: e.target.value })}
          className={`w-24 ${INPUT}`}
        />
      </Cell>

      <Cell label={FIELD_LABELS.timeLimit}>
        <input
          type="number"
          min={1}
          value={value.timeLimitSec}
          placeholder="None"
          onChange={(e) => onChange({ timeLimitSec: e.target.value })}
          className={`w-24 ${INPUT}`}
        />
      </Cell>
    </>
  );
}
