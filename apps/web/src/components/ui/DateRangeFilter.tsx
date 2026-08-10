"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type DatePreset = "" | "last_week" | "last_month" | "last_3_months" | "last_year" | "custom";

const PRESET_LABELS: Record<DatePreset, string> = {
  "": "All time",
  last_week: "Last week",
  last_month: "Last month",
  last_3_months: "Last 3 months",
  last_year: "Last year",
  custom: "Custom range",
};

function presetToRange(preset: DatePreset): { from: string; to: string } {
  if (!preset || preset === "custom") return { from: "", to: "" };
  const now = new Date();
  const to = now.toISOString();
  const d = new Date(now);
  switch (preset) {
    case "last_week": d.setDate(d.getDate() - 7); break;
    case "last_month": d.setMonth(d.getMonth() - 1); break;
    case "last_3_months": d.setMonth(d.getMonth() - 3); break;
    case "last_year": d.setFullYear(d.getFullYear() - 1); break;
  }
  return { from: d.toISOString(), to };
}

/** Returns { from, to } as ISO strings (empty string = no bound). */
export function useDateRange() {
  const [preset, setPreset] = useState<DatePreset>("");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  const getRange = useCallback(() => {
    if (preset === "custom") {
      return {
        from: customFrom ? new Date(customFrom).toISOString() : "",
        to: customTo ? new Date(`${customTo}T23:59:59`).toISOString() : "",
      };
    }
    return presetToRange(preset);
  }, [preset, customFrom, customTo]);

  return { preset, setPreset, customFrom, setCustomFrom, customTo, setCustomTo, getRange };
}

export function DateRangeFilter({
  preset, setPreset, customFrom, setCustomFrom, customTo, setCustomTo,
}: {
  preset: DatePreset;
  setPreset: (p: DatePreset) => void;
  customFrom: string;
  setCustomFrom: (v: string) => void;
  customTo: string;
  setCustomTo: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const label = preset === "custom"
    ? (customFrom || customTo)
      ? `${customFrom || "…"} → ${customTo || "…"}`
      : "Custom range"
    : PRESET_LABELS[preset];

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-[170px] items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 transition hover:border-zinc-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-600"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 text-zinc-400">
          <rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
        </svg>
        <span className="flex-1 truncate text-left">{label}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="flex-shrink-0 text-zinc-400">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-64 rounded-xl border border-zinc-200 bg-white p-1 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
          {/* Preset options */}
          {(Object.entries(PRESET_LABELS) as [DatePreset, string][])
            .filter(([k]) => k !== "custom")
            .map(([key, lbl]) => (
              <button
                key={key}
                onClick={() => {
                  setPreset(key);
                  if (key !== "custom") { setCustomFrom(""); setCustomTo(""); }
                  if (key !== "custom") setOpen(false);
                }}
                className={`flex w-full items-center rounded-lg px-3 py-2 text-left text-sm transition ${
                  preset === key
                    ? "bg-emerald-50 font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                    : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                }`}
              >
                {preset === key && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="mr-2 flex-shrink-0">
                    <path d="M5 13l4 4L19 7" />
                  </svg>
                )}
                <span className={preset === key ? "" : "ml-[22px]"}>{lbl}</span>
              </button>
            ))}

          {/* Custom range section */}
          <div className="border-t border-zinc-200 pt-1 mt-1 dark:border-zinc-700">
            <button
              onClick={() => setPreset("custom")}
              className={`flex w-full items-center rounded-lg px-3 py-2 text-left text-sm transition ${
                preset === "custom"
                  ? "bg-emerald-50 font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                  : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
              }`}
            >
              {preset === "custom" && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="mr-2 flex-shrink-0">
                  <path d="M5 13l4 4L19 7" />
                </svg>
              )}
              <span className={preset === "custom" ? "" : "ml-[22px]"}>Custom range</span>
            </button>

            {preset === "custom" && (
              <div className="px-3 pb-3 pt-2 space-y-2">
                <div>
                  <label className="mb-1 block text-[10px] uppercase tracking-wider text-zinc-500">From</label>
                  <input
                    type="date"
                    value={customFrom}
                    onChange={(e) => setCustomFrom(e.target.value)}
                    className="w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm text-zinc-900 focus:border-emerald-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[10px] uppercase tracking-wider text-zinc-500">To</label>
                  <input
                    type="date"
                    value={customTo}
                    onChange={(e) => setCustomTo(e.target.value)}
                    className="w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm text-zinc-900 focus:border-emerald-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                  />
                </div>
                <button
                  onClick={() => setOpen(false)}
                  className="w-full rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-500"
                >
                  Apply
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
