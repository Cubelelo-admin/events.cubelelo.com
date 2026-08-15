"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchCompetitions, fetchMyRegistrations, type CompetitionSummary } from "@/lib/api";
import { CompetitionCard } from "@/features/competitions/CompetitionCard";
import { SkeletonCard } from "@/components/Skeleton";
import { useAuthStore } from "@/stores/authStore";
import Link from "next/link";

const FILTERS = [
  { label: "All", value: "" },
  { label: "Upcoming", value: "upcoming" },
  { label: "Live", value: "live" },
  { label: "Past", value: "past" },
] as const;

type Tab = "all" | "my";
type SortKey = "date" | "popularity" | "name";

export default function CompetitionsPage() {
  const user = useAuthStore((s) => s.user);
  const [comps, setComps] = useState<CompetitionSummary[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("all");
  const [myRegIds, setMyRegIds] = useState<Set<string> | null>(null);
  const [myLoading, setMyLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("date");

  useEffect(() => {
    setLoading(true);
    fetchCompetitions(filter || undefined)
      .then(setComps)
      .catch(() => setComps([]))
      .finally(() => setLoading(false));
  }, [filter]);

  useEffect(() => {
    if (tab === "my" && user && !myRegIds) {
      setMyLoading(true);
      fetchMyRegistrations()
        .then((regs) =>
          // Withdrawn and removed registrations are kept on record, so they must
          // be filtered out here or a competition you left still shows as yours.
          setMyRegIds(
            new Set(regs.filter((r) => r.status === "active").map((r) => r.competitionId)),
          ),
        )
        .catch(() => setMyRegIds(new Set()))
        .finally(() => setMyLoading(false));
    }
  }, [tab, user, myRegIds]);

  const filtered = useMemo(() => {
    let list = tab === "my" && myRegIds
      ? comps.filter((c) => myRegIds.has(c.id))
      : comps;

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((c) => c.title.toLowerCase().includes(q));
    }

    list = [...list].sort((a, b) => {
      if (sort === "date") {
        return new Date(b.startsAt ?? 0).getTime() - new Date(a.startsAt ?? 0).getTime();
      }
      if (sort === "popularity") {
        return (b.registrationCount ?? 0) - (a.registrationCount ?? 0);
      }
      return a.title.localeCompare(b.title);
    });

    return list;
  }, [comps, tab, myRegIds, search, sort]);

  const myUpcoming = tab === "my" ? filtered.filter((c) => ["upcoming", "registration_open", "registration_closed"].includes(c.status)).length : 0;
  const myLive = tab === "my" ? filtered.filter((c) => c.status === "live").length : 0;
  const myPast = tab === "my" ? filtered.filter((c) => ["results_pending", "completed"].includes(c.status)).length : 0;

  return (
    <div className="flex h-full flex-1">
      {/* Sidebar — always open on desktop */}
      <nav className="hidden w-56 shrink-0 border-r border-[var(--border-default)] bg-[var(--bg-glass)] backdrop-blur-xl lg:block">
        <div className="sticky top-0 flex h-full flex-col overflow-y-auto px-3 py-6">
          <div className="space-y-0.5">
            <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              View
            </p>
            {(["all", "my"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`block w-full rounded-lg px-3 py-2 text-left text-sm font-medium transition ${
                  tab === t
                    ? "bg-accent-primary/10 font-semibold text-accent-primary"
                    : "text-[var(--text-tertiary)] hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text-primary)]"
                }`}
              >
                {t === "all" ? "All Competitions" : "My Competitions"}
              </button>
            ))}
          </div>

          <div className="mt-6 space-y-0.5">
            <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              Status
            </p>
            {FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => setFilter(f.value)}
                className={`block w-full rounded-lg px-3 py-2 text-left text-sm font-medium transition ${
                  filter === f.value
                    ? "bg-accent-primary/10 font-semibold text-accent-primary"
                    : "text-[var(--text-tertiary)] hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text-primary)]"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="mt-6 space-y-0.5">
            <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              Sort by
            </p>
            {([
              { key: "date", label: "Date" },
              { key: "popularity", label: "Popularity" },
              { key: "name", label: "Name" },
            ] as const).map((s) => (
              <button
                key={s.key}
                onClick={() => setSort(s.key)}
                className={`block w-full rounded-lg px-3 py-2 text-left text-sm font-medium transition ${
                  sort === s.key
                    ? "bg-accent-primary/10 font-semibold text-accent-primary"
                    : "text-[var(--text-tertiary)] hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text-primary)]"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </nav>

      {/* Mobile filter bar */}
      <div className="fixed left-0 right-0 top-14 z-30 flex gap-1.5 overflow-x-auto border-b border-[var(--border-default)] bg-[var(--bg-glass)] px-4 py-2 backdrop-blur-xl lg:hidden">
        {(["all", "my"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition ${
              tab === t
                ? "bg-accent-primary/10 font-semibold text-accent-primary"
                : "text-[var(--text-tertiary)] hover:bg-[var(--bg-surface-hover)]"
            }`}
          >
            {t === "all" ? "All" : "My"}
          </button>
        ))}
        <div className="mx-1 w-px bg-[var(--border-default)]" />
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={`shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition ${
              filter === f.value
                ? "bg-accent-primary/10 font-semibold text-accent-primary"
                : "text-[var(--text-tertiary)] hover:bg-[var(--bg-surface-hover)]"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Main content area */}
      <div className="flex flex-1 flex-col overflow-y-auto pt-10 lg:pt-0">
        <main className="mx-auto w-full max-w-[1400px] flex-1 px-6 py-8">
          {/* Search bar */}
          <div className="mb-6 flex items-center gap-4">
            <div className="relative flex-1">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
              >
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <input
                type="text"
                placeholder="Search competitions..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-xl border border-[var(--border-default)] bg-[var(--bg-input)] py-2.5 pl-10 pr-4 text-sm text-[var(--text-primary)] placeholder-[var(--text-placeholder)] outline-none transition focus:border-[var(--border-hover)] focus:ring-1 focus:ring-accent-primary/30"
              />
            </div>
            {/* Mobile sort */}
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-input)] px-3 py-2.5 text-sm text-[var(--text-primary)] outline-none lg:hidden"
            >
              <option value="date">Date</option>
              <option value="popularity">Popular</option>
              <option value="name">Name</option>
            </select>
          </div>


          {/* My competitions stats */}
          {tab === "my" && !user && (
            <div className="glass-card rounded-xl border-dashed p-10 text-center">
              <div className="mb-2 text-3xl">🔒</div>
              <p className="mb-3 text-[var(--text-tertiary)]">Sign in to see your registered competitions</p>
              <Link
                href="/login"
                className="inline-block rounded-lg bg-gradient-to-r from-accent-primary to-[var(--accent-secondary)] px-5 py-2 text-sm font-semibold text-[#080b12] shadow-[0_4px_16px_var(--accent-glow)]"
              >
                Sign in
              </Link>
            </div>
          )}

          {tab === "my" && user && !myLoading && filtered.length > 0 && (
            <div className="mb-6 grid grid-cols-3 gap-4">
              <div className="glass-card rounded-xl p-4 text-center">
                <div className="font-mono text-2xl font-bold text-[var(--text-primary)]">{myUpcoming}</div>
                <div className="text-xs text-[var(--text-tertiary)]">Upcoming</div>
              </div>
              <div className="glass-card rounded-xl p-4 text-center">
                <div className="font-mono text-2xl font-bold text-[var(--text-primary)]">{myLive}</div>
                <div className="text-xs text-[var(--text-tertiary)]">Live</div>
              </div>
              <div className="glass-card rounded-xl p-4 text-center">
                <div className="font-mono text-2xl font-bold text-[var(--text-primary)]">{myPast}</div>
                <div className="text-xs text-[var(--text-tertiary)]">Completed</div>
              </div>
            </div>
          )}

          {/* Competition grid */}
          {(loading || (tab === "my" && myLoading)) && (tab !== "my" || user) ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <SkeletonCard key={i} />
              ))}
            </div>
          ) : (tab === "my" && !user) ? null : filtered.length === 0 ? (
            <div className="glass-card rounded-xl border-dashed p-10 text-center text-[var(--text-tertiary)]">
              <div className="mb-2 text-3xl">🧊</div>
              {search
                ? `No competitions matching "${search}"`
                : tab === "my"
                  ? "You haven't registered for any competitions yet."
                  : "No competitions found — check back soon!"}
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {filtered.map((c) => (
                <CompetitionCard key={c.id} comp={c} />
              ))}
            </div>
          )}
        </main>

        {/* Footer inside content area */}
        <footer className="border-t border-[var(--border-default)] bg-[var(--bg-glass)] py-8 text-center text-xs text-[var(--text-tertiary)] backdrop-blur-md">
          <p className="font-mono text-sm font-semibold text-accent-primary">🧊 Built for the cubing community</p>
          <div className="mt-4 flex flex-wrap justify-center gap-6">
            <Link href="/pages/about-us" className="transition hover:text-[var(--text-primary)]">About Us</Link>
            <Link href="/pages/rules" className="transition hover:text-[var(--text-primary)]">Rules</Link>
            <Link href="/pages/faqs" className="transition hover:text-[var(--text-primary)]">FAQs</Link>
            <Link href="/pages/privacy-policy" className="transition hover:text-[var(--text-primary)]">Privacy Policy</Link>
            <Link href="/pages/contact-us" className="transition hover:text-[var(--text-primary)]">Contact Us</Link>
          </div>
          <p className="mt-4">© {new Date().getFullYear()} Cubelelo Events. All rights reserved.</p>
        </footer>
      </div>
    </div>
  );
}

