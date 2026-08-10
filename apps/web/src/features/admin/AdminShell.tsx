"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/features/auth/AuthProvider";
import { useSidebar } from "@/features/admin/SidebarContext";

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
      { label: "Verification (Legacy)", href: "/admin/verification" },
      { label: "Appeals", href: "/admin/appeals" },
    ],
  },
  {
    label: "Content",
    adminOnly: true,
    items: [
      { label: "Announcements", href: "/admin/announcements" },
      { label: "Content", href: "/admin/content" },
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
    ],
  },
];

export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user } = useAuth();
  const { collapsed, toggle } = useSidebar();

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
      <aside
        className={`fixed left-0 top-14 z-30 hidden h-[calc(100vh-56px)] overflow-y-auto border-r border-zinc-200 bg-white transition-all duration-200 dark:border-zinc-800 dark:bg-zinc-950 md:block ${
          collapsed ? "w-0 overflow-hidden border-r-0" : "w-56"
        }`}
      >
        <nav className="w-56 space-y-5 px-3 py-6">
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

        {/* Collapse button at bottom of sidebar */}
        <button
          onClick={toggle}
          className="absolute bottom-4 right-3 rounded-md p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
          title="Collapse sidebar"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 3L5 8l5 5" />
          </svg>
        </button>
      </aside>

      {/* Expand button — visible only when sidebar is collapsed */}
      {collapsed && (
        <button
          onClick={toggle}
          className="fixed left-2 top-[68px] z-30 hidden rounded-md border border-zinc-200 bg-white p-1.5 text-zinc-400 shadow-sm transition hover:bg-zinc-50 hover:text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-300 md:block"
          title="Expand sidebar"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 3l5 5-5 5" />
          </svg>
        </button>
      )}

      <div className={`min-w-0 overflow-x-auto transition-all duration-200 ${collapsed ? "md:ml-0" : "md:ml-56"}`}>
        {children}
      </div>
    </>
  );
}
