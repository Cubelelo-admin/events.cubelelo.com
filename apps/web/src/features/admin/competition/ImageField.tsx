"use client";

import { useEffect, useState } from "react";
import { assetUrl } from "@/lib/api";
import { IMAGE_ACCEPT } from "./competitionFields";

const FIELD =
  "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 file:mr-3 file:rounded file:border-0 file:bg-emerald-600 file:px-3 file:py-1 file:text-xs file:font-semibold file:text-white hover:file:bg-emerald-500 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";

export interface ImageFieldProps {
  label: string;
  hint: string;
  /** Already-saved image, if any. Manage has one; Create never does. */
  currentUrl?: string | null;
  /** Picked but not yet uploaded. Create holds the file until the competition exists. */
  pendingFile?: File | null;
  /** Called with the picked file, or null when the pick is cleared. */
  onPick: (file: File | null) => void;
  busy?: boolean;
  /** Marks the field required, so a missing banner is visible before publish. */
  required?: boolean;
}

/**
 * Banner picker for the admin competition screens.
 *
 * Shared by Create and Manage so the two cannot drift. The difference between
 * them is only *when* the file is sent: Manage uploads immediately and gets back
 * a URL, while on Create the competition does not exist yet, so the file is held
 * and uploaded after the record is created.
 *
 * The preview is the point. Create previously showed nothing but a filename, so
 * there was no way to see what had been picked or to undo a wrong one — and the
 * banner's absence only surfaced as a `banner_required` rejection at publish.
 */
export function ImageField({
  label,
  hint,
  currentUrl,
  pendingFile,
  onPick,
  busy = false,
  required = false,
}: ImageFieldProps) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Object URLs hold the file in memory until revoked, so each one is released
  // when it is replaced or the field unmounts.
  useEffect(() => {
    if (!pendingFile) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(pendingFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [pendingFile]);

  const shown = previewUrl ?? (currentUrl ? assetUrl(currentUrl) : null);

  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-zinc-500">
        {label} <span className="text-zinc-400">({hint})</span>
        {required && !shown && <span className="ml-1 text-amber-500">· required to publish</span>}
      </label>

      {shown && (
        <div className="mb-2 flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={shown} alt="" className="h-16 w-full rounded object-cover" />
          {pendingFile && (
            <button
              type="button"
              onClick={() => onPick(null)}
              title="Remove this pick"
              className="shrink-0 rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-500 transition hover:text-red-400 dark:border-zinc-700"
            >
              Remove
            </button>
          )}
        </div>
      )}

      <input
        type="file"
        accept={IMAGE_ACCEPT}
        disabled={busy}
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
        className={FIELD}
      />

      {busy && <p className="mt-1 text-[11px] text-zinc-500">Uploading…</p>}
      {pendingFile && !busy && (
        <p className="mt-1 text-[11px] text-emerald-500">
          {pendingFile.name} — uploads when you save
        </p>
      )}
    </div>
  );
}
