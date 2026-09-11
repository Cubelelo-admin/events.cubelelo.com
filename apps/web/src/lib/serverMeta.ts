/**
 * Server-only helpers for building per-page <Metadata>.
 *
 * Not part of `src/lib/api.ts` on purpose: that client hits `NEXT_PUBLIC_API_URL`
 * with relative paths, which only resolves inside the browser (or behind the
 * Next.js rewrite proxy in `next.config.mjs`). `generateMetadata` runs on the
 * server, where `fetch` needs an absolute URL — so this talks to the API
 * origin directly, the same way `next.config.mjs`'s rewrites do.
 */

const API_ORIGIN = process.env.API_URL ?? "http://localhost:4000";

/**
 * A best-effort GET against the API for metadata purposes only. Never throws —
 * a competition or profile that 404s, or an API that's briefly unreachable
 * during a build, should fall back to generic page metadata, not break the
 * page (or the build) entirely.
 */
export async function fetchForMetadata<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API_ORIGIN}${path}`, {
      // Metadata doesn't need to be second-fresh; avoid hammering the API
      // for every crawler hit on a popular competition page.
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Strips Markdown down to plain text, then clips to an OG/meta-description length. */
export function toPlainSummary(md: string | undefined | null, maxLen = 160): string | undefined {
  if (!md) return undefined;
  const plain = md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links -> label
    .replace(/[#*_`>~-]/g, "") // markdown punctuation
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return undefined;
  return plain.length > maxLen ? `${plain.slice(0, maxLen - 1).trimEnd()}…` : plain;
}
