import { RouteGuard } from "@/features/auth/RouteGuard";
import { AdminShell } from "@/features/admin/AdminShell";
import { BodyClass } from "@/components/BodyClass";

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <RouteGuard role={["admin", "moderator", "judge"]}>
      <BodyClass className="no-bg" />
      <AdminShell>{children}</AdminShell>
    </RouteGuard>
  );
}
