"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { fetchUserProfile, type UserProfile } from "@/lib/api";
import { formatTime, formatSolve } from "@cubers/timer-core";
import { useAuth } from "@/features/auth/AuthProvider";
import { StatusBadge } from "@/features/competitions/StatusBadge";
import { GradientAvatar } from "@/components/GradientAvatar";
import { CountUp } from "@/components/CountUp";
import { Skeleton } from "@/components/Skeleton";
import { EventIcon } from "@/components/EventIcon";
import { eventDisplayName } from "@/lib/eventNames";

export default function ProfilePage() {
  const params = useParams<{ clid: string }>();
  const { user: me } = useAuth();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!params.clid) return;
    fetchUserProfile(params.clid)
      .then(setProfile)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [params.clid]);

  if (loading) {
    return (
      <main className="mx-auto max-w-6xl px-6 py-8">
        <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
          <section className="rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900/40">
            <Skeleton className="mb-4 h-16 w-16 rounded-full" />
            <Skeleton className="mb-2 h-6 w-32" />
            <Skeleton className="h-4 w-24" />
          </section>
          <section className="rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900/40">
            <Skeleton className="h-32 w-full" />
          </section>
        </div>
      </main>
    );
  }

  if (error || !profile) {
    return (
      <main className="flex min-h-[60vh] items-center justify-center text-red-500 dark:text-red-400">
        {error ?? "User not found"}
      </main>
    );
  }

  const isOwnProfile = me?.clId === profile.clId;
  const isPrivate = profile.profilePrivacy === "private" && !isOwnProfile;
  const pbEntries = Object.entries(profile.personalBests);
  const eventStatEntries = Object.entries(profile.stats?.eventStats ?? {});

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <div className="grid gap-6 lg:grid-cols-[300px_1fr] lg:items-start">
        {/* ══ Left column — identity card (sticky) ══ */}
        <div className="space-y-6 lg:sticky lg:top-20">
          <section className="rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900/40">
            <div className="flex flex-col items-center text-center">
              {profile.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={profile.avatarUrl}
                  alt={profile.name}
                  className="h-20 w-20 flex-shrink-0 rounded-full object-cover"
                />
              ) : (
                <GradientAvatar name={profile.name} size={80} className="text-3xl" />
              )}
              <div className="mt-3 flex items-center gap-2">
                <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">{profile.name}</h1>
              </div>
              {isPrivate && (
                <span className="mt-1 rounded-full bg-zinc-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                  &#x1F512; Private
                </span>
              )}
              <p className="mt-1 font-mono text-sm text-emerald-600 dark:text-emerald-400">{profile.clId}</p>

              <div className="mt-4 flex w-full flex-col items-center gap-2 border-t border-zinc-200 pt-4 text-sm text-zinc-500 dark:border-zinc-800">
                {!isPrivate && (profile.city || profile.state || profile.country) && (
                  <span>
                    {[profile.city, profile.state, profile.country]
                      .filter(Boolean)
                      .join(", ")}
                  </span>
                )}
                {!isPrivate && profile.wcaId && (
                  <span className={profile.wcaVerified ? "text-emerald-600 dark:text-emerald-400" : ""}>
                    WCA: {profile.wcaId}
                    {profile.wcaVerified ? " ✓" : ""}
                  </span>
                )}
                {!isPrivate && profile.instagram && (
                  <span className="text-zinc-400 dark:text-zinc-500">@{profile.instagram}</span>
                )}
                {!isPrivate && profile.createdAt && (
                  <span className="rounded-full bg-accent-primary/10 px-2 py-0.5 font-semibold text-accent-primary">
                    Cubler since {new Date(profile.createdAt).toLocaleDateString(undefined, { month: "short", year: "numeric" })}
                  </span>
                )}
              </div>

              {isOwnProfile && (
                <div className="mt-4 flex w-full flex-col gap-2">
                  <Link
                    href="/settings"
                    className="w-full rounded-lg border border-zinc-300 px-4 py-2 text-center text-sm font-semibold text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  >
                    Edit Profile
                  </Link>
                  <Link
                    href="/profile/me/appeals"
                    className="w-full rounded-lg border border-zinc-300 px-4 py-2 text-center text-sm font-semibold text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  >
                    My Appeals
                  </Link>
                </div>
              )}
            </div>
          </section>

          {!isPrivate && (
            <section className="rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900/40">
              <h2 className="mb-4 text-xs uppercase tracking-wider text-zinc-500">Statistics</h2>
              <div className="grid grid-cols-3 gap-3 lg:grid-cols-1 lg:gap-4">
                <div className="text-center lg:flex lg:items-baseline lg:justify-between lg:text-left">
                  <CountUp
                    value={profile.stats?.totalCompetitions ?? 0}
                    className="font-mono text-2xl font-bold text-zinc-900 dark:text-zinc-100"
                  />
                  <div className="text-xs text-zinc-500">Competitions</div>
                </div>
                <div className="text-center lg:flex lg:items-baseline lg:justify-between lg:text-left">
                  <CountUp
                    value={profile.stats?.totalSolves ?? 0}
                    className="font-mono text-2xl font-bold text-zinc-900 dark:text-zinc-100"
                  />
                  <div className="text-xs text-zinc-500">Total Solves</div>
                </div>
                <div className="text-center lg:flex lg:items-baseline lg:justify-between lg:text-left">
                  <CountUp value={pbEntries.length} className="font-mono text-2xl font-bold text-zinc-900 dark:text-zinc-100" />
                  <div className="text-xs text-zinc-500">Events</div>
                </div>
              </div>
            </section>
          )}
        </div>

        {/* ══ Right column — main content ══ */}
        <div className="space-y-6">
          {isPrivate && (
            <section className="rounded-2xl border border-zinc-200 bg-white p-6 text-center dark:border-zinc-800 dark:bg-zinc-900/40">
              <div className="text-3xl mb-2">&#x1F512;</div>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">This profile is private. Solve history and statistics are hidden.</p>
            </section>
          )}

          {!isPrivate && <>
          {/* Solve timeline */}
          <section className="rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900/40">
            <h2 className="mb-4 text-xs uppercase tracking-wider text-zinc-500">
              Solve Timeline
            </h2>
            <SolveTimelineGraph
              timeline={profile.stats?.solveTimeline ?? {}}
              eventStats={profile.stats?.eventStats ?? {}}
            />
            <div className="mt-4 rounded-lg border border-dashed border-zinc-300 p-3 text-center text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-600">
              Practice stats coming soon
            </div>
          </section>

          {/* Personal Bests */}
          <section className="rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900/40">
            <h2 className="mb-4 text-xs uppercase tracking-wider text-zinc-500">
              Personal Bests
            </h2>
            {pbEntries.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-200 text-left text-[11px] uppercase tracking-wider text-zinc-500 dark:border-zinc-800">
                      <th className="pb-2 pr-4">Event</th>
                      <th className="pb-2 px-4 text-right">Comp Single</th>
                      <th className="pb-2 px-4 text-right">Comp ao5</th>
                      <th className="pb-2 px-4 text-right text-zinc-400 dark:text-zinc-700">Practice Single</th>
                      <th className="pb-2 pl-4 text-right text-zinc-400 dark:text-zinc-700">Practice ao5</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pbEntries.map(([event, pb]) => (
                      <tr key={event} className="border-b border-zinc-100 dark:border-zinc-800/40">
                        <td className="py-3 pr-4 font-mono font-semibold text-zinc-800 dark:text-zinc-200">
                          <span className="inline-flex items-center gap-1.5">
                            <EventIcon eventId={event} size={16} />
                            {eventDisplayName(event)}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-zinc-700 dark:text-zinc-300">
                          {pb.bestSingle !== null ? formatTime(pb.bestSingle) : "—"}
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-zinc-700 dark:text-zinc-300">
                          {pb.bestAo5 !== null ? formatTime(pb.bestAo5) : "—"}
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-zinc-400 dark:text-zinc-700">
                          —
                        </td>
                        <td className="py-3 pl-4 text-right font-mono text-zinc-400 dark:text-zinc-700">
                          —
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-zinc-500 dark:text-zinc-600">No personal bests yet.</p>
            )}
          </section>

          {/* Competition History */}
          <section className="rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900/40">
            <h2 className="mb-4 text-xs uppercase tracking-wider text-zinc-500">
              Competition History
            </h2>
            {profile.competitionHistory.length === 0 ? (
              <p className="text-sm text-zinc-500 dark:text-zinc-600">No competitions yet.</p>
            ) : (
              <div className="space-y-3">
                {profile.competitionHistory.map((h) => (
                  <CompetitionHistoryCard key={h.competitionId} entry={h} />
                ))}
              </div>
            )}
          </section>
          </>}
        </div>
      </div>

      {/* ═══ Footer ═══ */}
      <footer className="mt-10 border-t border-zinc-200 py-6 text-center text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-600">
        <p>© {new Date().getFullYear()} Cubelelo Events. All rights reserved.</p>
      </footer>
    </main>
  );
}

