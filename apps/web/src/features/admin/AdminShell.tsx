"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/features/auth/AuthProvider";

interface NavItem {
  label: string;
  href: string;
}

interface NavGroup {
  label: string;
  /** If set, only these roles see this group. Omit = everyone with admin panel access. */
  adminOnly?: boolean;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Competitions",
    items: [
      { label: "Competitions", href: "/admin" },
      { label: "Create Competition", href: "/admin/create-competition" },
    ],
  },
  {
    label: "People",
    adminOnly: true,
    items: [
      { label: "Users", href: "/admin/users" },
      { label: "Staff", href: "/admin/staff" },
    ],
  },
  {
    label: "Money",
    adminOnly: true,
    items: [
      { label: "Payments", href: "/admin/payments" },
      { label: "Promo Codes", href: "/admin/promo-codes" },
    ],
  },
  {
    label: "Review",
    items: [
      { label: "Verification Hub", href: "/admin/verification-hub" },
      { label: "WCA Queue", href: "/admin/wca-queue" },
      { label: "Appeals", href: "/admin/appeals" },
      { label: "Withdrawals", href: "/admin/withdrawal-requests" },
    ],
  },
  {
    label: "Content",
    adminOnly: true,
    items: [
      { label: "Announcements", href: "/admin/announcements" },
      { label: "Content", href: "/admin/content" },
      { label: "FAQs", href: "/admin/faq" },
    ],
  },
  {
    label: "System",
    adminOnly: true,
    items: [
      { label: "Settings", href: "/admin/settings" },
      { label: "Rank Tiers", href: "/admin/rank-tiers" },
      { label: "Merge Accounts", href: "/admin/merge" },
      { label: "Migration", href: "/admin/migration" },
      { label: "System Health", href: "/health" },
    ],
  },
];

export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user } = useAuth();

  const isFullAdmin = user?.role === "admin" || user?.role === "super_admin";
  const isJudge = user?.role === "judge";

  const isActive = (href: string) => (href === "/admin" ? pathname === "/admin" : pathname.startsWith(href));

  const visibleGroups = NAV_GROUPS.filter((g) => !g.adminOnly || isFullAdmin);

  // Judges get no sidebar — they only access the workspace
  if (isJudge) {
    return <div className="min-w-0 overflow-x-auto">{children}</div>;
  }

  return (
    <>
      <aside className="fixed left-0 top-14 z-30 hidden h-[calc(100vh-56px)] w-56 overflow-y-auto border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 md:block">
        <nav className="space-y-5 px-3 py-6">
          {visibleGroups.map((group) => (
            <div key={group.label}>
              <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-600">
                {group.label}
              </p>
              <div className="space-y-0.5">
                {group.items.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`block rounded-lg px-3 py-1.5 text-sm transition ${isActive(item.href)
                        ? "bg-accent-primary/10 font-semibold text-accent-primary"
                        : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
                      }`}
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </nav>
      </aside>

      <div className="min-w-0 overflow-x-auto md:ml-56">
        {children}
      </div>
    </>
  );
}
