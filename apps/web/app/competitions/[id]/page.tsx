import type { Metadata } from "next";
import { fetchForMetadata, toPlainSummary } from "@/lib/serverMeta";
import type { CompetitionDetail } from "@/lib/api";
import CompetitionDetailClient from "./CompetitionDetailClient";

export async function generateMetadata({
  params,
}: {
  params: { id: string };
}): Promise<Metadata> {
  const comp = await fetchForMetadata<CompetitionDetail>(`/api/v1/competitions/${params.id}`);
  if (!comp) {
    return { title: "Competition" };
  }

  const description =
    toPlainSummary(comp.description) ??
    "Register, solve scrambles under timed conditions, and climb the rankings.";

  return {
    title: comp.title,
    description,
    openGraph: {
      title: comp.title,
      description,
      images: comp.bannerUrl ? [comp.bannerUrl] : undefined,
    },
    twitter: {
      title: comp.title,
      description,
      images: comp.bannerUrl ? [comp.bannerUrl] : undefined,
    },
  };
}

export default function CompetitionDetailPage() {
  return <CompetitionDetailClient />;
}