/* ── Solve timeline line graph (LeetCode-style) ── */
function SolveTimelineGraph({
  timeline,
  eventStats,
}: {
  timeline: Record<string, Array<{ timeMs: number; ao5Ms: number | null; date: string; compTitle: string }>>;
  eventStats: Record<string, { mean: number | null; stdDev: number | null; solveCount: number }>;
}) {
  const eventTypes = Object.keys(timeline);
  const [selected, setSelected] = useState(eventTypes[0] ?? "");
  const [hovered, setHovered] = useState<number | null>(null);

  if (eventTypes.length === 0) {
    return (
      <p className="text-sm text-zinc-600">
        No competition data yet. Compete to see your stats!
      </p>
    );
  }

  const points = timeline[selected] ?? [];
  if (points.length === 0) return null;

  const stat = eventStats[selected];
  const times = points.map((p) => p.timeMs);
  const minT = Math.min(...times);
  const maxT = Math.max(...times);
  const range = maxT - minT || 1;

  const W = 600;
  const H = 200;
  const PAD_L = 52;
  const PAD_R = 16;
  const PAD_T = 20;
  const PAD_B = 24;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  const x = (i: number) => PAD_L + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (t: number) => PAD_T + plotH - ((t - minT) / range) * plotH;

  const pathD = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(p.timeMs).toFixed(1)}`)
    .join(" ");

  const gradientD = `${pathD} L ${x(points.length - 1).toFixed(1)} ${(PAD_T + plotH).toFixed(1)} L ${PAD_L.toFixed(1)} ${(PAD_T + plotH).toFixed(1)} Z`;

  // Y-axis ticks (5 ticks)
  const ticks = Array.from({ length: 5 }, (_, i) => minT + (range * i) / 4);

  // Mean line
  const meanY = stat?.mean != null ? y(stat.mean) : null;

  return (
    <div>
      {/* Event selector tabs */}
      <div className="mb-3 flex flex-wrap gap-1">
        {eventTypes.map((et) => (
          <button
            key={et}
            onClick={() => { setSelected(et); setHovered(null); }}
            className={`rounded-lg px-3 py-1.5 font-mono text-xs font-semibold transition ${
              selected === et
                ? "bg-emerald-600 text-white"
                : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 hover:text-zinc-900 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
            }`}
          >
            {eventDisplayName(et)}
          </button>
        ))}
      </div>

      {/* Graph */}
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full"
          style={{ maxHeight: 260 }}
          onMouseLeave={() => setHovered(null)}
        >
          {/* Grid lines */}
          {ticks.map((t, i) => (
            <g key={i}>
              <line
                x1={PAD_L}
                y1={y(t)}
                x2={W - PAD_R}
                y2={y(t)}
                strokeWidth={1}
                className="stroke-zinc-200 dark:stroke-zinc-800"
              />
              <text
                x={PAD_L - 6}
                y={y(t) + 3}
                textAnchor="end"
                fontSize={9}
                fontFamily="monospace"
                className="fill-zinc-400 dark:fill-zinc-600"
              >
                {formatTime(t)}
              </text>
            </g>
          ))}

          {/* Mean line */}
          {meanY != null && meanY >= PAD_T && meanY <= PAD_T + plotH && (
            <>
              <line
                x1={PAD_L}
                y1={meanY}
                x2={W - PAD_R}
                y2={meanY}
                stroke="#f59e0b"
                strokeWidth={1}
                strokeDasharray="4 3"
                opacity={0.6}
              />
              <text
                x={W - PAD_R + 2}
                y={meanY + 3}
                fontSize={8}
                fontFamily="monospace"
                className="fill-amber-500"
              >
                avg
              </text>
            </>
          )}

          {/* Gradient fill */}
          <defs>
            <linearGradient id="lineGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10b981" stopOpacity={0.3} />
              <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
            </linearGradient>
          </defs>
          <path d={gradientD} fill="url(#lineGrad)" />

          {/* Line */}
          <path
            d={pathD}
            fill="none"
            stroke="#10b981"
            strokeWidth={2}
            strokeLinejoin="round"
          />

          {/* Data points + hover areas */}
          {points.map((p, i) => (
            <g key={i}>
              <circle
                cx={x(i)}
                cy={y(p.timeMs)}
                r={hovered === i ? 5 : 3}
                className={hovered === i ? "fill-emerald-400" : "fill-emerald-600"}
                stroke="#09090b"
                strokeWidth={1.5}
              />
              {/* Invisible hover target */}
              <rect
                x={x(i) - (plotW / points.length) / 2}
                y={PAD_T}
                width={plotW / points.length}
                height={plotH}
                fill="transparent"
                onMouseEnter={() => setHovered(i)}
              />
            </g>
          ))}

          {/* X-axis: solve numbers */}
          {points.length <= 20
            ? points.map((_, i) => (
                <text
                  key={i}
                  x={x(i)}
                  y={H - 4}
                  textAnchor="middle"
                  fontSize={8}
                  fontFamily="monospace"
                  className="fill-zinc-400 dark:fill-zinc-600"
                >
                  {i + 1}
                </text>
              ))
            : [0, Math.floor(points.length / 2), points.length - 1].map((i) => (
                <text
                  key={i}
                  x={x(i)}
                  y={H - 4}
                  textAnchor="middle"
                  fontSize={8}
                  fontFamily="monospace"
                  className="fill-zinc-400 dark:fill-zinc-600"
                >
                  {i + 1}
                </text>
              ))}
        </svg>

        {/* Tooltip */}
        {hovered !== null && points[hovered] && (
          <div
            className="pointer-events-none absolute z-10 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
            style={{
              left: `${(x(hovered) / W) * 100}%`,
              top: `${(y(points[hovered].timeMs) / H) * 100 - 14}%`,
              transform: "translate(-50%, -100%)",
            }}
          >
            <div className="font-mono font-bold text-emerald-600 dark:text-emerald-400">
              {formatTime(points[hovered].timeMs)}
            </div>
            {points[hovered].ao5Ms != null && (
              <div className="text-zinc-500 dark:text-zinc-400">
                ao5: {formatTime(points[hovered].ao5Ms!)}
              </div>
            )}
            <div className="text-zinc-500">{points[hovered].compTitle}</div>
            <div className="text-zinc-400 dark:text-zinc-600">Solve #{hovered + 1}</div>
          </div>
        )}
      </div>

      {/* Summary stats below graph */}
      {stat && (
        <div className="mt-2 flex gap-6 text-xs text-zinc-500">
          {stat.mean != null && (
            <span>
              Mean: <span className="font-mono text-zinc-700 dark:text-zinc-300">{formatTime(stat.mean)}</span>
            </span>
          )}
          {stat.stdDev != null && (
            <span>
              σ: <span className="font-mono text-zinc-700 dark:text-zinc-300">{formatTime(stat.stdDev)}</span>
            </span>
          )}
          <span>
            Solves: <span className="font-mono text-zinc-700 dark:text-zinc-300">{stat.solveCount}</span>
          </span>
        </div>
      )}
    </div>
  );
}

/* ── Competition history card (expandable) ── */
function CompetitionHistoryCard({
  entry,
}: {
  entry: UserProfile["competitionHistory"][number];
}) {
  const [open, setOpen] = useState(false);
  const eventTypes = entry.events.map((e) => eventDisplayName(e.eventType)).join(", ");

  return (
    <div className="rounded-xl border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950/40">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-3 text-left transition hover:bg-zinc-100 dark:hover:bg-zinc-900/40"
      >
        <div className="flex items-center gap-3">
          <span className="font-semibold text-zinc-800 dark:text-zinc-200">{entry.competitionTitle}</span>
          <StatusBadge status={entry.status} />
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-zinc-500">{eventTypes}</span>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`text-zinc-500 transition-transform ${open ? "rotate-180" : ""}`}
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </div>
      </button>

      {open && (
        <div className="border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
          {entry.events.length === 0 ? (
            <p className="text-xs text-zinc-500 dark:text-zinc-600">No results for this competition.</p>
          ) : (
            <div className="space-y-4">
              {entry.events.map((ev) => (
                <div key={ev.eventType}>
                  <div className="mb-2 font-mono text-sm font-semibold text-zinc-700 dark:text-zinc-300">
                    {eventDisplayName(ev.eventType)}
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-zinc-200 text-left text-[10px] uppercase tracking-wider text-zinc-500 dark:border-zinc-800 dark:text-zinc-600">
                          <th className="pb-1.5 pr-3">Round</th>
                          <th className="pb-1.5 px-3 text-right">Rank</th>
                          <th className="pb-1.5 px-3 text-right">ao5</th>
                          <th className="pb-1.5 px-3 text-right">Best</th>
                          <th className="pb-1.5 pl-3">Solves</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ev.rounds.map((rd) => (
                          <tr key={rd.roundNumber} className="border-b border-zinc-100 dark:border-zinc-800/30">
                            <td className="py-1.5 pr-3 text-zinc-500 dark:text-zinc-400">
                              R{rd.roundNumber}
                            </td>
                            <td className="py-1.5 px-3 text-right font-mono text-zinc-700 dark:text-zinc-200">
                              {rd.rank !== null ? `#${rd.rank}` : "—"}
                            </td>
                            <td className="py-1.5 px-3 text-right font-mono text-zinc-700 dark:text-zinc-200">
                              {rd.ao5Ms !== null ? formatTime(rd.ao5Ms) : "DNF"}
                            </td>
                            <td className="py-1.5 px-3 text-right font-mono text-zinc-700 dark:text-zinc-200">
                              {rd.bestSingleMs !== null
                                ? formatTime(rd.bestSingleMs)
                                : "—"}
                            </td>
                            <td className="py-1.5 pl-3 font-mono text-zinc-500">
                              {rd.solves
                                .map((s) => formatSolve(s))
                                .join("  ")}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="mt-3 text-right">
            <Link
              href={`/competitions/${entry.competitionId}`}
              className="text-xs text-zinc-500 transition hover:text-zinc-700 dark:hover:text-zinc-300"
            >
              View competition →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
