"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { eventDisplayName } from "@/lib/eventNames";
import { EventIcon } from "@/components/EventIcon";
import {
  assetUrl,
  fetchCompetition,
  fetchMyRegistrations,
  fetchMyProgress,
  fetchParticipants,
  fetchLiveRanking,
  fetchPublicPage,
  submitAppeal,
  type CompetitionDetail,
  type RegistrationDto,
  type ParticipantEntry,
  type LiveRankingEntry,
  type RoundProgress,
} from "@/lib/api";
import { useAuth } from "@/features/auth/AuthProvider";
import { acquireSocket, releaseSocket, trackCompJoin, trackCompLeave } from "@/features/realtime/socket";
import { UserStatusBadge } from "@/features/competitions/UserStatusBadge";
import { StatusBadge } from "@/features/competitions/StatusBadge";
import { formatTime } from "@cubers/timer-core";
import { Button } from "@/components/ui/Button";
import { ErrorCard } from "@/components/ui/ErrorCard";
import { useCompetitionRoundStatus } from "@/features/realtime/useCompetitionRoundStatus";
import { WithdrawControl } from "@/features/competitions/detail/WithdrawControl";
import { Modal } from "@/components/ui/Modal";
import { Skeleton } from "@/components/Skeleton";
import { Countdown } from "@/components/Countdown";
import { Markdown } from "@/components/Markdown";
import { VideoUploadSection } from "@/features/competitions/detail/VideoUploadSection";

/* ── Dynamic nav items based on competition state ── */

function getNavItems(
  comp: CompetitionDetail,
  isRegistered: boolean,
  user: { clId: string; name: string } | null,
): { id: string; label: string }[] {
  const items: { id: string; label: string }[] = [
    { id: "overview", label: "Overview" },
  ];

  const isUpcoming = ["published", "registration_open", "registration_closed", "upcoming"].includes(comp.status);
  const isCancelled = comp.status === "cancelled";
  const isCompleted = comp.status === "completed" || comp.status === "results_pending";
  const hasPrizes = !!(comp as any).prizes;

  // Prizes: show if data exists, or if upcoming/registration_open (placeholder)
  if (hasPrizes || (isUpcoming && !isCancelled)) {
    items.push({ id: "prizes", label: "Prizes & Rewards" });
  }

  items.push({ id: "schedule", label: "Schedule" });
  items.push({ id: "events", label: "Events" });

  // Users & Rankings: hide for cancelled
  if (!isCancelled) {
    items.push({ id: "users-rankings", label: "Users & Rankings" });
  }

  items.push({ id: "video-rules", label: "Video Rules" });
  items.push({ id: "rules", label: "Rules" });

  // Organizers: only if staff data exists
  if ((comp as any).staff) {
    items.push({ id: "organizers", label: "Organizers" });
  }

  // Policies: only for paid comps
  if (comp.type !== "free") {
    items.push({ id: "policies", label: "Policies" });
  }

  items.push({ id: "faqs", label: "FAQs" });
  items.push({ id: "contact", label: "Contact Us" });

  return items;
}

