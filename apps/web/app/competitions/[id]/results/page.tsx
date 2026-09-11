import type { Metadata } from "next";
import { fetchForMetadata } from "@/lib/serverMeta";
import type { CompetitionDetail } from "@/lib/api";
import ResultsClient from "./ResultsClient";

export async function generateMetadata({
  params,
}: {
  params: { id: string };
}): Promise<Metadata> {
  const comp = await fetchForMetadata<CompetitionDetail>(`/api/v1/competitions/${params.id}`);
  if (!comp) {
    return { title: "Results" };
  }

  const title = `${comp.title} — Results`;
  const description = `Final standings and rankings for ${comp.title} on Cubelelo Events.`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      images: comp.bannerUrl ? [comp.bannerUrl] : undefined,
    },
    twitter: {
      title,
      description,
      images: comp.bannerUrl ? [comp.bannerUrl] : undefined,
    },
  };
}

export default function ResultsPage() {
  return <ResultsClient />;
}
