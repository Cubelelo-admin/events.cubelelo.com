/**
 * Thin GA4 wrapper. Every call is a no-op until NEXT_PUBLIC_GA_MEASUREMENT_ID
 * is set — same "optional, falls back quietly" shape as every other
 * integration in this app (Redis, Razorpay, Brevo, Supabase, ...). See
 * <Analytics /> (components/Analytics.tsx) for the script tag + automatic
 * page_view-on-navigation; this file is what the rest of the app calls to
 * track something that happened, not just a page load.
 */

export const GA_MEASUREMENT_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID ?? "";

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

function gtag(...args: unknown[]): void {
  if (typeof window === "undefined" || !window.gtag) return;
  window.gtag(...args);
}

/** Fires a GA4 page_view. <Analytics /> calls this on every client-side navigation. */
export function trackPageview(url: string): void {
  if (!GA_MEASUREMENT_ID) return;
  gtag("event", "page_view", { page_path: url });
}

/**
 * Fires a custom GA4 event — registration completed, a round published, a
 * click through to xskills.cubelelo.com or cubelelo.com, etc. Nothing in the
 * app calls this yet with real event names; it exists so the next feature
 * that wants to track something doesn't have to invent this wiring too.
 */
export function trackEvent(name: string, params?: Record<string, string | number | boolean>): void {
  if (!GA_MEASUREMENT_ID) return;
  gtag("event", name, params);
}

/**
 * Tracks a click that is about to leave the site — the shape the eventual
 * "learn this method on xskills" / "get this cube on cubelelo.com" links
 * (see the platform's cross-linking goals) will want, so that instrumentation
 * ships with the first outbound link rather than being bolted on after.
 */
export function trackOutboundClick(destination: "xskills" | "cubelelo" | string, context?: string): void {
  trackEvent("outbound_click", { destination, ...(context ? { context } : {}) });
}