export default function CompetitionDetailPage() {
  const params = useParams<{ id: string }>();
  const { user, loading: authLoading } = useAuth();

  const [comp, setComp] = useState<CompetitionDetail | null>(null);
  const [myReg, setMyReg] = useState<RegistrationDto | null>(null);
  const [myProgress, setMyProgress] = useState<RoundProgress[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState("overview");

  // Reload the competition. `silent` skips the full-page spinner + error banner
  // so a realtime refresh (a round opening, say) updates in place quietly.
  const loadComp = useCallback(async (silent = false) => {
    if (!params.id) return;
    if (!silent) { setLoading(true); setError(null); }
    try {
      const data = await fetchCompetition(params.id);
      setComp(data);
    } catch (e) {
      if (!silent) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [params.id]);

  const loadMine = useCallback(async () => {
    if (!user || !params.id) return;
    try {
      const regs = await fetchMyRegistrations();
      // Only an active registration means "you are in this competition".
      setMyReg(regs.find((r) => r.competitionId === params.id && r.status === "active") ?? null);
    } catch { /* ignore */ }
    try {
      const p = await fetchMyProgress(params.id);
      setMyProgress(p.rounds);
    } catch { /* ignore */ }
  }, [user, params.id]);

  // Wait for auth to finish loading before fetching — the token must be set so
  // the API knows whether this user is an admin (required to view drafts).
  useEffect(() => {
    if (authLoading) return;
    loadComp(false);
  }, [authLoading, loadComp]);

  useEffect(() => { loadMine(); }, [loadMine]);

  // React to live state instead of forcing a refresh: when a round opens/closes
  // or the competition status changes, the server broadcasts to the competition
  // room. Refetch quietly so the enter-round buttons, statuses and standings
  // update on their own. Bursts (a transition emits several events) are coalesced.
  useEffect(() => {
    if (!params.id) return;
    const socket = acquireSocket();
    socket.emit("join", { compId: params.id });
    trackCompJoin(params.id);

    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { loadComp(true); loadMine(); }, 400);
    };
    socket.on("round:status", refresh);
    socket.on("comp:status", refresh);

    return () => {
      if (timer) clearTimeout(timer);
      socket.off("round:status", refresh);
      socket.off("comp:status", refresh);
      trackCompLeave(params.id);
      releaseSocket();
    };
  }, [params.id, loadComp, loadMine]);

  const navItems = useMemo(
    () => (comp ? getNavItems(comp, !!myReg, user) : []),
    [comp, myReg, user],
  );

  // IntersectionObserver to highlight active nav link on scroll
  useEffect(() => {
    const ids = navItems.map((n) => n.id);
    const elements = ids.map((id) => document.getElementById(`section-${id}`)).filter(Boolean) as HTMLElement[];
    if (elements.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const id = entry.target.id.replace("section-", "");
            setActiveSection(id);
          }
        }
      },
      { rootMargin: "-20% 0px -60% 0px", threshold: 0 },
    );

    for (const el of elements) observer.observe(el);
    return () => observer.disconnect();
  }, [navItems]);

  const scrollTo = useCallback((id: string) => {
    const el = document.getElementById(`section-${id}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);



  if (loading) {
    return (
      <main className="mx-auto max-w-6xl px-6 py-10">
        <Skeleton className="mb-4 h-5 w-24" />
        <Skeleton className="mb-2 h-9 w-2/3" />
        <Skeleton className="mb-6 h-4 w-1/2" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
        </div>
      </main>
    );
  }

  if (error || !comp) {
    return (
      <main className="flex min-h-[60vh] items-center justify-center">
        <ErrorCard error={error ?? "competition_not_found"} onRetry={() => window.location.reload()} />
      </main>
    );
  }

  const isRegOpen = comp.status === "registration_open";
  const isLive = comp.status === "live";
  const isCancelled = comp.status === "cancelled";
  const isCompleted = comp.status === "completed" || comp.status === "results_pending";
  const isUpcoming = ["published", "registration_open", "registration_closed", "upcoming"].includes(comp.status);

  const countdownTarget =
    comp.status === "registration_open" ? comp.registrationDeadline
      : comp.status === "upcoming" || comp.status === "published" || comp.status === "registration_closed" ? comp.startsAt
        : null;
  const countdownLabel = comp.status === "registration_open" ? "Registration closes in" : "Starts in";

  const feeText =
    comp.type === "free"
      ? "Free entry"
      : `₹${((comp.baseFee ?? 0) / 100).toFixed(2)} base + ₹${((comp.perEventFee ?? 0) / 100).toFixed(2)}/event`;

  const hasLiveEvent = comp.events.some((ev) => ev.rounds?.some((r) => r.status === "open"));
  const showUsersRankings = !isCancelled;
  const hasPrizes = !!(comp as any).prizes;
  const showPrizes = hasPrizes || (isUpcoming && !isCancelled);
  const hasStaff = !!(comp as any).staff;
  const showPolicies = comp.type !== "free";

  return (
    <>
      {/* Sidebar nav */}
      <nav className="flex gap-1.5 overflow-x-auto px-6 pb-2 pt-4 lg:fixed lg:left-0 lg:top-14 lg:z-30 lg:h-[calc(100vh-56px)] lg:w-56 lg:flex-col lg:gap-0.5 lg:overflow-y-auto lg:overflow-x-visible lg:border-r lg:border-[var(--border-default)] lg:bg-[var(--bg-glass)] lg:px-3 lg:py-6 lg:backdrop-blur-xl">
        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={() => scrollTo(item.id)}
            className={`block shrink-0 whitespace-nowrap rounded-lg px-3 py-2 text-left text-sm font-medium transition lg:w-full lg:shrink ${activeSection === item.id
                ? "bg-accent-primary/10 font-semibold text-accent-primary"
                : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900"
              }`}
          >
            <span className="flex items-center gap-1.5">
              {item.label}
              {item.id === "events" && hasLiveEvent && (
                <span className="live-dot h-2 w-2 rounded-full bg-emerald-500" />
              )}
            </span>
          </button>
        ))}
      </nav>

      <div className="lg:pl-56">
        <main className="mx-auto max-w-6xl px-6 py-10">
          {/* ══ Section: Overview ══ */}
          <section id="section-overview" className="scroll-mt-20">
            {/* Banner hero. The banner is the only hero image — a separate
                cover image existed but was never settable from either admin
                screen, so it has been removed. */}
            {(comp.bannerUrl || comp.mobileBannerUrl) && (
              <div className="mb-6 w-full overflow-hidden rounded-2xl">
                {comp.bannerUrl && (
                  <img
                    src={assetUrl(comp.bannerUrl)}
                    alt={comp.title}
                    className={`aspect-[3/1] w-full rounded-2xl object-cover object-top ${comp.mobileBannerUrl ? "hidden sm:block" : ""}`}
                  />
                )}
                {comp.mobileBannerUrl && (
                  <img
                    src={assetUrl(comp.mobileBannerUrl)}
                    alt={comp.title}
                    className={`aspect-[3/2] w-full rounded-2xl object-cover object-top ${comp.bannerUrl ? "sm:hidden" : ""}`}
                  />
                )}
              </div>
            )}

            <div className="mb-4 flex items-center gap-3">
              <UserStatusBadge comp={comp} isRegistered={!!myReg} />
              {isLive && (
                <span className="flex items-center gap-1.5 rounded-full bg-red-600 px-2.5 py-0.5 text-xs font-bold text-white">
                  <span className="live-dot h-2 w-2 rounded-full bg-white" />
                  LIVE
                </span>
              )}
              <span className="text-xs text-zinc-500">{comp.type}</span>
            </div>
            <h1 className="mb-2 text-3xl font-bold text-zinc-900 dark:text-zinc-100">{comp.title}</h1>
            {comp.description && <p className="mb-6 text-zinc-500 dark:text-zinc-400">{comp.description}</p>}

            {/* Cancellation notice */}
            {isCancelled && comp.cancellationReason && (
              <div className="mb-6 rounded-lg border border-red-300 bg-red-50 p-4 dark:border-red-800 dark:bg-red-900/20">
                <div className="mb-1 text-sm font-semibold text-red-700 dark:text-red-300">
                  This competition has been cancelled
                </div>
                <p className="text-sm text-red-600 dark:text-red-400">{comp.cancellationReason}</p>
              </div>
            )}

            {/* Competition ended notice */}
            {isCompleted && (
              <div className="mb-6 rounded-lg border border-zinc-300 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-900/30">
                <p className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
                  This competition has ended. Results are {comp.status === "results_pending" ? "being processed" : "available below"}.
                </p>
              </div>
            )}

            {/* Stats row */}
            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-xl border border-zinc-200 bg-white p-4 text-center dark:border-zinc-800 dark:bg-zinc-900/40">
                <div className="text-sm font-bold text-zinc-900 dark:text-zinc-100">{feeText}</div>
                <div className="text-xs text-zinc-500">Entry</div>
              </div>
              <div className="rounded-xl border border-zinc-200 bg-white p-4 text-center dark:border-zinc-800 dark:bg-zinc-900/40">
                <div className="font-mono text-lg font-bold text-zinc-900 dark:text-zinc-100">{comp.events.length}</div>
                <div className="text-xs text-zinc-500">Events</div>
              </div>
              <div className="rounded-xl border border-zinc-200 bg-white p-4 text-center dark:border-zinc-800 dark:bg-zinc-900/40">
                <div className="font-mono text-lg font-bold text-zinc-900 dark:text-zinc-100">
                  {comp.registrationLimit != null && comp.registrationLimit > 0
                    ? `${comp.registrationCount ?? 0}/${comp.registrationLimit}`
                    : (comp.registrationCount ?? 0)}
                </div>
                <div className="text-xs text-zinc-500">Registered</div>
              </div>
              <div className="rounded-xl border border-zinc-200 bg-white p-4 text-center dark:border-zinc-800 dark:bg-zinc-900/40">
                <div className="font-mono text-lg font-bold text-zinc-900 dark:text-zinc-100">
                  {isCompleted ? "Ended" : isLive ? "Live" : comp.status === "registration_closed" ? "Closed" : "--"}
                </div>
                <div className="text-xs text-zinc-500">Status</div>
              </div>
            </div>

            {/* CTA bar + Calendar + Share */}
            {!isCancelled && !isCompleted && (
              <div className="mb-8 flex flex-wrap items-center gap-4 rounded-xl border border-zinc-200 bg-white px-5 py-4 dark:border-zinc-800 dark:bg-zinc-900/40">
                {myReg ? (
                  <>
                    <RegistrationSteps paymentStatus={myReg.paymentStatus} />
                    <WithdrawControl
                      registrationId={myReg.id}
                      competitionId={comp.id}
                      isPaid={(comp.baseFee ?? 0) > 0 || (comp.perEventFee ?? 0) > 0}
                      canWithdraw={isRegOpen}
                      onWithdrawn={() => setMyReg(null)}
                    />
                  </>
                ) : isRegOpen ? (
                  user ? (
                    <>
                      <RegistrationSteps paymentStatus={null} />
                      <Link href={`/competitions/${comp.id}/register`}>
                        <Button size="sm">Register Now</Button>
                      </Link>
                    </>
                  ) : (
                    <Link href="/login" className="text-sm text-accent-primary underline hover:brightness-110">
                      Sign in to register
                    </Link>
                  )
                ) : (
                  <p className="text-sm text-zinc-500">
                    {comp.status === "registration_closed" ? "Registration is closed." : "Registration is not currently open."}
                  </p>
                )}

                {countdownTarget && (
                  <div className="ml-auto flex items-center gap-2 rounded-full bg-accent-warn/10 px-3 py-1.5 text-sm text-accent-warn">
                    <span>&#9203;</span> {countdownLabel} <Countdown target={countdownTarget} className="font-mono font-semibold" />
                  </div>
                )}
              </div>
            )}

            {/* Action bar: Add to Calendar + Share */}
            <ActionBar comp={comp} />
          </section>

          {/* ══ All sections stacked ══ */}
          <div className="mt-12 space-y-12">
            {/* 2. Prizes & Rewards */}
            {showPrizes && (
              <section id="section-prizes" className="scroll-mt-20">
                <SectionHeading>Prizes &amp; Rewards</SectionHeading>
                <PrizesSection comp={comp} />
              </section>
            )}

            {/* 3. Schedule */}
            <section id="section-schedule" className="scroll-mt-20">
              <SectionHeading>Schedule</SectionHeading>
              <div className="space-y-6">
                <ScheduleTimeline comp={comp} />
                <WhatsNextCard comp={comp} />
                <DetailedSchedule comp={comp} />
              </div>
            </section>

            {/* 4. Events */}
            <section id="section-events" className="scroll-mt-20">
              <SectionHeading>Events</SectionHeading>
              <EventCardsSection comp={comp} myProgress={myProgress} isRegistered={!!myReg} />
            </section>

            {/* 5. Users & Rankings */}
            {showUsersRankings && (
              <section id="section-users-rankings" className="scroll-mt-20">
                <SectionHeading>Users &amp; Rankings</SectionHeading>
                <UsersAndRankingsSection comp={comp} user={user} isCompleted={isCompleted} myProgress={myProgress} registeredEventTypes={myReg?.events.map((e) => e.eventType) ?? []} />
              </section>
            )}

            {/* 6. Video Rules */}
            <section id="section-video-rules" className="scroll-mt-20">
              <SectionHeading>Video Rules</SectionHeading>
              <VideoRulesSection comp={comp} />
            </section>

            {/* 7. Rules */}
            <section id="section-rules" className="scroll-mt-20">
              <SectionHeading>Rules</SectionHeading>
              <RulesTab comp={comp} />
            </section>

            {/* 10. Organizers */}
            {hasStaff && (
              <section id="section-organizers" className="scroll-mt-20">
                <SectionHeading>Organizers</SectionHeading>
                <OrganizersSection comp={comp} />
              </section>
            )}

            {/* 11. Policies */}
            {showPolicies && (
              <section id="section-policies" className="scroll-mt-20">
                <SectionHeading>Policies</SectionHeading>
                <PoliciesSection comp={comp} />
              </section>
            )}

            {/* 12. FAQs */}
            <section id="section-faqs" className="scroll-mt-20">
              <SectionHeading>FAQs</SectionHeading>
              <ContentPageTab slug="faqs" />
            </section>

            {/* 13. Contact */}
            <section id="section-contact" className="scroll-mt-20">
              <SectionHeading>Contact Us</SectionHeading>
              <ContentPageTab slug="contact-us" />
            </section>
          </div>
        </main>
      </div>
    </>
  );
}

/* ── Section heading ── */

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-5 border-b border-zinc-200 pb-2 text-lg font-bold text-zinc-900 dark:border-zinc-800 dark:text-zinc-100">
      {children}
    </h2>
  );
}

/* ── Action bar: Add to Calendar + Share ── */

function ActionBar({ comp }: { comp: CompetitionDetail }) {
  const [shareOpen, setShareOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!shareOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShareOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [shareOpen]);

  const handleAddToCalendar = useCallback(() => {
    const start = comp.startsAt ? formatIcsDate(comp.startsAt) : "";
    const end = comp.endsAt ? formatIcsDate(comp.endsAt) : start;
    const title = comp.title;
    const description = comp.description ?? "";
    const url = typeof window !== "undefined" ? window.location.href : "";

    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Cubelelo Events//EN",
      "BEGIN:VEVENT",
      `DTSTART:${start}`,
      `DTEND:${end}`,
      `SUMMARY:${title}`,
      `DESCRIPTION:${description}\\n${url}`,
      `URL:${url}`,
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${comp.title.replace(/[^a-zA-Z0-9]/g, "_")}.ics`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  }, [comp]);

  const handleCopyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { }
  }, []);

  const handleWhatsAppShare = useCallback(() => {
    const url = window.location.href;
    const text = `Check out this competition: ${comp.title} - ${url}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank");
    setShareOpen(false);
  }, [comp.title]);

  const handleNativeShare = useCallback(async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: comp.title, url: window.location.href });
      } catch { }
    }
    setShareOpen(false);
  }, [comp.title]);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        onClick={handleAddToCalendar}
        className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900/40 dark:text-zinc-300 dark:hover:bg-zinc-800"
      >
        <span>&#128197;</span>
        Add to Calendar
      </button>

      <div className="relative" ref={dropdownRef}>
        <button
          onClick={() => setShareOpen((p) => !p)}
          className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900/40 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          <span>&#8599;</span>
          Share
        </button>

        {shareOpen && (
          <div className="absolute left-0 top-full z-50 mt-2 w-48 rounded-xl border border-zinc-200 bg-white p-1.5 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
            <button
              onClick={handleCopyLink}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              {copied ? "Copied!" : "Copy Link"}
            </button>
            <button
              onClick={handleWhatsAppShare}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              WhatsApp
            </button>
            {typeof navigator !== "undefined" && "share" in navigator && (
              <button
                onClick={handleNativeShare}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                More...
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function formatIcsDate(isoDate: string): string {
  const d = new Date(isoDate);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/* ── Prizes Section ── */

function PrizesSection({ comp }: { comp: CompetitionDetail }) {
  const prizes = (comp as any).prizes;

  if (prizes && Array.isArray(prizes) && prizes.length > 0) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {prizes.map((prize: { place: string; reward: string; eventType?: string }, i: number) => (
          <div
            key={i}
            className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900/40"
          >
            {prize.eventType && (
              <div className="mb-2">
                <EventIcon eventId={prize.eventType} size={20} className="text-zinc-500" />
              </div>
            )}
            <p className="text-sm font-bold text-zinc-900 dark:text-zinc-100">{prize.place}</p>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{prize.reward}</p>
          </div>
        ))}
      </div>
    );
  }

  // Placeholder for upcoming competitions
  return (
    <div className="rounded-xl border border-dashed border-zinc-300 bg-zinc-50 p-8 text-center dark:border-zinc-700 dark:bg-zinc-900/20">
      <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
        Prizes to be announced
      </p>
      <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-600">
        Prize details will be shared closer to the competition date.
      </p>
    </div>
  );
}

/* ── Video Rules Section ── */

const DEFAULT_VIDEO_RULES = `### Video Submission Rules

1. **Camera angle**: The camera must show a clear, unobstructed view of the puzzle and your hands throughout the entire solve.
2. **Timer visibility**: The timer display must be clearly visible in the recording.
3. **Inspection**: The standard 15-second inspection period applies. The puzzle must remain covered or out of view until inspection begins.
4. **Lighting**: Ensure adequate lighting so that all cube faces and movements are clearly visible.
5. **Audio**: Keep audio enabled. External noise is fine, but the video must contain the original audio track.
6. **Single continuous take**: The video must be a single, unedited continuous recording. Jump cuts or edits of any kind will result in disqualification.
7. **Scramble verification**: Show the scrambled state of the puzzle clearly before starting your timer.
8. **Submission deadline**: Submit your video within the specified deadline after your round closes. Late submissions will not be accepted.
9. **Format**: Upload as MP4, MOV, or WebM. Maximum file size is 500 MB.`;

function VideoRulesSection({ comp }: { comp: CompetitionDetail }) {
  const videoRulesMd = (comp as any).videoRulesMd;
  const content = videoRulesMd || DEFAULT_VIDEO_RULES;

  return (
    <div className="space-y-4">
      <div className="prose prose-sm prose-zinc dark:prose-invert max-w-none rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900/40">
        <Markdown>{content}</Markdown>
      </div>

      {/* Event-specific icons row */}
      {comp.events.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-200 bg-white px-5 py-3 dark:border-zinc-800 dark:bg-zinc-900/40">
          <span className="text-xs font-medium text-zinc-500">Applies to:</span>
          {comp.events.map((ev) => (
            <span key={ev.id} className="flex items-center gap-1 text-xs text-zinc-600 dark:text-zinc-400">
              <EventIcon eventId={ev.eventType} size={16} />
              {eventDisplayName(ev.eventType)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Organizers Section ── */

function OrganizersSection({ comp }: { comp: CompetitionDetail }) {
  const staff = (comp as any).staff;
  if (!staff || !Array.isArray(staff) || staff.length === 0) return null;

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {staff.map((member: { name: string; role?: string; avatarUrl?: string }, i: number) => (
        <div
          key={i}
          className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900/40"
        >
          {member.avatarUrl ? (
            <img src={assetUrl(member.avatarUrl)} alt={member.name} className="h-10 w-10 rounded-full object-cover" />
          ) : (
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-zinc-100 text-sm font-bold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
              {member.name.charAt(0).toUpperCase()}
            </div>
          )}
          <div>
            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{member.name}</p>
            {member.role && <p className="text-xs text-zinc-500">{member.role}</p>}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Policies Section ── */

const DEFAULT_REFUND_POLICY = `### Refund Policy

- **Before registration closes**: Full refund available upon request. Contact the organizers.
- **After registration closes, before competition starts**: 50% refund available. Processing may take 5-7 business days.
- **After competition starts**: No refunds will be issued.
- **Technical issues**: If you experience technical issues that prevent participation, contact support within 24 hours for review.

All refund requests must be submitted via the contact form or email. Include your registration ID and reason for the request.`;

function PoliciesSection({ comp }: { comp: CompetitionDetail }) {
  const refundPolicyMd = (comp as any).refundPolicyMd;
  const content = refundPolicyMd || DEFAULT_REFUND_POLICY;

  return (
    <div className="prose prose-sm prose-zinc dark:prose-invert max-w-none rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900/40">
      <Markdown>{content}</Markdown>
    </div>
  );
}

/* ── What's Next card (moved from Lobby to Schedule) ── */

function WhatsNextCard({ comp }: { comp: CompetitionDetail }) {
  const now = Date.now();
  const milestones: { label: string; at: string | null | undefined }[] = [
    { label: "Registration opens", at: comp.registrationOpensAt },
    { label: "Registration closes", at: comp.registrationDeadline },
    { label: "Competition starts", at: comp.startsAt },
    { label: "Competition ends", at: comp.endsAt },
  ];
  const next = milestones.find((s) => s.at && new Date(s.at).getTime() > now);
  if (!next) return null;

  const isLive = comp.status === "live";

  return (
    <div className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-white px-5 py-4 dark:border-zinc-800 dark:bg-zinc-900/40">
      <span className="text-lg">{isLive ? "🔴" : "⏳"}</span>
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
          {isLive ? "Competition Live" : "What's Next"}
        </p>
        <p className="text-sm text-zinc-700 dark:text-zinc-300">
          <span className="font-semibold">{next.label}</span>{" "}
          {new Date(next.at!).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
        </p>
      </div>
    </div>
  );
}

/* ── Event cards (non-expandable, rounds inline) ── */

function EventCardsSection({
  comp,
  myProgress,
  isRegistered,
}: {
  comp: CompetitionDetail;
  myProgress: RoundProgress[];
  isRegistered: boolean;
}) {
  // The page fetches once, so without this a round that opens while someone is
  // reading never shows as live — the reported "Events tab doesn't show what's
  // active". One competition room covers every round.
  const liveStatuses = useCompetitionRoundStatus(comp.id);
  const statusOf = (round: { id: string; status: string }) =>
    liveStatuses.get(round.id) ?? round.status;

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {comp.events.map((ev) => {
        const latestRound = [...ev.rounds]
          .reverse()
          .find((r) => statusOf(r) !== "pending") ?? ev.rounds[0];

        return (
          <div
            key={ev.id}
            className="rounded-xl border border-zinc-200 bg-white p-5 transition hover:border-zinc-300 hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900/40 dark:hover:border-zinc-700"
          >
            <div className="mb-3 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent-primary/10">
                <EventIcon eventId={ev.eventType} size={22} className="text-accent-primary" />
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                    {eventDisplayName(ev.eventType)}
                  </span>
                  {latestRound && <StatusBadge status={statusOf(latestRound)} />}
                </div>
                <div className="flex items-center gap-2 text-xs text-zinc-500">
                  <span>{ev.roundCount} round{ev.roundCount > 1 ? "s" : ""}</span>
                  {ev.cutoffMs && <span>· Cutoff {(ev.cutoffMs / 1000).toFixed(0)}s</span>}
                  {ev.timeLimitMs && <span>· Limit {(ev.timeLimitMs / 1000).toFixed(0)}s</span>}
                </div>
              </div>
            </div>

            {/* Rounds chips */}
            <div className="mb-3 flex flex-wrap gap-1.5">
              {ev.rounds.map((r) => {
                const status = statusOf(r);
                const isOpen = status === "open";
                const isClosed = status === "closed" || status === "advanced";
                const userRound = myProgress.find((p) => p.roundId === r.id);
                const submitted = userRound?.userStatus === "submitted";
                return (
                  <span
                    key={r.id}
                    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
                      isOpen
                        ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                        : isClosed
                          ? "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-500"
                          : "bg-zinc-50 text-zinc-400 dark:bg-zinc-800/50 dark:text-zinc-600"
                    }`}
                  >
                    {isOpen && <span className="live-dot h-1.5 w-1.5 rounded-full bg-emerald-500" />}
                    R{r.roundNumber} — {status === "open" ? "Open" : status === "pending" ? "Pending" : status === "advanced" ? "Advanced" : "Closed"}
                    {submitted && " ✓"}
                  </span>
                );
              })}
            </div>

            {/* Round schedule details */}
            <div className="space-y-1 text-xs text-zinc-500">
              {ev.rounds.map((r) => (
                <div key={r.id} className="flex justify-between">
                  <span>R{r.roundNumber} {r.opensAt ? "opens" : ""}</span>
                  <span className="font-medium text-zinc-600 dark:text-zinc-400">
                    {r.opensAt
                      ? new Date(r.opensAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })
                      : "TBD"}
                  </span>
                </div>
              ))}
            </div>

            {/* Enter round CTA */}
            {ev.rounds.some((r) => r.status === "open") && isRegistered && (
              <div className="mt-3">
                {(() => {
                  const openRound = ev.rounds.find((r) => r.status === "open")!;
                  const userRound = myProgress.find((p) => p.roundId === openRound.id);
                  if (userRound?.userStatus === "submitted") {
                    return (
                      <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                        Submitted
                      </span>
                    );
                  }
                  if (userRound?.userStatus === "locked" || userRound?.userStatus === "eliminated") {
                    return (
                      <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-semibold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                        Not qualified for this round
                      </span>
                    );
                  }
                  return (
                    <Link href={`/competitions/${comp.id}/round/${openRound.roundNumber}?eventId=${ev.eventType}`}>
                      <Button size="sm">Enter Round {openRound.roundNumber}</Button>
                    </Link>
                  );
                })()}
              </div>
            )}

            {/* Video upload for closed/advanced rounds */}
            {isRegistered && ev.rounds.map((r) => {
              if (r.status !== "closed" && r.status !== "advanced") return null;
              const userRound = myProgress.find((p) => p.roundId === r.id);
              if (!userRound?.result?.id || !r.closesAt) return null;
              const deadlineIso = new Date(new Date(r.closesAt).getTime() + (comp.videoDeadlineMinutes ?? 1440) * 60_000).toISOString();
              return (
                <VideoUploadSection
                  key={`video-${r.id}`}
                  resultId={userRound.result.id}
                  currentVideoUrl={userRound.result.videoUrl}
                  deadline={deadlineIso}
                  onUpdate={() => {}}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/* ── Rules tab ── */

function RulesTab({ comp }: { comp: CompetitionDetail }) {
  // A competition's rules are the rule sets it uses, in the order the organiser
  // chose, followed by any additional text specific to this competition.
  const ruleSets = comp.ruleSets ?? [];

  if (ruleSets.length === 0 && !comp.rulesMd) {
    return (
      <div className="rounded-xl border border-dashed border-zinc-300 p-10 text-center text-zinc-500 dark:border-zinc-700">
        No rules have been posted for this competition yet.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {ruleSets.map((rs) => (
        <div
          key={rs.id}
          className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900/40"
        >
          <h3 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">{rs.name}</h3>
          <div className="prose prose-sm prose-zinc dark:prose-invert max-w-none">
            <Markdown>{rs.content}</Markdown>
          </div>
        </div>
      ))}

      {comp.rulesMd && (
        <div className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900/40">
          {ruleSets.length > 0 && (
            <h3 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              Additional rules for this competition
            </h3>
          )}
          <div className="prose prose-sm prose-zinc dark:prose-invert max-w-none">
            <Markdown>{comp.rulesMd}</Markdown>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── FAQs / Contact Us tabs — shared site content, embedded in-page ── */

function ContentPageTab({ slug }: { slug: string }) {
  const [page, setPage] = useState<{ title: string; bodyMd: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    setLoading(true);
    setNotFound(false);
    fetchPublicPage(slug)
      .then(setPage)
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [slug]);

  if (loading) {
    return <Skeleton className="h-40 w-full rounded-xl" />;
  }

  if (notFound || !page) {
    return (
      <div className="rounded-xl border border-dashed border-zinc-300 p-10 text-center text-zinc-500 dark:border-zinc-700">
        This page hasn&apos;t been set up yet.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900/40">
      <Markdown>{page.bodyMd}</Markdown>
    </div>
  );
}

/* ── Schedule timeline ── */

function ScheduleTimeline({ comp }: { comp: CompetitionDetail }) {
  const steps: { label: string; at: string | null | undefined }[] = [
    { label: "Registration opens", at: comp.registrationOpensAt },
    { label: "Registration closes", at: comp.registrationDeadline },
    { label: "Competition starts", at: comp.startsAt },
    { label: "Competition ends", at: comp.endsAt },
  ];

  if (steps.every((s) => !s.at)) return null;

  const now = Date.now();
  let activeIndex = -1;
  steps.forEach((s, i) => {
    if (s.at && now >= new Date(s.at).getTime()) activeIndex = i;
  });

  return (
    <div className="mb-8 overflow-x-auto rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="flex min-w-[560px] items-start">
        {steps.map((s, i) => (
          <div key={s.label} className="flex flex-1 items-start">
            <div className="flex flex-col items-center text-center">
              <div
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${i <= activeIndex
                    ? "bg-accent-primary text-zinc-950"
                    : "bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-600"
                  }`}
              >
                {i < activeIndex ? "✓" : i + 1}
              </div>
              <p className={`mt-2 max-w-[110px] text-xs font-medium ${i <= activeIndex ? "text-zinc-900 dark:text-zinc-100" : "text-zinc-400 dark:text-zinc-600"}`}>
                {s.label}
              </p>
              <p className="mt-0.5 text-[11px] text-zinc-500">
                {s.at ? new Date(s.at).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "—"}
              </p>
              {s.at && (
                <p className="text-[11px] font-semibold text-zinc-500">
                  {new Date(s.at).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}
                </p>
              )}
            </div>
            {i < steps.length - 1 && (
              <div className={`mt-3.5 h-0.5 flex-1 ${i < activeIndex ? "bg-accent-primary" : "bg-zinc-200 dark:bg-zinc-800"}`} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Detailed schedule — every timed event (rounds, video deadlines) in order ── */

type ScheduleKind = "registration" | "competition" | "round-open" | "round-close" | "video-deadline";

interface ScheduleEntry {
  at: string;
  label: string;
  kind: ScheduleKind;
  eventType?: string;
}

const KIND_TAG: Record<ScheduleKind, { label: string; className: string }> = {
  registration: { label: "Registration", className: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" },
  competition: { label: "Competition", className: "bg-accent-primary/10 text-accent-primary" },
  "round-open": { label: "Round Opens", className: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" },
  "round-close": { label: "Round Closes", className: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400" },
  "video-deadline": { label: "Video Deadline", className: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" },
};

function buildScheduleEntries(comp: CompetitionDetail): ScheduleEntry[] {
  const entries: ScheduleEntry[] = [];

  if (comp.registrationOpensAt) entries.push({ at: comp.registrationOpensAt, label: "Registration opens", kind: "registration" });
  if (comp.registrationDeadline) entries.push({ at: comp.registrationDeadline, label: "Registration closes", kind: "registration" });
  if (comp.startsAt) entries.push({ at: comp.startsAt, label: "Competition starts", kind: "competition" });
  if (comp.endsAt) entries.push({ at: comp.endsAt, label: "Competition ends", kind: "competition" });

  const videoDeadlineMinutes = comp.videoDeadlineMinutes ?? 1440;
  for (const ev of comp.events) {
    const name = eventDisplayName(ev.eventType);
    for (const r of ev.rounds) {
      if (r.opensAt) {
        entries.push({ at: r.opensAt, label: `${name} — Round ${r.roundNumber} opens`, kind: "round-open", eventType: ev.eventType });
      }
      if (r.closesAt) {
        entries.push({ at: r.closesAt, label: `${name} — Round ${r.roundNumber} closes`, kind: "round-close", eventType: ev.eventType });
        const deadline = new Date(new Date(r.closesAt).getTime() + videoDeadlineMinutes * 60_000).toISOString();
        entries.push({ at: deadline, label: `${name} — Round ${r.roundNumber} video submission deadline`, kind: "video-deadline", eventType: ev.eventType });
      }
    }
  }

  return entries.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

function DetailedSchedule({ comp }: { comp: CompetitionDetail }) {
  const entries = buildScheduleEntries(comp);
  if (entries.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-zinc-300 p-10 text-center text-zinc-500 dark:border-zinc-700">
        No schedule has been set for this competition yet.
      </div>
    );
  }

  const now = Date.now();

  const groups: { dateKey: string; label: string; entries: ScheduleEntry[] }[] = [];
  for (const entry of entries) {
    const d = new Date(entry.at);
    const dateKey = d.toDateString();
    let group = groups.find((g) => g.dateKey === dateKey);
    if (!group) {
      group = {
        dateKey,
        label: d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" }),
        entries: [],
      };
      groups.push(group);
    }
    group.entries.push(entry);
  }

  return (
    <div>
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-zinc-500">Full Schedule</h2>
      <div className="space-y-6">
        {groups.map((group) => (
          <div key={group.dateKey}>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-600">
              {group.label}
            </p>
            <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
              {group.entries.map((entry, i) => {
                const isPast = new Date(entry.at).getTime() <= now;
                const tag = KIND_TAG[entry.kind];
                return (
                  <div
                    key={`${entry.label}-${entry.at}`}
                    className={`flex flex-wrap items-center gap-3 px-4 py-3 ${i > 0 ? "border-t border-zinc-100 dark:border-zinc-800/60" : ""
                      } ${isPast ? "bg-zinc-50 dark:bg-zinc-900/20" : "bg-white dark:bg-zinc-900/40"}`}
                  >
                    <span className="w-20 shrink-0 font-mono text-sm text-zinc-500">
                      {new Date(entry.at).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}
                    </span>
                    {entry.eventType && <EventIcon eventId={entry.eventType} size={16} className="shrink-0 text-zinc-400" />}
                    <span className={`flex-1 text-sm ${isPast ? "text-zinc-400 dark:text-zinc-600" : "text-zinc-800 dark:text-zinc-200"}`}>
                      {entry.label}
                    </span>
                    <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${tag.className}`}>
                      {tag.label}
                    </span>
                    {isPast && <span className="shrink-0 text-xs text-zinc-400 dark:text-zinc-600">✓</span>}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Registration progress steps ── */

function RegistrationSteps({ paymentStatus }: { paymentStatus: string | null }) {
  const steps = ["Select Events", "Pay", "Confirmed"];
  const activeIndex = paymentStatus === null ? 0 : paymentStatus === "paid" ? 2 : 1;

  return (
    <div className="flex items-center gap-2">
      {steps.map((label, i) => (
        <div key={label} className="flex items-center gap-2">
          <span
            className={`rounded-full px-3 py-1 text-xs font-semibold ${i < activeIndex
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                : i === activeIndex
                  ? "bg-accent-primary text-zinc-950"
                  : "bg-zinc-100 text-zinc-400 dark:bg-zinc-900 dark:text-zinc-600"
              }`}
          >
            {i < activeIndex ? "✓" : i + 1} {label}
          </span>
          {i < steps.length - 1 && <span className="text-zinc-300 dark:text-zinc-700">→</span>}
        </div>
      ))}
    </div>
  );
}

/* ── Pagination ── */

const ROWS_PER_PAGE = 10;

function Pagination({ currentPage, totalPages, onPageChange }: { currentPage: number; totalPages: number; onPageChange: (p: number) => void }) {
  if (totalPages < 1) return null;

  const pages: (number | "...")[] = [];
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pages.push(i);
  } else {
    pages.push(1);
    if (currentPage > 3) pages.push("...");
    for (let i = Math.max(2, currentPage - 1); i <= Math.min(totalPages - 1, currentPage + 1); i++) pages.push(i);
    if (currentPage < totalPages - 2) pages.push("...");
    pages.push(totalPages);
  }

  return (
    <div className="mt-4 flex items-center justify-center gap-1">
      <button
        onClick={() => onPageChange(Math.max(1, currentPage - 1))}
        disabled={currentPage === 1}
        className="rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-sm text-zinc-500 transition hover:bg-zinc-50 disabled:opacity-30 dark:border-zinc-700 dark:bg-zinc-900/40 dark:hover:bg-zinc-800"
      >
        ‹
      </button>
      {pages.map((p, i) =>
        p === "..." ? (
          <span key={`dots-${i}`} className="px-1.5 text-sm text-zinc-400">…</span>
        ) : (
          <button
            key={p}
            onClick={() => onPageChange(p)}
            className={`min-w-[32px] rounded-lg border px-2.5 py-1.5 text-sm font-medium transition ${
              currentPage === p
                ? "border-accent-primary bg-accent-primary text-zinc-950"
                : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900/40 dark:text-zinc-400 dark:hover:bg-zinc-800"
            }`}
          >
            {p}
          </button>
        ),
      )}
      <button
        onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
        disabled={currentPage === totalPages}
        className="rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-sm text-zinc-500 transition hover:bg-zinc-50 disabled:opacity-30 dark:border-zinc-700 dark:bg-zinc-900/40 dark:hover:bg-zinc-800"
      >
        ›
      </button>
    </div>
  );
}

/* ── Event & Round dropdown selectors (shared by all U&R tabs) ── */

function EventRoundDropdowns({
  comp,
  selectedEvent,
  selectedRound,
  onEventChange,
  onRoundChange,
}: {
  comp: CompetitionDetail;
  selectedEvent: string;
  selectedRound: number;
  onEventChange: (e: string) => void;
  onRoundChange: (r: number) => void;
}) {
  const event = comp.events.find((e) => e.eventType === selectedEvent);
  const rounds = event?.rounds ?? [];

  return (
    <div className="flex flex-wrap gap-3">
      <select
        value={selectedEvent}
        onChange={(e) => { onEventChange(e.target.value); onRoundChange(1); }}
        className="w-[160px] rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900/40 dark:text-zinc-300"
      >
        {comp.events.map((ev) => (
          <option key={ev.eventType} value={ev.eventType}>
            {eventDisplayName(ev.eventType)}
          </option>
        ))}
      </select>
      <select
        value={selectedRound}
        onChange={(e) => onRoundChange(Number(e.target.value))}
        className="w-[220px] rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900/40 dark:text-zinc-300"
      >
        {rounds.map((r) => (
          <option key={r.id} value={r.roundNumber}>
            Round {r.roundNumber}{r.roundNumber === 1 ? " (all participants)" : " (advanced only)"}
          </option>
        ))}
        {rounds.length === 0 && <option value={1}>Round 1</option>}
      </select>
    </div>
  );
}

/* ── Participants Tab ── */

function ParticipantsTab({ comp, onCountChange }: { comp: CompetitionDetail; onCountChange?: (n: number) => void }) {
  const [selectedEvent, setSelectedEvent] = useState(comp.events[0]?.eventType ?? "");
  const [selectedRound, setSelectedRound] = useState(1);
  const [participants, setParticipants] = useState<ParticipantEntry[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  useEffect(() => {
    setLoading(true);
    setPage(1);
    fetchParticipants(comp.id)
      .then((d) => {
        const filtered = selectedEvent
          ? d.participants.filter((p) => p.eventTypes.includes(selectedEvent))
          : d.participants;
        setParticipants(filtered);
        setCount(filtered.length);
        onCountChange?.(filtered.length);
      })
      .catch(() => { })
      .finally(() => setLoading(false));
  }, [comp.id, selectedEvent, onCountChange]);

  const totalPages = Math.ceil(count / ROWS_PER_PAGE);
  const visibleParticipants = participants.slice((page - 1) * ROWS_PER_PAGE, page * ROWS_PER_PAGE);

  return (
    <div>
      <div className="mb-4">
        <EventRoundDropdowns
          comp={comp}
          selectedEvent={selectedEvent}
          selectedRound={selectedRound}
          onEventChange={setSelectedEvent}
          onRoundChange={setSelectedRound}
        />
      </div>

      {selectedRound > 1 && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-700 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-400">
          <span>⚠</span>
          <span>Showing only users who advanced from previous round. If previous round results aren&apos;t verified yet, this list may be incomplete.</span>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-50 dark:bg-zinc-900/60">
            <tr>
              <th className="px-4 py-3 font-medium text-zinc-500">#</th>
              <th className="px-4 py-3 font-medium text-zinc-500">Name</th>
              <th className="px-4 py-3 font-medium text-zinc-500">CL ID</th>
              <th className="px-4 py-3 font-medium text-zinc-500">Events</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {!loading && visibleParticipants.map((p, i) => (
              <tr key={p.userId} className="row-count-in bg-white dark:bg-zinc-900/40" style={{ animationDelay: `${Math.min(i, 20) * 25}ms` }}>
                <td className="px-4 py-3 text-zinc-400">{(page - 1) * ROWS_PER_PAGE + i + 1}</td>
                <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100">
                  <a href={`/profile/${p.clId}`} className="hover:text-accent-primary transition-colors">{p.name}</a>
                </td>
                <td className="px-4 py-3 font-mono text-xs text-zinc-500">
                  <a href={`/profile/${p.clId}`} className="hover:text-accent-primary transition-colors">{p.clId}</a>
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {p.eventTypes.map((e) => (
                      <span
                        key={e}
                        title={eventDisplayName(e)}
                        className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                      >
                        <EventIcon eventId={e} size={16} /> {eventDisplayName(e)}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
            {Array.from({ length: ROWS_PER_PAGE - (loading ? 0 : visibleParticipants.length) }).map((_, i) => (
              <tr key={`empty-${i}`} className="bg-white dark:bg-zinc-900/40">
                <td className="px-4 py-3 text-zinc-300 dark:text-zinc-700">—</td>
                <td className="px-4 py-3" />
                <td className="px-4 py-3" />
                <td className="px-4 py-3" />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && participants.length > 0 && (
        <>
          <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />
          <p className="mt-2 text-center text-xs text-zinc-400">
            Showing {(page - 1) * ROWS_PER_PAGE + 1}–{Math.min(page * ROWS_PER_PAGE, count)} of {count}
          </p>
        </>
      )}
    </div>
  );
}

/* ── Rankings Tab ── */

/**
 * Which event the rankings view should open on.
 *
 * The event that is live right now, so competitors land on the standings that
 * are actually moving. If nothing is live, the most recently published event —
 * the last one that finished — rather than always snapping back to the first.
 */
function pickDefaultEvent(events: CompetitionDetail["events"]): string {
  const active = events.filter((e) => !e.archived);
  const live = active.find((e) => e.rounds.some((r) => r.status === "open"));
  if (live) return live.eventType;
  const lastDone = [...active].reverse().find((e) => e.rounds.some((r) => r.resultsPublishedAt));
  if (lastDone) return lastDone.eventType;
  return active[0]?.eventType ?? events[0]?.eventType ?? "";
}

function RankingsTab({ comp, showResultsLink, userId }: { comp: CompetitionDetail; showResultsLink: boolean; userId?: string }) {
  const [selectedEvent, setSelectedEvent] = useState(() => pickDefaultEvent(comp.events));
  const [selectedRound, setSelectedRound] = useState(1);
  const [ranking, setRanking] = useState<LiveRankingEntry[]>([]);
  const [roundInfo, setRoundInfo] = useState<{ roundNumber: number | null }>({ roundNumber: null });
  const [activeRoundId, setActiveRoundId] = useState<string | null>(null);
  /** Set once the organiser publishes: the standings are final from then on. */
  const [publishedAt, setPublishedAt] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const sectionRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  const [appealTarget, setAppealTarget] = useState<{ resultId: string; name: string } | null>(null);
  const [appealReason, setAppealReason] = useState("");
  const [appealStatus, setAppealStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [appealError, setAppealError] = useState("");

  // Track visibility — only connect socket when section is on screen
  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { threshold: 0 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!selectedEvent) return;
    setLoading(true);
    setPage(1);
    fetchLiveRanking(comp.id, selectedEvent)
      .then((d) => {
        setRanking(d.ranking);
        setRoundInfo({ roundNumber: d.roundNumber });
        setActiveRoundId(d.roundId);
        setPublishedAt(d.resultsPublishedAt);
      })
      .catch(() => setRanking([]))
      .finally(() => setLoading(false));
  }, [comp.id, selectedEvent]);

  // Subscribe to real-time leaderboard updates only when visible
  useEffect(() => {
    if (!activeRoundId || !visible) return;

    const socket = acquireSocket();
    socket.emit("join", { roundId: activeRoundId });

    const handler = (data: { roundId: string; board: Array<{
      id: string; userId: string; userName?: string; userClId?: string;
      ao5Ms: number | null; bestSingleMs: number | null; rank: number | null; flagStatus: string;
    }> }) => {
      if (data.roundId !== activeRoundId) return;
      const updated: LiveRankingEntry[] = data.board.map((r) => ({
        resultId: r.id,
        userId: r.userId,
        clId: r.userClId ?? r.userId,
        name: r.userName ?? "Unknown",
        rank: r.rank,
        ao5Ms: r.ao5Ms,
        bestSingleMs: r.bestSingleMs,
        flagStatus: r.flagStatus,
      }));
      updated.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
      setRanking(updated);
    };

    socket.on("leaderboard:update", handler);

    return () => {
      socket.off("leaderboard:update", handler);
      releaseSocket();
    };
  }, [activeRoundId, visible]);

  const totalPages = Math.ceil(ranking.length / ROWS_PER_PAGE);
  const visibleRanking = ranking.slice((page - 1) * ROWS_PER_PAGE, page * ROWS_PER_PAGE);
  const pageOffset = (page - 1) * ROWS_PER_PAGE;

  const myEntry = userId ? ranking.find((r) => r.userId === userId) : null;

  return (
    <div ref={sectionRef}>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <EventRoundDropdowns
          comp={comp}
          selectedEvent={selectedEvent}
          selectedRound={selectedRound}
          onEventChange={setSelectedEvent}
          onRoundChange={setSelectedRound}
        />
        <div className="ml-auto flex items-center gap-2">
          {/* Published results are frozen — the shortlist was taken from these
              exact numbers — so they stop being presented as a live feed. */}
          {publishedAt ? (
            <span
              className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
              title={`Published ${new Date(publishedAt).toLocaleString()}`}
            >
              Final Standings
            </span>
          ) : (
            activeRoundId && visible && (
              <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-500">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                </span>
                LIVE
              </span>
            )
          )}
          {showResultsLink && (
            <Link
              href={`/competitions/${comp.id}/results`}
              className="rounded-lg border border-accent-primary/30 bg-accent-primary/10 px-3 py-2 text-sm font-medium text-accent-primary transition hover:bg-accent-primary/20"
            >
              View Full Results
            </Link>
          )}
          {showResultsLink && myEntry && (
            <button
              onClick={() => {
                setAppealTarget({ resultId: myEntry.resultId, name: myEntry.name });
                setAppealReason("");
                setAppealStatus("idle");
              }}
              className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm font-medium text-amber-500 transition hover:bg-amber-400/20"
            >
              Appeal
            </button>
          )}
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-50 dark:bg-zinc-900/60">
            <tr>
              <th className="px-4 py-3 font-medium text-zinc-500">Rank</th>
              <th className="px-4 py-3 font-medium text-zinc-500">Name</th>
              <th className="px-4 py-3 font-medium text-zinc-500">ao5</th>
              <th className="px-4 py-3 font-medium text-zinc-500">Best</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {!loading && visibleRanking.map((r, i) => {
              const globalIdx = pageOffset + i;
              const isMe = r.userId === userId;
              return (
                <tr key={r.userId} className={`row-count-in ${isMe ? "bg-accent-primary/5 ring-1 ring-accent-primary/20" : "bg-white dark:bg-zinc-900/40"}`} style={{ animationDelay: `${Math.min(i, 20) * 25}ms` }}>
                  <td className="px-4 py-3 font-mono text-zinc-400">
                    {globalIdx === 0 ? "🥇" : globalIdx === 1 ? "🥈" : globalIdx === 2 ? "🥉" : (r.rank ?? "—")}
                  </td>
                  <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100">
                    <a href={`/profile/${r.clId}`} className="hover:text-accent-primary transition-colors">{r.name}</a>
                    {isMe && <span className="ml-2 rounded bg-accent-primary/10 px-1.5 py-0.5 text-[10px] font-bold text-accent-primary">YOU</span>}
                  </td>
                  <td className="px-4 py-3 font-mono text-zinc-700 dark:text-zinc-300">
                    {r.ao5Ms !== null ? formatTime(r.ao5Ms) : "DNF"}
                  </td>
                  <td className="px-4 py-3 font-mono text-zinc-700 dark:text-zinc-300">
                    {r.bestSingleMs !== null ? formatTime(r.bestSingleMs) : "DNF"}
                  </td>
                </tr>
              );
            })}
            {Array.from({ length: ROWS_PER_PAGE - (loading ? 0 : visibleRanking.length) }).map((_, i) => (
              <tr key={`empty-${i}`} className="bg-white dark:bg-zinc-900/40">
                <td className="px-4 py-3 font-mono text-zinc-300 dark:text-zinc-700">—</td>
                <td className="px-4 py-3" />
                <td className="px-4 py-3" />
                <td className="px-4 py-3" />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && ranking.length > 0 && (
        <>
          <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />
          <p className="mt-2 text-center text-xs text-zinc-400">
            Showing {pageOffset + 1}–{Math.min(page * ROWS_PER_PAGE, ranking.length)} of {ranking.length}
          </p>
        </>
      )}

      <Modal open={!!appealTarget} onClose={() => setAppealTarget(null)} title="Submit Appeal">
        <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
          Appeal your result for <strong>{selectedEvent}</strong> — Round {roundInfo.roundNumber ?? 1}
        </p>
        <textarea
          className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          rows={4}
          value={appealReason}
          onChange={(e) => setAppealReason(e.target.value)}
          placeholder="Describe the issue with your result..."
        />
        {appealStatus === "error" && (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400">{appealError}</p>
        )}
        {appealStatus === "sent" && (
          <p className="mt-2 text-sm text-emerald-600 dark:text-emerald-400">Appeal submitted successfully!</p>
        )}
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={() => setAppealTarget(null)}>
            {appealStatus === "sent" ? "Close" : "Cancel"}
          </Button>
          {appealStatus !== "sent" && (
            <Button
              disabled={!appealReason.trim()}
              loading={appealStatus === "sending"}
              onClick={async () => {
                setAppealStatus("sending");
                try {
                  await submitAppeal(appealTarget!.resultId, appealReason.trim());
                  setAppealStatus("sent");
                } catch (e) {
                  setAppealError(e instanceof Error ? e.message : String(e));
                  setAppealStatus("error");
                }
              }}
            >
              Submit Appeal
            </Button>
          )}
        </div>
      </Modal>
    </div>
  );
}

/* ── Users & Rankings (tabbed section) ── */

type URTab = "rankings" | "participants" | "glance";

function UsersAndRankingsSection({
  comp,
  user,
  isCompleted,
  myProgress,
  registeredEventTypes,
}: {
  comp: CompetitionDetail;
  user: { id: string; clId: string; name: string } | null;
  isCompleted: boolean;
  myProgress: RoundProgress[];
  registeredEventTypes: string[];
}) {
  const [tab, setTab] = useState<URTab>("rankings");
  const [participantCount, setParticipantCount] = useState<number | null>(null);

  const tabs: { id: URTab; label: string; count?: number; hidden?: boolean }[] = [
    { id: "rankings", label: "Live Rankings" },
    { id: "participants", label: "Participants", count: participantCount ?? undefined },
    { id: "glance", label: "At a Glance", hidden: !user },
  ];

  const visibleTabs = tabs.filter((t) => !t.hidden);

  return (
    <div>
      <div className="mb-4 flex gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800/60">
        {visibleTabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition ${
              tab === t.id
                ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-100"
                : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300"
            }`}
          >
            {t.label}
            {t.count != null && (
              <span className="ml-1.5 font-mono text-xs font-normal text-zinc-400">{t.count}</span>
            )}
          </button>
        ))}
      </div>

      {tab === "rankings" && (
        <RankingsTab
          comp={comp}
          showResultsLink={["results_pending", "completed", "live"].includes(comp.status)}
          userId={user?.id}
        />
      )}

      {tab === "participants" && (
        <ParticipantsTab comp={comp} onCountChange={setParticipantCount} />
      )}

      {tab === "glance" && user && (
        <GlanceTab comp={comp} myProgress={myProgress} registeredEventTypes={registeredEventTypes} />
      )}
    </div>
  );
}

/* ── At a Glance — user's per-event, per-round data with all solves ── */

function glanceSolveLabel(s: { time_ms: number; penalty: string; inspectionPenalty?: string }): string {
  if (s.penalty === "dnf" || s.inspectionPenalty === "dnf") return "DNF";
  const extra = (s.penalty === "plus2" ? 2000 : 0) + (s.inspectionPenalty === "plus2" ? 2000 : 0);
  const t = s.time_ms + extra;
  const formatted = formatTime(t);
  return extra > 0 ? `${formatted}+` : formatted;
}

function GlanceTab({
  comp,
  myProgress,
  registeredEventTypes,
}: {
  comp: CompetitionDetail;
  myProgress: RoundProgress[];
  registeredEventTypes: string[];
}) {
  const eventGroups = useMemo(() => {
    // Only the events this competitor actually registered for — the glance is
    // "my schedule", not the whole competition. Events they are not in used to
    // show here as empty "no-data" rows.
    const mine = new Set(registeredEventTypes);
    const groups: { eventType: string; eventName: string; rounds: RoundProgress[] }[] = [];
    for (const ev of comp.events) {
      if (!mine.has(ev.eventType)) continue;
      const rounds = myProgress
        .filter((p) => p.eventType === ev.eventType)
        .sort((a, b) => a.roundNumber - b.roundNumber);
      groups.push({ eventType: ev.eventType, eventName: eventDisplayName(ev.eventType), rounds });
    }
    return groups;
  }, [comp.events, myProgress, registeredEventTypes]);

  if (eventGroups.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
        You are not registered for any events in this competition.
      </p>
    );
  }

  // Build flat rows: one per round, grouped under event headers
  const rows: Array<
    | { type: "event-header"; eventType: string; eventName: string }
    | { type: "round"; rp: RoundProgress }
    | { type: "no-data"; eventType: string }
  > = [];
  for (const g of eventGroups) {
    rows.push({ type: "event-header", eventType: g.eventType, eventName: g.eventName });
    if (g.rounds.length === 0) {
      rows.push({ type: "no-data", eventType: g.eventType });
    } else {
      for (const rp of g.rounds) rows.push({ type: "round", rp });
    }
  }

  // Fixed-height container matching the other tabs (ROWS_PER_PAGE rows)
  return (
    <div>
      <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-50 dark:bg-zinc-900/60">
            <tr>
              <th className="px-4 py-3 font-medium text-zinc-500">Event / Round</th>
              <th className="px-4 py-3 font-medium text-zinc-500">Solves</th>
              <th className="px-4 py-3 font-medium text-zinc-500">ao5</th>
              <th className="px-4 py-3 font-medium text-zinc-500">Best</th>
              <th className="px-4 py-3 font-medium text-zinc-500">Rank</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {rows.map((row, i) => {
              if (row.type === "event-header") {
                return (
                  <tr key={`eh-${row.eventType}`} className="bg-zinc-50 dark:bg-zinc-900/60">
                    <td colSpan={5} className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <EventIcon eventId={row.eventType} size={16} className="text-accent-primary" />
                        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{row.eventName}</span>
                      </div>
                    </td>
                  </tr>
                );
              }

              if (row.type === "no-data") {
                return (
                  <tr key={`nd-${row.eventType}`} className="bg-white dark:bg-zinc-900/40">
                    <td colSpan={5} className="px-4 py-3 text-center text-sm text-zinc-400">Not participated</td>
                  </tr>
                );
              }

              const rp = row.rp;
              const statusLabel =
                rp.userStatus === "submitted" ? "Submitted" :
                rp.userStatus === "locked" || rp.userStatus === "eliminated" ? "Not Qualified" :
                rp.status === "open" ? "Open" :
                rp.status === "pending" ? "Upcoming" : "Closed";
              const statusColor =
                rp.userStatus === "submitted" ? "text-emerald-600 dark:text-emerald-400" :
                rp.userStatus === "locked" || rp.userStatus === "eliminated" ? "text-red-500 dark:text-red-400" :
                rp.status === "open" ? "text-amber-600 dark:text-amber-400" :
                "text-zinc-400";

              return (
                <tr key={rp.roundId} className="row-count-in bg-white dark:bg-zinc-900/40" style={{ animationDelay: `${Math.min(i, 20) * 25}ms` }}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-zinc-700 dark:text-zinc-300">Round {rp.roundNumber}</div>
                    <span className={`text-xs font-semibold ${statusColor}`}>{statusLabel}</span>
                  </td>
                  <td className="px-4 py-3">
                    {rp.result?.solves && rp.result.solves.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {rp.result.solves.map((s, si) => (
                          <span
                            key={si}
                            className={`rounded px-1.5 py-0.5 font-mono text-xs ${
                              s.penalty === "dnf" || s.inspectionPenalty === "dnf"
                                ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                                : s.penalty === "plus2" || s.inspectionPenalty === "plus2"
                                  ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                                  : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                            }`}
                          >
                            {glanceSolveLabel(s)}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-zinc-700 dark:text-zinc-300">
                    {rp.result ? (rp.result.ao5Ms != null ? formatTime(rp.result.ao5Ms) : "DNF") : "—"}
                  </td>
                  <td className="px-4 py-3 font-mono text-zinc-700 dark:text-zinc-300">
                    {rp.result ? (rp.result.bestSingleMs != null ? formatTime(rp.result.bestSingleMs) : "DNF") : "—"}
                  </td>
                  <td className="px-4 py-3">
                    {rp.result?.rank != null ? (
                      <span className="inline-flex items-center gap-1 font-mono font-semibold text-zinc-900 dark:text-zinc-100">
                        {rp.result.rank <= 3 && (
                          <span>{rp.result.rank === 1 ? "🥇" : rp.result.rank === 2 ? "🥈" : "🥉"}</span>
                        )}
                        #{rp.result.rank}
                      </span>
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {/* Fill empty rows to match fixed table height */}
            {Array.from({ length: Math.max(0, ROWS_PER_PAGE - rows.length) }).map((_, i) => (
              <tr key={`empty-${i}`} className="bg-white dark:bg-zinc-900/40">
                <td className="px-4 py-3 text-zinc-300 dark:text-zinc-700">—</td>
                <td className="px-4 py-3" />
                <td className="px-4 py-3" />
                <td className="px-4 py-3" />
                <td className="px-4 py-3" />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
