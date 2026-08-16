import { registerWorker } from "./jobQueue";
import { emailService, bulkEmail, migrationEmail } from "./email";

/**
 * Background workers.
 *
 * A `generate-certificates` worker used to be registered here that logged a line
 * and did nothing — nothing ever enqueued it, and certificates are generated
 * synchronously in the admin route. It is gone rather than left implying that
 * asynchronous generation exists.
 */
export function registerJobs(): void {
  registerWorker("bulk-email", async (data) => {
    const { recipients, subject, bodyHtml } = data as {
      recipients: Array<{ email: string; name: string }>;
      subject: string;
      bodyHtml: string;
    };
    let sent = 0;
    for (const r of recipients) {
      const msg = bulkEmail(r.name, subject, bodyHtml);
      const ok = await emailService.send({ to: r.email, subject: msg.subject, html: msg.html });
      if (ok) sent++;
    }
    console.log(`📧 bulk-email: sent ${sent}/${recipients.length}`);
  });

  registerWorker("migration-email", async (data) => {
    const { stubs } = data as {
      stubs: Array<{ email: string; name: string; clId: string }>;
    };
    let sent = 0;
    for (const stub of stubs) {
      const msg = migrationEmail(stub.name, stub.clId);
      const ok = await emailService.send({ to: stub.email, subject: msg.subject, html: msg.html });
      if (ok) sent++;
    }
    console.log(`📧 migration-email: sent ${sent}/${stubs.length}`);
  });
}
