"use client";

import { useState, type ReactNode } from "react";
import type { RuleSetDto } from "@/lib/api";
import {
  FIELD_LABELS,
  minutesToHours,
  type CompetitionDetailsValue,
} from "./competitionFields";

const INPUT =
  "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";
const SELECT =
  "rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="mt-1 text-[11px] text-red-500">{message}</p>;
}

/**
 * Multi-select for rule sets: selected sets as removable chips, plus a picker.
 *
 * A competition can use several rule sets. The selection is stored as a real
 * association, so the chips reload correctly — the previous version merged the
 * sets' markdown into the rules text and then tried to recover the selection by
 * comparing that text, which broke as soon as anyone edited it.
 */
function RuleSetPicker({
  selectedIds,
  ruleSets,
  onChange,
}: {
  selectedIds: string[];
  ruleSets: RuleSetDto[];
  onChange: (ids: string[]) => void;
}) {
  const [picking, setPicking] = useState(selectedIds.length === 0);

  const byId = new Map(ruleSets.map((rs) => [rs.id, rs]));
  const available = ruleSets.filter((rs) => !selectedIds.includes(rs.id));

  return (
    <div className="rounded-lg border border-zinc-300 p-2 dark:border-zinc-700">
      <div className="flex flex-wrap items-center gap-2">
        {selectedIds.map((id) => {
          const rs = byId.get(id);
          return (
            <span
              key={id}
              className="inline-flex items-center gap-2 rounded-md bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-500"
            >
              {/* A set deleted from Settings still shows, so the admin can see
                  what is stale rather than it vanishing silently. */}
              {rs?.name ?? "(deleted rule set)"}
              <button
                type="button"
                aria-label={`Remove ${rs?.name ?? "rule set"}`}
                onClick={() => onChange(selectedIds.filter((x) => x !== id))}
                className="text-emerald-500/70 transition hover:text-emerald-400"
              >
                ✕
              </button>
            </span>
          );
        })}

        {!picking && available.length > 0 && (
          <button
            type="button"
            onClick={() => setPicking(true)}
            className="rounded-md border border-dashed border-zinc-400 px-2.5 py-1 text-xs font-medium text-zinc-500 transition hover:border-zinc-300 hover:text-zinc-300 dark:border-zinc-600"
          >
            + Add More
          </button>
        )}
      </div>

      {picking && (
        <select
          value=""
          autoFocus={selectedIds.length > 0}
          onChange={(e) => {
            const id = e.target.value;
            if (!id) return;
            onChange([...selectedIds, id]);
            setPicking(false);
          }}
          onBlur={() => selectedIds.length > 0 && setPicking(false)}
          className={`mt-2 w-full ${SELECT}`}
        >
          <option value="">— Select a rule set —</option>
          {available.map((rs) => (
            <option key={rs.id} value={rs.id}>{rs.name}</option>
          ))}
        </select>
      )}

      {selectedIds.length === 0 && available.length === 0 && (
        <p className="px-1 py-0.5 text-xs text-zinc-500">
          No rule sets defined yet — create them in Settings.
        </p>
      )}
    </div>
  );
}

export interface CompetitionDetailsFieldsProps {
  value: CompetitionDetailsValue;
  onChange: (patch: Partial<CompetitionDetailsValue>) => void;
  errors?: Partial<Record<keyof CompetitionDetailsValue, string>>;
  ruleSets: RuleSetDto[];
  /**
   * Free/paid is locked once a competition leaves draft — changing it with
   * registrations or payments on the books would strand them.
   */
  canChangeType?: boolean;
  /** Only full admins may feature a competition. */
  canFeature?: boolean;
  /** Shown under the video-deadline input when the competition has no own value. */
  globalVideoDeadlineMinutes?: number;
  /**
   * Image uploaders. Create defers the upload until the competition exists;
   * Manage uploads immediately — so the surrounding screen supplies them and
   * this component only owns their placement.
   */
  imageSlot?: ReactNode;
  /** Rendered between the fee row and the schedule (e.g. the schedule editor). */
  children?: ReactNode;
}

/**
 * Every competition-level field, rendered identically on Create and Manage.
 *
 * This component is the fix for the team's report that the two screens have
 * different fields: there is now one place where a competition-level field can
 * be added, and both screens get it.
 */
