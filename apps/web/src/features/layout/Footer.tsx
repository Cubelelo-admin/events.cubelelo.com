"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const DETAIL_LINKS = [
  { label: "About Us", href: "/pages/about-us" },
  { label: "Rules", href: "/pages/rules" },
  { label: "FAQs", href: "/pages/faqs" },
  { label: "Privacy Policy", href: "/pages/privacy-policy" },
  { label: "Contact Us", href: "/pages/contact-us" },
];


export function Footer() {
  const pathname = usePathname();
  if (pathname.startsWith("/admin")) return null;
  if (pathname === "/competitions") return null;
  if (/^\/competitions\/[^/]+$/.test(pathname)) return null;

  return (
    <footer data-layout="footer" className="relative z-[1] mt-auto border-t border-[var(--border-default)] bg-[var(--bg-glass)] py-8 text-center text-xs text-[var(--text-tertiary)] backdrop-blur-md">
      <p className="font-mono text-sm font-semibold text-accent-primary">🧊 Built for the cubing community</p>
      <div className="mt-4 flex flex-wrap justify-center gap-6">
        {DETAIL_LINKS.map((link) => (
          <Link key={link.href} href={link.href} className="py-2 transition hover:text-[var(--text-primary)]">
            {link.label}
          </Link>
        ))}
      </div>
      <p className="mt-4">© {new Date().getFullYear()} Cubelelo Events. All rights reserved.</p>
    </footer>
  );
}
