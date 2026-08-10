"use client";

import { useCallback, useEffect, useState } from "react";
import {
  fetchPromoCodes,
  fetchCompetitions,
  fetchCompetition,
  createPromoCode,
  updatePromoCode,
  deletePromoCode,
  type PromoCodeDto,
  type PromoCodeType,
  type CompetitionSummary,
  type EventDetail,
} from "@/lib/api";
import { ConfirmModal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { EmptyState } from "@/components/EmptyState";
import { eventDisplayName } from "@/lib/eventNames";

const INPUT = "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-600";
const SELECT = "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";

const TYPE_LABELS: Record<PromoCodeType, string> = {
  competition: "Competition",
  welcome: "Welcome",
  general: "General",
  special: "Special",
};

const TYPE_DESCRIPTIONS: Record<PromoCodeType, string> = {
  competition: "Tied to a specific competition — valid while registration is open",
  welcome: "For new users only (no paid participation yet) — 1 per user, date range",
  general: "Available to everyone — 1 per user, date range",
  special: "Available to everyone — 1 per user, limited total count, date range",
};

function toLocalDatetime(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60000);
  return local.toISOString().slice(0, 16);
}

export default function AdminPromoCodesPage() {
  const toast = useToast();
  const [codes, setCodes] = useState<PromoCodeDto[]>([]);
  const [comps, setComps] = useState<CompetitionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [filterCompId, setFilterCompId] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<PromoCodeDto | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Form state
  const [couponType, setCouponType] = useState<PromoCodeType>("competition");
  const [code, setCode] = useState("");
  const [discountType, setDiscountType] = useState<"percentage" | "flat">("percentage");
  const [discountValue, setDiscountValue] = useState("");
  const [maxUses, setMaxUses] = useState("");
  const [competitionId, setCompetitionId] = useState("");
  const [competitionEventId, setCompetitionEventId] = useState("");
  const [compEvents, setCompEvents] = useState<EventDetail[]>([]);
  const [validFrom, setValidFrom] = useState("");
  const [validTo, setValidTo] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!competitionId) { setCompEvents([]); setCompetitionEventId(""); return; }
    fetchCompetition(competitionId)
      .then((d) => setCompEvents(d.events))
      .catch(() => setCompEvents([]));
  }, [competitionId]);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([fetchPromoCodes(), fetchCompetitions()])
      .then(([promos, competitions]) => {
        setCodes(promos);
        setComps(competitions);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const filteredCodes = filterCompId
    ? codes.filter((c) => c.competitionId === filterCompId)
    : codes;

  const resetForm = () => {
    setCouponType("competition");
    setCode("");
    setDiscountType("percentage");
    setDiscountValue("");
    setMaxUses("");
    setCompetitionId("");
    setCompetitionEventId("");
    setCompEvents([]);
    setValidFrom("");
    setValidTo("");
    setShowForm(false);
    setEditingId(null);
  };

  const startEdit = (p: PromoCodeDto) => {
    setEditingId(p.id);
    setCouponType(p.type);
    setCode(p.code);
    setDiscountType(p.discountType);
    setDiscountValue(
      p.discountType === "flat" ? (p.discountValue / 100).toString() : p.discountValue.toString(),
    );
    setMaxUses(p.maxUses > 0 ? p.maxUses.toString() : "");
    setCompetitionId(p.competitionId ?? "");
    setCompetitionEventId(p.competitionEventId ?? "");
    setValidFrom(toLocalDatetime(p.validFrom));
    setValidTo(toLocalDatetime(p.validTo));
    setShowForm(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const payload = {
        code,
        type: couponType,
        discountType,
        discountValue: discountType === "flat" ? Math.round(Number(discountValue) * 100) : Number(discountValue),
        maxUses: maxUses ? Number(maxUses) : 0,
        competitionId: competitionId || undefined,
        competitionEventId: competitionEventId || undefined,
        validFrom: validFrom ? new Date(validFrom).toISOString() : undefined,
        validTo: validTo ? new Date(validTo).toISOString() : undefined,
      };
      if (editingId) {
        await updatePromoCode(editingId, payload);
        toast.show("Promo code updated", "success");
      } else {
        await createPromoCode(payload);
        toast.show("Promo code created", "success");
      }
      resetForm();
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (promo: PromoCodeDto) => {
    try {
      await updatePromoCode(promo.id, { active: !promo.active });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deletePromoCode(deleteTarget.id);
      toast.show(`Deleted promo code ${deleteTarget.code}`, "success");
      setDeleteTarget(null);
      load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setDeleting(false);
    }
  };

  const isEditing = !!editingId;

  return (
    <div className="mx-auto max-w-[1400px] px-8 py-10">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">Promo Codes</h1>
          <select
            value={filterCompId}
            onChange={(e) => setFilterCompId(e.target.value)}
            className="w-[220px] flex-shrink-0 truncate rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
          >
            <option value="">All competitions</option>
            {comps.map((c) => (
              <option key={c.id} value={c.id}>{c.title}</option>
            ))}
          </select>
        </div>
        <button
          onClick={() => { if (showForm) resetForm(); else setShowForm(true); }}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500"
        >
          {showForm ? "Cancel" : "+ New Code"}
        </button>
      </div>

      {error && <div className="mb-4 rounded bg-red-100 px-4 py-2 text-red-700 dark:bg-red-900/30 dark:text-red-300">{error}</div>}

      {showForm && (
        <div className="mb-6 rounded-xl border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/30 p-5">
          <h2 className="mb-4 text-sm font-semibold text-zinc-700 dark:text-zinc-300">
            {isEditing ? "Edit Promo Code" : "Create Promo Code"}
          </h2>

          {/* Coupon type selector */}
          <div className="mb-4 flex gap-2">
            {(Object.keys(TYPE_LABELS) as PromoCodeType[]).map((t) => (
              <button
                key={t}
                onClick={() => {
                  setCouponType(t);
                  if (t === "competition") { setValidFrom(""); setValidTo(""); }
                  if (t !== "competition") { setCompetitionId(""); setCompetitionEventId(""); }
                }}
                className={`rounded-lg px-4 py-2 text-sm font-medium transition ${couponType === t
                    ? "bg-emerald-600 text-white"
                    : "border border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                  }`}
              >
                {TYPE_LABELS[t]}
              </button>
            ))}
          </div>
          <p className="mb-4 text-xs text-zinc-500">{TYPE_DESCRIPTIONS[couponType]}</p>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs text-zinc-500">Code</label>
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="e.g. CUBELELO20"
                className={INPUT}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-500">Discount Type</label>
              <select
                value={discountType}
                onChange={(e) => setDiscountType(e.target.value as "percentage" | "flat")}
                className={SELECT}
              >
                <option value="percentage">Percentage (%)</option>
                <option value="flat">Flat (₹)</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-500">
                Discount Value {discountType === "percentage" ? "(%)" : "(₹)"}
              </label>
              <input
                type="number"
                value={discountValue}
                onChange={(e) => setDiscountValue(e.target.value)}
                placeholder={discountType === "percentage" ? "e.g. 20" : "e.g. 100"}
                className={INPUT}
              />
            </div>

            {/* Max uses — shown for competition & general */}
            {couponType !== "welcome" && (
              <div>
                <label className="mb-1 block text-xs text-zinc-500">Max Uses (0 = unlimited)</label>
                <input
                  type="number"
                  value={maxUses}
                  onChange={(e) => setMaxUses(e.target.value)}
                  placeholder="0"
                  className={INPUT}
                />
              </div>
            )}

            {/* Competition selector — for competition type */}
            {couponType === "competition" && (
              <>
                <div>
                  <label className="mb-1 block text-xs text-zinc-500">Competition</label>
                  <select
                    value={competitionId}
                    onChange={(e) => { setCompetitionId(e.target.value); setCompetitionEventId(""); }}
                    className={SELECT}
                  >
                    <option value="">Select competition...</option>
                    {comps.map((c) => (
                      <option key={c.id} value={c.id}>{c.title}</option>
                    ))}
                  </select>
                </div>
                {compEvents.length > 0 && (
                  <div>
                    <label className="mb-1 block text-xs text-zinc-500">Event (optional)</label>
                    <select
                      value={competitionEventId}
                      onChange={(e) => setCompetitionEventId(e.target.value)}
                      className={SELECT}
                    >
                      <option value="">All events</option>
                      {compEvents.map((ev) => (
                        <option key={ev.id} value={ev.id}>
                          {eventDisplayName(ev.eventType)}{ev.fee != null ? ` (₹${(ev.fee / 100).toFixed(2)})` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </>
            )}

            {/* Date range — for welcome & general */}
            {couponType !== "competition" && (
              <>
                <div>
                  <label className="mb-1 block text-xs text-zinc-500">Valid From</label>
                  <input
                    type="datetime-local"
                    value={validFrom}
                    onChange={(e) => setValidFrom(e.target.value)}
                    className={INPUT}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-zinc-500">Valid To</label>
                  <input
                    type="datetime-local"
                    value={validTo}
                    onChange={(e) => setValidTo(e.target.value)}
                    className={INPUT}
                  />
                </div>
              </>
            )}

            {/* General & Special types get optional competition scope */}
            {(couponType === "general" || couponType === "special") && (
              <>
                <div>
                  <label className="mb-1 block text-xs text-zinc-500">Competition (optional)</label>
                  <select
                    value={competitionId}
                    onChange={(e) => { setCompetitionId(e.target.value); setCompetitionEventId(""); }}
                    className={SELECT}
                  >
                    <option value="">All competitions</option>
                    {comps.map((c) => (
                      <option key={c.id} value={c.id}>{c.title}</option>
                    ))}
                  </select>
                </div>
                {compEvents.length > 0 && (
                  <div>
                    <label className="mb-1 block text-xs text-zinc-500">Event (optional)</label>
                    <select
                      value={competitionEventId}
                      onChange={(e) => setCompetitionEventId(e.target.value)}
                      className={SELECT}
                    >
                      <option value="">All events</option>
                      {compEvents.map((ev) => (
                        <option key={ev.id} value={ev.id}>
                          {eventDisplayName(ev.eventType)}{ev.fee != null ? ` (₹${(ev.fee / 100).toFixed(2)})` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="mt-4 flex items-center gap-3">
            <button
              disabled={saving || !code.trim() || !discountValue || (couponType === "competition" && !competitionId)}
              onClick={handleSave}
              className="rounded-lg bg-emerald-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-40"
            >
              {saving ? "Saving…" : isEditing ? "Save Changes" : "Create Code"}
            </button>
            {isEditing && (
              <button
                onClick={resetForm}
                className="rounded-lg border border-zinc-300 px-4 py-2 text-sm text-zinc-600 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
              >
                Cancel Edit
              </button>
            )}
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-zinc-500">Loading…</p>
      ) : filteredCodes.length === 0 ? (
        <EmptyState icon="🏷️" title="No promo codes yet" description={'Click "+ New Code" to create one.'} />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/60 text-left text-[11px] uppercase tracking-wider text-zinc-500">
                <th className="px-4 py-3">Code</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Scope</th>
                <th className="px-4 py-3">Discount</th>
                <th className="px-4 py-3 text-center">Usage</th>
                <th className="px-4 py-3">Validity</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredCodes.map((p) => (
                <tr
                  key={p.id}
                  className={`border-b border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800/50 dark:hover:bg-zinc-900/40 ${editingId === p.id ? "ring-2 ring-emerald-500/30 bg-emerald-50/50 dark:bg-emerald-900/10" : ""}`}
                >
                  <td className="px-4 py-3 font-mono font-semibold text-zinc-800 dark:text-zinc-200">
                    {p.code}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${p.type === "competition"
                        ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400"
                        : p.type === "welcome"
                          ? "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-400"
                          : p.type === "special"
                            ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400"
                            : "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                      }`}>
                      {p.type ?? "general"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-500">
                    {p.competitionId
                      ? comps.find((c) => c.id === p.competitionId)?.title ?? "Competition"
                      : "All"}
                    {p.competitionEventId && (
                      <span className="ml-1 text-emerald-500">(event)</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">
                    {p.discountType === "percentage"
                      ? `${p.discountValue}%`
                      : `₹${(p.discountValue / 100).toFixed(2)}`}
                  </td>
                  <td className="px-4 py-3 text-center text-zinc-400">
                    {p.usedCount}{p.maxUses > 0 ? ` / ${p.maxUses}` : " / ∞"}
                    {p.maxUsesPerUser > 0 && (
                      <span className="ml-1 text-[10px] text-purple-400">({p.maxUsesPerUser}/user)</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-500">
                    {p.type === "competition"
                      ? "Registration period"
                      : <>
                        {p.validFrom ? new Date(p.validFrom).toLocaleDateString() : "—"}
                        {" → "}
                        {p.validTo ? new Date(p.validTo).toLocaleDateString() : "—"}
                      </>
                    }
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${p.active
                        ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400"
                        : "bg-zinc-200 text-zinc-500 dark:bg-zinc-800"
                      }`}>
                      {p.active ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => startEdit(p)}
                        className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-600 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => toggleActive(p)}
                        className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-600 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                      >
                        {p.active ? "Deactivate" : "Activate"}
                      </button>
                      <button
                        onClick={() => setDeleteTarget(p)}
                        className="rounded border border-red-900/50 px-2 py-1 text-xs text-red-400 transition hover:bg-red-900/30"
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
      )}

      <ConfirmModal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
        loading={deleting}
        title="Delete promo code?"
        description={
          <>
            This permanently deletes <strong className="font-mono">{deleteTarget?.code}</strong>. Anyone with this
            code will no longer be able to use it. This cannot be undone.
          </>
        }
        confirmLabel="Delete code"
      />
    </div>
  );
}
