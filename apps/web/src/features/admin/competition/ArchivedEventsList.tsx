"use client";

import { eventDisplayName } from "@/lib/eventNames";
import { EventIcon } from "@/components/EventIcon";

export interface ArchivedEventRow {
  /** Competition-event id on Manage, or the event's index on Create. */
  key: string;
  eventType: string;
  roundCount: number;
}

export interface ArchivedEventsListProps {
  rows: ArchivedEventRow[];
  onRestore: (key: string) => void;
  onDelete: (key: string) => void;
}

/**
 * Events the organiser has archived.
 *
 * Archived events are not run, so they are kept out of the schedule entirely —
 * that table shows only what is actually happening. This is the single place
 * they can be brought back or removed for good.
 */
export function ArchivedEventsList({ rows, onRestore, onDelete }: ArchivedEventsListProps) {
  if (rows.length === 0) return null;

  return (
    <div className="mt-5">
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
        Archived Events
      </h3>
      <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="w-full table-fixed text-left text-xs">
          <colgroup>
            <col style={{ width: "40%" }} />
            <col style={{ width: "25%" }} />
            <col style={{ width: "35%" }} />
          </colgroup>
          <thead>
            <tr className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/60">
              <th className="px-2 py-2 font-medium text-zinc-500">Event</th>
              <th className="px-2 py-2 font-medium text-zinc-500">Rounds</th>
              <th className="px-2 py-2 font-medium text-zinc-500" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-b border-zinc-100 dark:border-zinc-800/60">
                <td className="px-2 py-1.5">
                  <div className="flex items-center gap-1.5 text-zinc-500">
                    <EventIcon eventId={row.eventType} size={16} />
                    {eventDisplayName(row.eventType)}
                  </div>
                </td>
                <td className="px-2 py-1.5 text-zinc-500">{row.roundCount}</td>
                <td className="px-2 py-1.5">
                  <div className="flex items-center justify-end gap-3">
                    <button
                      type="button"
                      onClick={() => onRestore(row.key)}
                      className="text-zinc-400 transition hover:text-emerald-400"
                    >
                      Restore
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(row.key)}
                      className="text-zinc-400 transition hover:text-red-400"
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
  );
}
