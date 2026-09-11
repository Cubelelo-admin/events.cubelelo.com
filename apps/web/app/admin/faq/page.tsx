"use client";

import { useCallback, useEffect, useState } from "react";
import {
  fetchAdminFaq,
  createFaq,
  updateFaq,
  deleteFaq,
  type FaqDto,
} from "@/lib/api";
import { ConfirmModal } from "@/components/ui/Modal";

const EMPTY = { question: "", answerMd: "", order: 0, published: true };

export default function AdminFaqPage() {
  const [list, setList] = useState<FaqDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<FaqDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FaqDto | null>(null);

  const load = useCallback(() => {
    fetchAdminFaq()
      .then((rows) => setList([...rows].sort((a, b) => a.order - b.order)))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => {
    setForm({ ...EMPTY, order: list.length });
    setEditing(null);
    setCreating(true);
  };
  const openEdit = (f: FaqDto) => {
    setForm({ question: f.question, answerMd: f.answerMd, order: f.order, published: f.published });
    setEditing(f);
    setCreating(false);
  };
  const closeForm = () => { setCreating(false); setEditing(null); setError(null); };

  const save = async () => {
    if (!form.question.trim()) { setError("Question is required."); return; }
    if (!form.answerMd.trim()) { setError("Answer is required."); return; }
    setBusy("save");
    setError(null);
    try {
      const payload = {
        question: form.question,
        answerMd: form.answerMd,
        order: form.order,
        published: form.published,
      };
      if (editing) {
        await updateFaq(editing.id, payload);
      } else {
        await createFaq(payload);
      }
      closeForm();
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const togglePublished = async (f: FaqDto) => {
    setBusy(f.id);
    try { await updateFaq(f.id, { published: !f.published }); load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  const del = async (f: FaqDto) => {
    setBusy(`del-${f.id}`);
    try { await deleteFaq(f.id); load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  return (
    <div className="mx-auto max-w-[1400px] px-8 py-10">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">FAQs</h1>
          <p className="mt-1 text-sm text-zinc-500">Questions and answers shown on the public FAQ page. Markdown is supported in answers.</p>
        </div>
        {!creating && !editing && (
          <button onClick={openCreate}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500">
            + New FAQ
          </button>
        )}
      </div>

      {error && <div className="mb-4 rounded bg-red-100 px-4 py-2 text-red-700 dark:bg-red-900/30 dark:text-red-300">{error}</div>}

      {(creating || editing) && (
        <div className="mb-6 rounded-xl border border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900/50 p-5">
          <h2 className="mb-4 text-sm font-semibold text-zinc-700 dark:text-zinc-300">
            {editing ? "Edit FAQ" : "New FAQ"}
          </h2>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs text-zinc-500">Question</label>
              <input value={form.question}
                onChange={(e) => setForm((f) => ({ ...f, question: e.target.value }))}
                placeholder="How do I register for a competition?"
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-500">Answer <span className="text-zinc-400">(Markdown)</span></label>
              <textarea value={form.answerMd}
                onChange={(e) => setForm((f) => ({ ...f, answerMd: e.target.value }))}
                placeholder="Answer in **markdown**..."
                rows={5}
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-sm text-zinc-900 placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs text-zinc-500">Display Order</label>
                <input type="number" value={form.order}
                  onChange={(e) => setForm((f) => ({ ...f, order: Number(e.target.value) }))}
                  className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 focus:border-zinc-500 focus:outline-none" />
              </div>
              <label className="flex items-center gap-2 self-end pb-2 text-sm text-zinc-600 dark:text-zinc-400 cursor-pointer">
                <input type="checkbox" checked={form.published}
                  onChange={(e) => setForm((f) => ({ ...f, published: e.target.checked }))}
                  className="accent-emerald-500" />
                Published
              </label>
            </div>
            <div className="flex gap-3 pt-1">
              <button onClick={save} disabled={busy === "save"}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">
                {busy === "save" ? "Saving..." : editing ? "Save Changes" : "Create"}
              </button>
              <button onClick={closeForm}
                className="rounded-lg border border-zinc-300 px-4 py-2 text-sm text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-zinc-500">Loading...</p>
      ) : list.length === 0 ? (
        <div className="rounded-xl border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/30 p-10 text-center text-zinc-500">
          No FAQs yet. Create one to display on the public FAQ page.
        </div>
      ) : (
        <div className="space-y-3">
          {list.map((f) => (
            <div key={f.id} className="rounded-xl border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/30 p-4">
              <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  {f.published ? (
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">Published</span>
                  ) : (
                    <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:bg-zinc-800">Draft</span>
                  )}
                  <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">#{f.order}</span>
                  <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">{f.question}</h3>
                </div>
              </div>
              <p className="mb-3 whitespace-pre-wrap text-xs text-zinc-500">{f.answerMd}</p>
              <div className="flex flex-wrap gap-2">
                <button onClick={() => openEdit(f)}
                  className="rounded border border-zinc-300 px-3 py-1 text-xs text-zinc-600 hover:bg-zinc-200 hover:text-zinc-900 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200">
                  Edit
                </button>
                <button onClick={() => togglePublished(f)} disabled={busy === f.id}
                  className="rounded border border-zinc-300 px-3 py-1 text-xs text-zinc-600 hover:bg-zinc-200 hover:text-zinc-900 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 disabled:opacity-40">
                  {f.published ? "Unpublish" : "Publish"}
                </button>
                <button onClick={() => setDeleteTarget(f)} disabled={busy === `del-${f.id}`}
                  className="rounded border border-red-900/40 px-3 py-1 text-xs text-red-500 hover:bg-red-950/30 disabled:opacity-40">
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <ConfirmModal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (!deleteTarget) return;
          setDeleteTarget(null);
          del(deleteTarget);
        }}
        title="Delete FAQ"
        description={<>Delete <strong>{deleteTarget?.question}</strong>? This cannot be undone.</>}
        confirmLabel="Delete"
      />
    </div>
  );
}
