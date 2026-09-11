import type { Metadata } from "next";
import { fetchForMetadata } from "@/lib/serverMeta";
import type { UserProfile } from "@/lib/api";
import ProfileClient from "./ProfileClient";

export async function generateMetadata({
  params,
}: {
  params: { clid: string };
}): Promise<Metadata> {
  const profile = await fetchForMetadata<UserProfile>(`/api/v1/users/${params.clid}`);
  if (!profile) {
    return { title: "Profile" };
  }

  const location = [profile.city, profile.country].filter(Boolean).join(", ");
  const title = `${profile.name} (${profile.clId})`;
  const description = [
    location && `${location}.`,
    profile.stats
      ? `${profile.stats.totalCompetitions} competition${profile.stats.totalCompetitions === 1 ? "" : "s"}, ${profile.stats.totalSolves} solves on Cubelelo Events.`
      : "Speedcubing competitor on Cubelelo Events.",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      images: profile.avatarUrl ? [profile.avatarUrl] : undefined,
    },
    twitter: {
      title,
      description,
      images: profile.avatarUrl ? [profile.avatarUrl] : undefined,
    },
  };
}

export default function ProfilePage() {
  return <ProfileClient />;
}