export function CompetitionDetailsFields({
  value,
  onChange,
  errors = {},
  ruleSets,
  canChangeType = true,
  canFeature = true,
  globalVideoDeadlineMinutes,
  imageSlot,
  children,
}: CompetitionDetailsFieldsProps) {
  const set = <K extends keyof CompetitionDetailsValue>(key: K, v: CompetitionDetailsValue[K]) =>
    onChange({ [key]: v } as Partial<CompetitionDetailsValue>);

  return (
    <div className="space-y-6">
      <div>
        <label className="mb-1 block text-xs font-medium text-zinc-500">{FIELD_LABELS.title}</label>
        <input
          value={value.title}
          onChange={(e) => set("title", e.target.value)}
          placeholder="Midweek Madness"
          className={INPUT}
        />
        <FieldError message={errors.title} />
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-zinc-500">{FIELD_LABELS.description}</label>
        <textarea
          value={value.description}
          onChange={(e) => set("description", e.target.value)}
          placeholder="Short description for competitors..."
          rows={3}
          className={INPUT}
        />
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-zinc-500">{FIELD_LABELS.rules}</label>
        <RuleSetPicker
          selectedIds={value.ruleSetIds}
          ruleSets={ruleSets}
          onChange={(ids) => set("ruleSetIds", ids)}
        />
        <textarea
          value={value.rulesMd}
          onChange={(e) => set("rulesMd", e.target.value)}
          placeholder="Additional rules specific to this competition (Markdown)…"
          rows={6}
          className={`mt-2 font-mono ${INPUT}`}
        />
        <p className="mt-1 text-[11px] text-zinc-500">
          {value.ruleSetIds.length > 0
            ? "Competitors see the selected rule sets, then this text. Editing a rule set updates every competition using it — change them in Settings."
            : "Shown to competitors on its own, unless you add rule sets above."}
        </p>
      </div>

      {imageSlot}

      <div className="flex flex-wrap items-start gap-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-500">{FIELD_LABELS.type}</label>
          <select
            value={value.type}
            disabled={!canChangeType}
            onChange={(e) => set("type", e.target.value as "free" | "paid")}
            className={`${SELECT} disabled:cursor-not-allowed disabled:opacity-50`}
          >
            <option value="free">Free</option>
            <option value="paid">Paid</option>
          </select>
          {!canChangeType ? (
            <p className="mt-1 max-w-[12rem] text-[11px] text-zinc-500">
              Locked once the competition leaves draft — registrations and payments depend on it.
            </p>
          ) : null}
        </div>

        {canFeature ? (
          <>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-500">{FIELD_LABELS.featured}</label>
              <select
                value={value.featured ? "yes" : "no"}
                onChange={(e) => set("featured", e.target.value === "yes")}
                className={SELECT}
              >
                <option value="no">No</option>
                <option value="yes">Yes</option>
              </select>
            </div>
            {value.featured ? (
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-500">{FIELD_LABELS.featuredOrder}</label>
                <input
                  type="number"
                  min={0}
                  value={value.featuredOrder}
                  onChange={(e) => set("featuredOrder", e.target.value)}
                  placeholder="0"
                  className={`w-28 ${INPUT}`}
                />
                <p className="mt-1 text-[11px] text-zinc-500">Lower shows first.</p>
                <FieldError message={errors.featuredOrder} />
              </div>
            ) : null}
          </>
        ) : null}

        {/* Registration limit is hidden for now. The value is still carried in
            form state and hydrated from the API, and the payload builder no
            longer sends the key — so existing limits stay put and the backend
            capacity check keeps working. Re-showing it is putting this input
            back. */}

        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-500">{FIELD_LABELS.videoDeadline}</label>
          {/* The unit sits inside the box, so the label stays short and the
              field can be narrow. */}
          <div className="relative w-24">
            <input
              type="number"
              min={0}
              step="0.5"
              value={value.videoDeadlineHours}
              placeholder={minutesToHours(globalVideoDeadlineMinutes) || "24"}
              onChange={(e) => set("videoDeadlineHours", e.target.value)}
              className={`${INPUT} pr-8`}
            />
            <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-zinc-400">
              hr
            </span>
          </div>
          <p className="mt-1 text-[11px] text-zinc-500">
            {value.videoDeadlineHours.trim() === "" ? "Using the global default." : "Overrides the global default."}
          </p>
          <FieldError message={errors.videoDeadlineHours} />
        </div>

        {value.type === "paid" ? (
          <>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-500">{FIELD_LABELS.baseFee}</label>
              <input
                type="number"
                min={0}
                value={value.baseFee}
                onChange={(e) => set("baseFee", e.target.value)}
                className={`w-28 ${INPUT}`}
              />
              <FieldError message={errors.baseFee} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-500">{FIELD_LABELS.perEventFee}</label>
              <input
                type="number"
                min={0}
                value={value.perEventFee}
                onChange={(e) => set("perEventFee", e.target.value)}
                className={`w-28 ${INPUT}`}
              />
              <FieldError message={errors.perEventFee} />
            </div>
          </>
        ) : null}
      </div>

      {children}
    </div>
  );
}

/** The four schedule inputs, kept together so both screens order them alike. */
export function CompetitionScheduleFields({
  value,
  onChange,
  errors = {},
  onReset,
}: {
  value: CompetitionDetailsValue;
  onChange: (patch: Partial<CompetitionDetailsValue>) => void;
  errors?: Partial<Record<keyof CompetitionDetailsValue, string>>;
  onReset?: () => void;
}) {
  const FIELDS = [
    { key: "registrationOpensAt", label: FIELD_LABELS.registrationOpensAt },
    { key: "registrationDeadline", label: FIELD_LABELS.registrationDeadline },
    { key: "startsAt", label: FIELD_LABELS.startsAt },
    { key: "endsAt", label: FIELD_LABELS.endsAt },
  ] as const;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Schedule</label>
        {onReset ? (
          <button type="button" onClick={onReset} className="text-[11px] text-zinc-500 hover:text-zinc-300">
            Reset to auto
          </button>
        ) : null}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {FIELDS.map(({ key, label }) => (
          <div key={key}>
            <label className="mb-1 block text-xs font-medium text-zinc-500">{label}</label>
            <input
              type="datetime-local"
              value={value[key]}
              onChange={(e) => onChange({ [key]: e.target.value } as Partial<CompetitionDetailsValue>)}
              className={INPUT}
            />
            <FieldError message={errors[key]} />
          </div>
        ))}
      </div>
    </div>
  );
}
