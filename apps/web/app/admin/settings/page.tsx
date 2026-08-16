"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { EVENT_IDS } from "@cubers/scramble-core";
import {
  fetchSystemSettings,
  updateSystemSettings,
  fetchAdminRuleSets,
  createRuleSet,
  updateRuleSet,
  deleteRuleSet,
  type SystemSettingsDto,
  type RuleSetDto,
} from "@/lib/api";
import { eventDisplayName } from "@/lib/eventNames";
import { EventIcon } from "@/components/EventIcon";
import {
  hoursToMinutes,
  minutesToHours,
} from "@/features/admin/competition/competitionFields";

const INPUT =
  "rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";

export default function AdminSettingsPage() {
  const [settings, setSettings] = useState<SystemSettingsDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Local edit state
  const [eventDurations, setEventDurations] = useState<Record<string, number>>({});
  const [regDays, setRegDays] = useState(5);
  const [gapMinutes, setGapMinutes] = useState(0);
  const [defaultDuration, setDefaultDuration] = useState(20);
  // Held as the typed string in hours; converted at load and save.
  const [videoDeadlineHours, setVideoDeadlineHours] = useState("24");
  const [autoPublishLead, setAutoPublishLead] = useState("30");
  const [warningLead, setWarningLead] = useState("5");

  const load = useCallback(() => {
    setLoading(true);
    fetchSystemSettings()
      .then((s) => {
        setSettings(s);
        setEventDurations(s.eventDurations);
        setRegDays(s.registrationDurationDays);
        setGapMinutes(s.gapBetweenEventsMinutes);
        setDefaultDuration(s.defaultRoundDurationMinutes);
        setVideoDeadlineHours(minutesToHours(s.videoDeadlineMinutes));
        setAutoPublishLead(String(s.autoPublishLeadMinutes ?? 30));
        setWarningLead(String(s.publishWarningLeadHours ?? 5));
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await updateSystemSettings({
        eventDurations,
        registrationDurationDays: regDays,
        gapBetweenEventsMinutes: gapMinutes,
        defaultRoundDurationMinutes: defaultDuration,
        videoDeadlineMinutes: hoursToMinutes(videoDeadlineHours) ?? 1440,
        autoPublishLeadMinutes: Math.max(0, Number(autoPublishLead) || 0),
        publishWarningLeadHours: Math.max(0, Number(warningLead) || 0),
      });
      setSettings(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <p className="text-zinc-500">Loading settings…</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
          System Settings
        </h1>
        <Link href="/admin" className="text-xs text-zinc-500 transition hover:text-zinc-300">
          ← Back
        </Link>
      </div>

      {error && (
        <div className="mb-4 rounded bg-red-100 px-4 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="space-y-6">
        {/* ── Scheduling Defaults ── */}
        <section className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900/30">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-zinc-500">
            Scheduling Defaults
          </h2>
          <p className="mb-4 text-xs text-zinc-500">
            These values are used by the auto-scheduler when creating or editing competitions.
          </p>

          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs text-zinc-500">
                Registration Duration
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  value={regDays}
                  onChange={(e) => setRegDays(Number(e.target.value))}
                  className={`w-20 ${INPUT}`}
                />
                <span className="text-xs text-zinc-400">days</span>
              </div>
              <p className="mt-1 text-[11px] text-zinc-500">
                Gap between registration open and close
              </p>
            </div>

            <div>
              <label className="mb-1 block text-xs text-zinc-500">
                Gap Between Events
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={0}
                  value={gapMinutes}
                  onChange={(e) => setGapMinutes(Number(e.target.value))}
                  className={`w-20 ${INPUT}`}
                />
                <span className="text-xs text-zinc-400">min</span>
              </div>
              <p className="mt-1 text-[11px] text-zinc-500">
                Break between back-to-back events
              </p>
            </div>

            <div>
              <label className="mb-1 block text-xs text-zinc-500">
                Default Round Duration
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  value={defaultDuration}
                  onChange={(e) => setDefaultDuration(Number(e.target.value))}
                  className={`w-20 ${INPUT}`}
                />
                <span className="text-xs text-zinc-400">min</span>
              </div>
              <p className="mt-1 text-[11px] text-zinc-500">
                Fallback if no per-event duration is set
              </p>
            </div>
          </div>
        </section>

        {/* ── Per-Event Durations ── */}
        <section className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900/30">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-zinc-500">
            Event Round Durations
          </h2>
          <p className="mb-4 text-xs text-zinc-500">
            How long each round lasts per event type. Used by the auto-scheduler.
          </p>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {EVENT_IDS.map((id) => (
              <div
                key={id}
                className="flex items-center gap-2 rounded-lg border border-zinc-100 bg-zinc-50 px-3 py-2 dark:border-zinc-800/60 dark:bg-zinc-900/50"
              >
                <EventIcon eventId={id} size={18} />
                <span className="min-w-[5rem] text-sm text-zinc-700 dark:text-zinc-300">
                  {eventDisplayName(id)}
                </span>
                <input
                  type="number"
                  min={1}
                  value={eventDurations[id] ?? defaultDuration}
                  onChange={(e) =>
                    setEventDurations((prev) => ({
                      ...prev,
                      [id]: Number(e.target.value),
                    }))
                  }
                  className={`w-16 ${INPUT}`}
                />
                <span className="text-xs text-zinc-400">min</span>
              </div>
            ))}
          </div>
        </section>

        {/* ── Competition Defaults ── */}
        <section className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900/30">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-zinc-500">
            Competition Defaults
          </h2>

          <div>
            <label className="mb-1 block text-xs text-zinc-500">
              Video Upload Deadline
            </label>
            {/* Entered in hours to match the per-competition field; stored in
                minutes, which is what every deadline calculation uses. */}
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                step="0.5"
                value={videoDeadlineHours}
                onChange={(e) => setVideoDeadlineHours(e.target.value)}
                className={`w-24 ${INPUT}`}
              />
              <span className="text-xs text-zinc-400">hours</span>
              <span className="text-xs text-zinc-500">
                after each round closes
              </span>
            </div>
          </div>

          <div className="mt-5">
            <label className="mb-1 block text-xs text-zinc-500">
              Auto-publish Results
            </label>
            {/* Rounds open on the clock whether or not anyone published, and a
                round with no shortlist admits nobody. This is the backstop. */}
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                value={autoPublishLead}
                onChange={(e) => setAutoPublishLead(e.target.value)}
                className={`w-24 ${INPUT}`}
              />
              <span className="text-xs text-zinc-400">minutes</span>
              <span className="text-xs text-zinc-500">
                before the next round opens
              </span>
            </div>
            <p className="mt-1 text-[11px] text-zinc-500">
              {Number(autoPublishLead) > 0
                ? "Whatever is verified by then is published, and the shortlist is computed from it. Flagged results are not advanced."
                : "Off — rounds are published by hand only. A round that opens before the previous one is published will admit nobody."}
            </p>
          </div>

          <div className="mt-5">
            <label className="mb-1 block text-xs text-zinc-500">
              Publish Reminder
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                step="0.5"
                value={warningLead}
                onChange={(e) => setWarningLead(e.target.value)}
                disabled={Number(autoPublishLead) <= 0}
                className={`w-24 ${INPUT} disabled:opacity-40`}
              />
              <span className="text-xs text-zinc-400">hours</span>
              <span className="text-xs text-zinc-500">
                before auto-publish, email the organiser and judges
              </span>
            </div>
          </div>
        </section>

        {/* ── Save ── */}
        <div className="flex items-center gap-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <button
            disabled={saving}
            onClick={handleSave}
            className="rounded-lg bg-emerald-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save Settings"}
          </button>
          {saved && (
            <span className="text-sm text-emerald-400">Settings saved</span>
          )}
        </div>

        {/* ── Rule Sets ── */}
        <RuleSetsSection />
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   Rule Sets Section
   ════════════════════════════════════════════════════════════════════════════ */

const RS_INPUT =
  "rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";

function RuleSetsSection() {
  const [sets, setSets] = useState<RuleSetDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editContent, setEditContent] = useState("");
  const [busy, setBusy] = useState(false);

  // New rule set form
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newContent, setNewContent] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    fetchAdminRuleSets()
      .then(setSets)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await createRuleSet({ name: newName.trim(), content: newContent });
      setNewName("");
      setNewContent("");
      setShowNew(false);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleUpdate = async () => {
    if (!editingId || !editName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await updateRuleSet(editingId, { name: editName.trim(), content: editContent });
      setEditingId(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await deleteRuleSet(id);
      if (editingId === id) setEditingId(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (rs: RuleSetDto) => {
    setEditingId(rs.id);
    setEditName(rs.name);
    setEditContent(rs.content);
    setShowNew(false);
  };

  return (
    <section className="mt-6 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900/30">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
          Competition Rule Sets
        </h2>
        <button
          onClick={() => { setShowNew(!showNew); setEditingId(null); }}
          className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500"
        >
          + New Rule Set
        </button>
      </div>
      <p className="mb-4 text-xs text-zinc-500">
        Create reusable rule sets here. When creating or managing a competition, select a rule set instead of writing rules from scratch.
      </p>

      {error && (
        <div className="mb-3 rounded bg-red-100 px-3 py-2 text-xs text-red-700 dark:bg-red-900/30 dark:text-red-300">
          {error}
        </div>
      )}

      {/* New rule set form */}
      {showNew && (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900/50 dark:bg-emerald-950/20">
          <h3 className="mb-3 text-xs font-semibold text-zinc-700 dark:text-zinc-300">Create New Rule Set</h3>
          <div className="mb-3">
            <label className="mb-1 block text-xs text-zinc-500">Name</label>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Standard WCA Rules, Speed Challenge Rules"
              className={`w-full ${RS_INPUT}`}
            />
          </div>
          <div className="mb-3">
            <label className="mb-1 block text-xs text-zinc-500">Rules (Markdown)</label>
            <textarea
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              placeholder="Write competition rules here. Markdown formatting supported."
              rows={6}
              className={`w-full font-mono ${RS_INPUT}`}
            />
          </div>
          <div className="flex gap-2">
            <button
              disabled={busy || !newName.trim()}
              onClick={handleCreate}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
            >
              {busy ? "Creating…" : "Create"}
            </button>
            <button
              onClick={() => setShowNew(false)}
              className="rounded-lg px-4 py-2 text-xs text-zinc-500 transition hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Existing rule sets */}
      {loading ? (
        <p className="text-xs text-zinc-500">Loading rule sets…</p>
      ) : sets.length === 0 ? (
        <p className="text-xs text-zinc-500">No rule sets created yet.</p>
      ) : (
        <div className="space-y-2">
          {sets.map((rs) => (
            <div
              key={rs.id}
              className={`rounded-lg border p-3 transition ${
                editingId === rs.id
                  ? "border-emerald-300 bg-emerald-50/50 dark:border-emerald-800 dark:bg-emerald-950/20"
                  : "border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/50"
              }`}
            >
              {editingId === rs.id ? (
                <>
                  <div className="mb-3">
                    <label className="mb-1 block text-xs text-zinc-500">Name</label>
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className={`w-full ${RS_INPUT}`}
                    />
                  </div>
                  <div className="mb-3">
                    <label className="mb-1 block text-xs text-zinc-500">Rules (Markdown)</label>
                    <textarea
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      rows={8}
                      className={`w-full font-mono ${RS_INPUT}`}
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      disabled={busy || !editName.trim()}
                      onClick={handleUpdate}
                      className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
                    >
                      {busy ? "Updating…" : "Update"}
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      className="rounded-lg px-4 py-2 text-xs text-zinc-500 transition hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    >
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{rs.name}</p>
                    <p className="mt-0.5 text-xs text-zinc-500">
                      {rs.content ? `${rs.content.slice(0, 80)}${rs.content.length > 80 ? "…" : ""}` : "No content"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => startEdit(rs)}
                      className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-600 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                    >
                      Edit
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => handleDelete(rs.id)}
                      className="rounded border border-red-300 px-2 py-1 text-xs text-red-500 transition hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-950/30 disabled:opacity-40"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
