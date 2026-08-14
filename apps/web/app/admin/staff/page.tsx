"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  fetchAdminUsers,
  updateAdminUser,
  createStaff,
  type AdminUserDto,
} from "@/lib/api";
import { ConfirmModal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { EmptyState } from "@/components/EmptyState";


const STAFF_ROLES = ["judge", "moderator"] as const;

const ROLE_INFO = [
  {
    role: "Admin",
    color: "border-red-200 dark:border-red-900/40",
    badge: "text-red-700 bg-red-100 dark:text-red-400 dark:bg-red-900/30",
    icon: "🛡️",
    summary: "Full platform access",
    permissions: [
      "Create and manage all competitions",
      "Manage users, payments, and promo codes",
      "System settings, rank tiers, and content pages",
      "Staff creation and role assignment",
      "Verification and appeals for all competitions",
    ],
  },
  {
    role: "Moderator",
    color: "border-purple-200 dark:border-purple-900/40",
    badge: "text-purple-700 bg-purple-100 dark:text-purple-400 dark:bg-purple-900/30",
    icon: "⚙️",
    summary: "Scoped to their own competitions",
    permissions: [
      "Create new competitions",
      "Manage events, rounds, scrambles, and results — only for competitions they created",
      "Verification, appeals, and judge assignment for their competitions",
      "Email participants and export data for their competitions",
      "Cannot access payments, users, promo codes, or system settings",
    ],
  },
  {
    role: "Judge",
    color: "border-blue-200 dark:border-blue-900/40",
    badge: "text-blue-700 bg-blue-100 dark:text-blue-400 dark:bg-blue-900/30",
    icon: "⚖️",
    summary: "Result verification only",
    permissions: [
      "Verify, penalize, or DQ results assigned to them",
      "View result details, video evidence, and audit history",
      "Cannot create or manage competitions",
      "Cannot access admin panel or any management features",
    ],
  },
];

export default function AdminStaffPage() {
  const toast = useToast();
  const [staff, setStaff] = useState<AdminUserDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ email: "", name: "", role: "judge" as "judge" | "moderator" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pendingRoleChange, setPendingRoleChange] = useState<{ user: AdminUserDto; newRole: string } | null>(null);
  const [demoteTarget, setDemoteTarget] = useState<AdminUserDto | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [editTarget, setEditTarget] = useState<AdminUserDto | null>(null);
  const [editForm, setEditForm] = useState({ name: "", email: "", mobileNo: "" });
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<AdminUserDto[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    Promise.all([
      fetchAdminUsers({ role: "admin" }),
      fetchAdminUsers({ role: "moderator" }),
      fetchAdminUsers({ role: "judge" }),
    ])
      .then(([admins, mods, judges]) => setStaff([...admins, ...mods, ...judges]))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    if (!form.email.trim() || !form.name.trim()) {
      setError("Email and name are required.");
      return;
    }
    setBusy("create");
    setError(null);
    setSuccess(null);
    try {
      const result = await createStaff(form);
      setSuccess(`Assigned ${result.role} role to ${result.name} (${result.clId})`);
      setForm({ email: "", name: "", role: "judge" });
      setSearchQuery("");
      setSearchResults([]);
      setCreating(false);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const requestRoleChange = (user: AdminUserDto, newRole: string) => {
    if (newRole === user.role) return;
    setPendingRoleChange({ user, newRole });
  };

  const confirmRoleChange = async () => {
    if (!pendingRoleChange) return;
    const { user, newRole } = pendingRoleChange;
    setConfirmBusy(true);
    try {
      await updateAdminUser(user.id, { role: newRole });
      toast.show(`${user.name} is now a ${newRole}`, "success");
      setPendingRoleChange(null);
      load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setConfirmBusy(false);
    }
  };

  const openEdit = (user: AdminUserDto) => {
    setEditTarget(user);
    setEditForm({ name: user.name, email: user.email, mobileNo: user.mobileNo ?? "" });
  };

  const saveEdit = async () => {
    if (!editTarget) return;
    setConfirmBusy(true);
    try {
      const body: { name?: string; email?: string; mobileNo?: string } = {};
      if (editForm.name.trim() && editForm.name.trim() !== editTarget.name) body.name = editForm.name.trim();
      if (editForm.email.trim() && editForm.email.trim() !== editTarget.email) body.email = editForm.email.trim();
      if (editForm.mobileNo.trim() !== (editTarget.mobileNo ?? "")) body.mobileNo = editForm.mobileNo.trim();
      if (Object.keys(body).length === 0) { setEditTarget(null); setConfirmBusy(false); return; }
      await updateAdminUser(editTarget.id, body);
      toast.show(`Updated ${editForm.name || editTarget.name}`, "success");
      setEditTarget(null);
      load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setConfirmBusy(false);
    }
  };

  const confirmDemote = async () => {
    if (!demoteTarget) return;
    setConfirmBusy(true);
    try {
      await updateAdminUser(demoteTarget.id, { role: "user" });
      toast.show(`${demoteTarget.name} removed from staff`, "success");
      setDemoteTarget(null);
      load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setConfirmBusy(false);
    }
  };

  const roleColor = (role: string) => {
    switch (role) {
      case "admin": return "text-red-700 bg-red-100 dark:text-red-400 dark:bg-red-900/30";
      case "moderator": return "text-purple-700 bg-purple-100 dark:text-purple-400 dark:bg-purple-900/30";
      case "judge": return "text-blue-700 bg-blue-100 dark:text-blue-400 dark:bg-blue-900/30";
      default: return "text-zinc-600 bg-zinc-200 dark:text-zinc-400 dark:bg-zinc-800";
    }
  };

  const staffCounts = {
    admin: staff.filter((u) => u.role === "admin").length,
    moderator: staff.filter((u) => u.role === "moderator").length,
    judge: staff.filter((u) => u.role === "judge").length,
  };

  return (
    <div className="mx-auto max-w-[1400px] px-8 py-10">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">Staff Management</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Create and manage staff accounts. Each role has different levels of access to the platform.
        </p>
      </div>

      {/* ── Roles overview ── */}
      <div className="mb-8 rounded-xl border border-zinc-200 bg-zinc-50/50 dark:border-zinc-800 dark:bg-zinc-900/30 p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Roles & Permissions</h2>
          <div className="flex items-center gap-3 text-xs text-zinc-500">
            <span>{staffCounts.admin} admin{staffCounts.admin !== 1 ? "s" : ""}</span>
            <span className="text-zinc-300 dark:text-zinc-700">·</span>
            <span>{staffCounts.moderator} moderator{staffCounts.moderator !== 1 ? "s" : ""}</span>
            <span className="text-zinc-300 dark:text-zinc-700">·</span>
            <span>{staffCounts.judge} judge{staffCounts.judge !== 1 ? "s" : ""}</span>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          {ROLE_INFO.map((info) => (
            <div key={info.role} className={`rounded-lg border ${info.color} bg-white p-4 dark:bg-zinc-900/60`}>
              <div className="mb-2 flex items-center gap-2">
                <span className="text-lg">{info.icon}</span>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${info.badge}`}>
                  {info.role}
                </span>
              </div>
              <p className="mb-3 text-xs font-medium text-zinc-600 dark:text-zinc-400">{info.summary}</p>
              <ul className="space-y-1.5">
                {info.permissions.map((perm, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-500">
                    <span className={`mt-0.5 shrink-0 ${perm.startsWith("Cannot") ? "text-red-400" : "text-emerald-500"}`}>
                      {perm.startsWith("Cannot") ? "✕" : "✓"}
                    </span>
                    {perm}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Create staff — inside roles section */}
        <div className="mt-5 border-t border-zinc-200 pt-4 dark:border-zinc-800">
          {!creating ? (
            <button
              onClick={() => { setCreating(true); setError(null); setSuccess(null); setSearchQuery(""); setSearchResults([]); }}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500"
            >
              + Add Staff Member
            </button>
          ) : (
            <div>
              <h3 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Add Staff Member</h3>
              <p className="mb-4 text-xs text-zinc-500">
                Search for an existing user by name, email, or CL ID to assign them a staff role.
              </p>
              <div className="space-y-3">
                {/* User search */}
                <div className="relative">
                  <label className="mb-1 block text-xs text-zinc-500">Search User</label>
                  <input
                    value={searchQuery}
                    onChange={(e) => {
                      const q = e.target.value;
                      setSearchQuery(q);
                      if (searchTimer.current) clearTimeout(searchTimer.current);
                      if (q.trim().length < 2) { setSearchResults([]); return; }
                      setSearchLoading(true);
                      searchTimer.current = setTimeout(async () => {
                        try {
                          const results = await fetchAdminUsers({ search: q.trim(), limit: 8 });
                          setSearchResults(results);
                        } catch { setSearchResults([]); }
                        finally { setSearchLoading(false); }
                      }, 300);
                    }}
                    placeholder="Type name, email, or CL ID…"
                    className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-600"
                  />
                  {/* Search results dropdown */}
                  {searchQuery.trim().length >= 2 && (searchResults.length > 0 || searchLoading) && (
                    <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-48 overflow-y-auto rounded-lg border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
                      {searchLoading && <p className="px-3 py-2 text-xs text-zinc-400">Searching…</p>}
                      {!searchLoading && searchResults.map((u) => {
                        const alreadyStaff = ["admin", "moderator", "judge"].includes(u.role);
                        return (
                          <button
                            key={u.id}
                            type="button"
                            disabled={alreadyStaff}
                            onClick={() => {
                              setForm({ email: u.email, name: u.name, role: form.role });
                              setSearchQuery("");
                              setSearchResults([]);
                            }}
                            className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition ${
                              alreadyStaff
                                ? "cursor-not-allowed opacity-50"
                                : "hover:bg-zinc-50 dark:hover:bg-zinc-800"
                            }`}
                          >
                            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-xs font-bold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                              {u.name.charAt(0).toUpperCase()}
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="truncate font-medium text-zinc-800 dark:text-zinc-200">{u.name}</p>
                              <p className="truncate text-xs text-zinc-500">{u.email} · {u.clId}</p>
                            </div>
                            {alreadyStaff && (
                              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${roleColor(u.role)}`}>
                                {u.role}
                              </span>
                            )}
                          </button>
                        );
                      })}
                      {!searchLoading && searchResults.length === 0 && (
                        <p className="px-3 py-2 text-xs text-zinc-400">No users found</p>
                      )}
                    </div>
                  )}
                </div>

                {/* Selected user preview or manual entry */}
                {form.email && (
                  <div className="flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50/50 px-3 py-2 dark:border-emerald-900/40 dark:bg-emerald-900/10">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-100 text-sm font-bold text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                      {form.name.charAt(0).toUpperCase() || "?"}
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{form.name}</p>
                      <p className="text-xs text-zinc-500">{form.email}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => { setForm({ email: "", name: "", role: form.role }); setSearchQuery(""); }}
                      className="text-xs text-zinc-400 hover:text-red-400"
                    >
                      ✕
                    </button>
                  </div>
                )}
                <div>
                  <label className="mb-1 block text-xs text-zinc-500">Role</label>
                  <div className="flex gap-4">
                    {STAFF_ROLES.map((r) => (
                      <label key={r} className="flex items-center gap-2 text-sm text-zinc-400 cursor-pointer">
                        <input type="radio" name="role" value={r} checked={form.role === r}
                          onChange={() => setForm((f) => ({ ...f, role: r }))}
                          className="accent-emerald-500" />
                        <span className="capitalize">{r}</span>
                        <span className="text-[10px] text-zinc-600">
                          {r === "judge" ? "(verify results)" : "(manage own competitions)"}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
                <div className="flex gap-3 pt-1">
                  <button onClick={handleCreate} disabled={busy === "create" || !form.email.trim()}
                    className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">
                    {busy === "create" ? "Assigning…" : "Assign Role"}
                  </button>
                  <button onClick={() => { setCreating(false); setError(null); setSearchQuery(""); setSearchResults([]); }}
                    className="rounded-lg border border-zinc-300 px-4 py-2 text-sm text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800">
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {error && <div className="mb-4 rounded bg-red-100 px-4 py-2 text-red-700 dark:bg-red-900/30 dark:text-red-300">{error}</div>}
      {success && <div className="mb-4 rounded bg-emerald-100 px-4 py-2 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">{success}</div>}

      {/* ── Staff table ── */}
      <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Current Staff</h2>

      {loading ? (
        <p className="text-zinc-500">Loading...</p>
      ) : staff.length === 0 ? (
        <EmptyState icon="🧑‍🏫" title="No staff accounts found" description="Create a judge or moderator account to get started." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/60 text-left text-[11px] uppercase tracking-wider text-zinc-500">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">CL ID</th>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Phone</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {staff.map((u) => (
                <tr key={u.id} className="border-b border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800/50 dark:hover:bg-zinc-900/40">
                  <td className="px-4 py-2.5 text-zinc-800 dark:text-zinc-200">{u.name}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-zinc-400">{u.clId}</td>
                  <td className="px-4 py-2.5 text-zinc-500">{u.email}</td>
                  <td className="px-4 py-2.5 text-zinc-500">{u.mobileNo ?? "—"}</td>
                  <td className="px-4 py-2.5">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${roleColor(u.role)}`}>
                      {u.role}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    {u.role !== "admin" && (
                      <div className="flex gap-2">
                        <select
                          value={u.role}
                          onChange={(e) => requestRoleChange(u, e.target.value)}
                          disabled={busy === u.id}
                          className="w-[110px] rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-700 focus:outline-none disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
                        >
                          <option value="judge">Judge</option>
                          <option value="moderator">Moderator</option>
                        </select>
                        <button onClick={() => openEdit(u)}
                          className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800">
                          Edit
                        </button>
                        <button onClick={() => setDemoteTarget(u)} disabled={busy === `demote-${u.id}`}
                          className="rounded border border-red-900/40 px-2 py-1 text-xs text-red-500 hover:bg-red-950/30 disabled:opacity-40">
                          Remove
                        </button>
                      </div>
                    )}
                    {u.role === "admin" && (
                      <span className="text-xs text-zinc-600">System admin</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmModal
        open={!!pendingRoleChange}
        onClose={() => setPendingRoleChange(null)}
        onConfirm={confirmRoleChange}
        loading={confirmBusy}
        destructive={false}
        title="Change role?"
        description={
          <>
            Change <strong>{pendingRoleChange?.user.name}</strong> from{" "}
            <strong className="capitalize">{pendingRoleChange?.user.role}</strong> to{" "}
            <strong className="capitalize">{pendingRoleChange?.newRole}</strong>? This changes what they can access
            immediately.
          </>
        }
        confirmLabel="Change role"
      />

      <ConfirmModal
        open={!!demoteTarget}
        onClose={() => setDemoteTarget(null)}
        onConfirm={confirmDemote}
        loading={confirmBusy}
        title="Remove from staff?"
        description={
          <>
            <strong>{demoteTarget?.name}</strong> will lose their {demoteTarget?.role} access and become a regular
            user.
          </>
        }
        confirmLabel="Remove"
      />

      {/* Edit staff profile modal */}
      {editTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setEditTarget(null)}>
          <div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-700 dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-4 text-lg font-bold text-zinc-900 dark:text-zinc-100">Edit Staff — {editTarget.name}</h2>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs text-zinc-500">Name</label>
                <input value={editForm.name}
                  onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                  className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100" />
              </div>
              <div>
                <label className="mb-1 block text-xs text-zinc-500">Email</label>
                <input value={editForm.email} type="email"
                  onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))}
                  className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100" />
              </div>
              <div>
                <label className="mb-1 block text-xs text-zinc-500">Phone</label>
                <input value={editForm.mobileNo} type="tel"
                  onChange={(e) => setEditForm((f) => ({ ...f, mobileNo: e.target.value }))}
                  placeholder="e.g. +91 9876543210"
                  className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder:text-zinc-600" />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-3">
              <button onClick={() => setEditTarget(null)}
                className="rounded-lg border border-zinc-300 px-4 py-2 text-sm text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800">
                Cancel
              </button>
              <button onClick={saveEdit} disabled={confirmBusy}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">
                {confirmBusy ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
