"use client";

import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/features/auth/AuthProvider";
import { useTheme } from "@/features/theme/ThemeProvider";
import { globalSearch, type GlobalSearchResult } from "@/lib/api";

const NAV_LINKS = [
  { href: "/competitions", label: "Competitions" },
  { href: "/practice", label: "Practice" },
  { href: "/rankings", label: "Rankings" },
];

export function NavBar() {
  const { user, loading, signOut } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const router = useRouter();
  const pathname = usePathname();

  const [search, setSearch] = useState("");
  const [results, setResults] = useState<GlobalSearchResult[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [searching, setSearching] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const fn = () => setScrolled(window.scrollY > 20);
    fn();
    window.addEventListener("scroll", fn);
    return () => window.removeEventListener("scroll", fn);
  }, []);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const doSearch = useCallback(async (q: string) => {
    if (q.length < 2) {
      setResults([]);
      setShowResults(false);
      return;
    }
    setSearching(true);
    try {
      const res = await globalSearch(q);
      setResults(res);
      setShowResults(true);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  const onSearchChange = useCallback(
    (val: string) => {
      setSearch(val);
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => doSearch(val), 300);
    },
    [doSearch],
  );

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowResults(false);
      }
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <>
    <nav
      data-layout="navbar"
      className={`fixed inset-x-0 top-0 z-40 flex h-14 items-center justify-between border-b px-6 text-sm transition-all duration-200 ${
        scrolled
          ? "border-[var(--border-default)] bg-[var(--bg-glass)] shadow-sm backdrop-blur-xl"
          : "border-transparent bg-[var(--bg-page)]/80 backdrop-blur-md"
      }`}
    >
      {/* Left — logo + nav links */}
      <div className="flex items-center gap-5">
        <button
          onClick={() => setMobileOpen((v) => !v)}
          className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-300 md:hidden"
          aria-label="Toggle menu"
        >
          {mobileOpen ? <CloseIcon /> : <MenuIcon />}
        </button>
        <Link href="/" className="text-lg font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
          Cubelelo<span className="bg-gradient-to-r from-accent-primary to-[var(--accent-secondary)] bg-clip-text text-transparent"> Events</span>
        </Link>
        <div className="hidden items-center gap-1 md:flex">
          {NAV_LINKS.map((l) => (
            <NavLink key={l.href} href={l.href} active={pathname === l.href}>
              {l.label}
            </NavLink>
          ))}
        </div>
      </div>

      {/* Center — search */}
      <div className="relative hidden md:block" ref={searchRef}>
        <div className="flex items-center">
          <input
            type="text"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            onFocus={() => results.length > 0 && setShowResults(true)}
            placeholder="Search competitions, users..."
            className="w-64 rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-1.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] backdrop-blur-sm focus:border-[var(--border-hover)] focus:outline-none"
          />
          <button
            onClick={() => doSearch(search)}
            className="-ml-8 z-10 rounded-md bg-gradient-to-r from-accent-primary to-[var(--accent-secondary)] px-2 py-1 text-[#080b12] transition hover:brightness-110"
          >
            <SearchIcon />
          </button>
        </div>

        {showResults && (
          <div className="absolute left-0 top-full z-50 mt-1 w-80 rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] shadow-lg backdrop-blur-xl">
            {searching ? (
              <div className="px-4 py-3 text-xs text-zinc-400">Searching...</div>
            ) : results.length === 0 ? (
              <div className="px-4 py-3 text-xs text-zinc-400">No results found</div>
            ) : (
              results.map((r) => (
                <button
                  key={`${r.type}-${r.id}`}
                  onClick={() => {
                    if (!r.href) return;
                    setShowResults(false);
                    setSearch("");
                    router.push(r.href);
                  }}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition hover:bg-zinc-50 dark:hover:bg-zinc-800"
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-xs font-bold text-white">
                    {r.type === "user" ? r.title.charAt(0).toUpperCase()
                      : r.type === "competition" ? "C"
                      : r.type === "admin" ? "A"
                      : r.type === "announcement" ? "N"
                      : "P"}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                      {r.title}
                    </p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      {r.subtitle}
                    </p>
                  </div>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {/* Right — theme toggle + user */}
      <div className="flex items-center gap-3">
        <button
          onClick={toggleTheme}
          className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        >
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
        </button>

        {loading ? (
          <span className="text-zinc-400 dark:text-zinc-600">...</span>
        ) : user ? (
          <div className="relative flex items-center gap-2" ref={dropdownRef}>
            {user.clId && (
              <span className="hidden text-xs font-mono text-zinc-700 dark:text-zinc-300 lg:inline">
                {user.clId}
              </span>
            )}
            <button
              onClick={() => setShowDropdown((v) => !v)}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-accent-primary to-[var(--accent-secondary)] text-sm font-bold text-[#080b12] shadow-[0_0_12px_var(--accent-glow)] transition hover:shadow-[0_0_20px_var(--accent-glow)]"
            >
              {user.name
                .split(" ")
                .map((w) => w.charAt(0))
                .join("")
                .slice(0, 2)
                .toUpperCase()}
            </button>

            {showDropdown && (
              <div className="absolute right-0 top-full z-50 mt-2 w-52 rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] py-1 shadow-lg backdrop-blur-xl">
                <div className="border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
                  <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                    {user.name}
                  </p>
                  <p className="text-xs text-emerald-600 dark:text-emerald-400">{user.clId}</p>
                </div>
                <DropdownItem
                  icon={<ProfileIcon />}
                  label="My Profile"
                  onClick={() => {
                    setShowDropdown(false);
                    router.push(`/profile/${user.clId}`);
                  }}
                />
                <DropdownItem
                  icon={<EditIcon />}
                  label="Edit Profile"
                  onClick={() => {
                    setShowDropdown(false);
                    router.push("/settings");
                  }}
                />
                {(user.role === "judge" || user.role === "moderator" || user.role === "admin") && (
                  <DropdownItem
                    icon={<AdminIcon />}
                    label="Judge Panel"
                    onClick={() => {
                      setShowDropdown(false);
                      router.push("/judge/verifications");
                    }}
                  />
                )}
                {(user.role === "admin" || user.role === "super_admin") && (
                  <DropdownItem
                    icon={<AdminIcon />}
                    label="Admin Panel"
                    onClick={() => {
                      setShowDropdown(false);
                      router.push("/admin");
                    }}
                  />
                )}
                <div className="border-t border-zinc-100 dark:border-zinc-800">
                  <DropdownItem
                    icon={<SignOutIcon />}
                    label="Sign out"
                    onClick={() => {
                      setShowDropdown(false);
                      signOut();
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Link
              href="/login"
              className="rounded-lg px-3 py-1.5 text-xs text-[var(--text-tertiary)] transition hover:text-[var(--text-primary)]"
            >
              Sign in
            </Link>
            <Link
              href="/register"
              className="rounded-lg bg-gradient-to-r from-accent-primary to-[var(--accent-secondary)] px-3 py-1.5 text-xs font-semibold text-[#080b12] shadow-[0_2px_12px_var(--accent-glow)] transition hover:shadow-[0_4px_20px_var(--accent-glow)]"
            >
              Sign up
            </Link>
          </div>
        )}
      </div>
    </nav>

    {mobileOpen && (
      <div className="fixed inset-x-0 top-14 z-40 border-b border-[var(--border-default)] bg-[var(--bg-glass)] px-6 py-3 backdrop-blur-xl md:hidden">
        <div className="flex flex-col gap-1">
          {NAV_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`rounded-lg px-3 py-2 text-sm transition ${
                pathname === l.href
                  ? "bg-accent-primary/10 font-semibold text-accent-primary"
                  : "text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900"
              }`}
            >
              {l.label}
            </Link>
          ))}
        </div>
      </div>
    )}
    </>
  );
}

function DropdownItem({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-3 px-4 py-2.5 text-sm text-zinc-700 transition hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800"
    >
      <span className="text-zinc-400 dark:text-zinc-500">{icon}</span>
      {label}
    </button>
  );
}

function NavLink({
  href,
  active,
  children,
}: {
  href: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`relative rounded-lg px-3 py-1.5 transition ${
        active
          ? "text-zinc-900 dark:text-zinc-100"
          : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
      }`}
    >
      {children}
      {active && (
        <span className="absolute inset-x-2 -bottom-[13px] h-0.5 rounded-full bg-accent-primary" />
      )}
    </Link>
  );
}

function MenuIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

/* ── Icons ── */

function SearchIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}


function ProfileIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

function AdminIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
    </svg>
  );
}

function SignOutIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}
