"use client";

import { useEffect, useRef } from "react";
import Script from "next/script";
import { usePathname, useSearchParams } from "next/navigation";
import { GA_MEASUREMENT_ID, trackPageview } from "@/lib/analytics";

/**
 * Loads GA4 and fires a page_view on every navigation. Renders nothing when
 * NEXT_PUBLIC_GA_MEASUREMENT_ID isn't set (local dev, or until it's
 * configured) — same convention every other optional integration in this app
 * follows.
 *
 * gtag's own config already sends one page_view automatically on the script's
 * first load, but that's the only one it ever sends: App Router navigations
 * are client-side and never re-run the script, so every navigation after the
 * first needs an explicit page_view — hence the effect below rather than
 * relying on gtag's default.
 */
export function Analytics() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isFirstRender = useRef(true);

  useEffect(() => {
    if (isFirstRender.current) {
      // The initial load's page_view is the one gtag's config sends itself.
      isFirstRender.current = false;
      return;
    }
    const query = searchParams.toString();
    trackPageview(query ? `${pathname}?${query}` : pathname);
  }, [pathname, searchParams]);

  if (!GA_MEASUREMENT_ID) return null;

  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`}
        strategy="afterInteractive"
      />
      <Script id="ga4-init" strategy="afterInteractive">
        {`
          window.dataLayer = window.dataLayer || [];
          function gtag(){window.dataLayer.push(arguments);}
          window.gtag = gtag;
          gtag('js', new Date());
          gtag('config', '${GA_MEASUREMENT_ID}');
        `}
      </Script>
    </>
  );
}
