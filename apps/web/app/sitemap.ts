import type { MetadataRoute } from "next";
import { fetchForMetadata } from "@/lib/serverMeta";
import type { CompetitionSummary } from "@/lib/api";

const SITE_URL = process.env.APP_URL ?? "http://localhost:3000";

const STATIC_ROUTES = [
  "",
  "/competitions",
  "/practice",
  "/rankings",
  "/login",
  "/register",
  "/pages/faqs",
  "/pages/about-us",
  "/pages/rules",
  "/pages/privacy-policy",
  "/pages/contact-us",
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticEntries: MetadataRoute.Sitemap = STATIC_ROUTES.map((path) => ({
    url: `${SITE_URL}${path}`,
    changeFrequency: path === "" || path === "/competitions" ? "hourly" : "weekly",
    priority: path === "" ? 1 : 0.6,
  }));

  // The public list endpoint already excludes drafts and cancelled/not-yet-open
  // competitions for an unauthenticated caller — exactly the set worth indexing.
  const comps = (await fetchForMetadata<CompetitionSummary[]>("/api/v1/competitions")) ?? [];

  const compEntries: MetadataRoute.Sitemap = comps.flatMap((c) => [
    {
      url: `${SITE_URL}/competitions/${c.id}`,
      lastModified: c.createdAt,
      changeFrequency: "daily" as const,
      priority: 0.8,
    },
    {
      url: `${SITE_URL}/competitions/${c.id}/results`,
      lastModified: c.createdAt,
      changeFrequency: "daily" as const,
      priority: 0.7,
    },
  ]);

  return [...staticEntries, ...compEntries];
}
