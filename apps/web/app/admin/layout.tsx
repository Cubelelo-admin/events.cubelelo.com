import { RouteGuard } from "@/features/auth/RouteGuard";
import { AdminShell } from "@/features/admin/AdminShell";
import { SidebarProvider } from "@/features/admin/SidebarContext";
import { BodyClass } from "@/components/BodyClass";

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <RouteGuard role={["admin", "moderator", "judge"]}>
      <BodyClass className="no-bg" />
      <SidebarProvider>
        <AdminShell>{children}</AdminShell>
      </SidebarProvider>
    </RouteGuard>
  );
}
