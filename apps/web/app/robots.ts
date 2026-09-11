import type { MetadataRoute } from "next";

const SITE_URL = process.env.APP_URL ?? "http://localhost:3000";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Admin, judge and account-settings surfaces are auth-gated already —
      // keeping crawlers out of them too avoids indexing empty/login-walled
      // shells.
      disallow: ["/admin", "/judge", "/settings", "/profile/me", "/verify", "/verify-email", "/reset-password"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
