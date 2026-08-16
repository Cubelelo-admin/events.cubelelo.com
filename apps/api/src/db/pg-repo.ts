import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Repository } from "./repo";
import { withAdvisoryLock, withTransaction } from "./pool";
import { getRedis } from "../lib/redis";
import type {
  User,
  Competition,
  CompetitionEvent,
  Round,
  ScrambleSet,
  Result,
  Registration,
  Payment,
  AuditLogEntry,
  PersonalBest,
  PracticeSession,
  PracticeSolve,
  DailyChallenge,
  DailyChallengeResult,
  Announcement,
  RoundAdvancement,
  PromoCode,
  Appeal,
  WithdrawalRequest,
  RankTier,
  Banner,
  FaqEntry,
  ContentPage,
  JudgeAssignment,
  SystemSettings,
  RuleSet,
} from "./types";

// ── row → domain type mappers ──────────────────────────────────────────────

type Row = Record<string, unknown>;

function ts(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function toUser(r: Row): User {
  return {
    id: r.id as string,
    clId: r.cl_id as string,
    email: (r.email as string) ?? "",
    name: r.name as string,
    lastName: (r.last_name as string) ?? undefined,
    gender: (r.gender as string) ?? undefined,
    dob: r.dob ? ts(r.dob).slice(0, 10) : undefined,
    mobileNo: (r.mobile_no as string) ?? undefined,
    city: (r.city as string) ?? undefined,
    state: (r.state as string) ?? undefined,
    country: (r.country as string) ?? undefined,
    address: (r.address as string) ?? undefined,
    landmark: (r.landmark as string) ?? undefined,
    pincode: (r.pincode as string) ?? undefined,
    avatarUrl: (r.avatar_url as string) ?? undefined,
    instagram: (r.instagram as string) ?? undefined,
    wcaId: (r.wca_id as string) ?? undefined,
    wcaVerified: r.wca_verified as boolean,
    passwordHash: (r.password_hash as string) ?? undefined,
    emailVerified: (r.email_verified as boolean) ?? false,
    mobileVerified: (r.mobile_verified as boolean) ?? false,
    profilePrivacy: (r.profile_privacy as User["profilePrivacy"]) ?? "public",
    role: r.role as User["role"],
    accountStage: r.account_stage as User["accountStage"],
    supabaseId: (r.supabase_id as string) ?? undefined,
    createdAt: ts(r.created_at),
  };
}

function toComp(r: Row): Competition {
  return {
    id: r.id as string,
    title: r.title as string,
    type: r.type as Competition["type"],
    status: r.status as Competition["status"],
    description: (r.description as string) ?? undefined,
    rulesMd: (r.rules_md as string) ?? undefined,
    baseFee: r.base_fee as number,
    perEventFee: r.per_event_fee as number,
    registrationOpensAt: r.registration_opens_at ? ts(r.registration_opens_at) : undefined,
    registrationDeadline: r.registration_deadline ? ts(r.registration_deadline) : undefined,
    startsAt: r.starts_at ? ts(r.starts_at) : undefined,
    endsAt: r.ends_at ? ts(r.ends_at) : undefined,
    bannerUrl: (r.banner_url as string) ?? undefined,
    mobileBannerUrl: (r.mobile_banner_url as string) ?? undefined,
    featured: (r.featured as boolean) ?? false,
    featuredOrder: (r.featured_order as number) ?? undefined,
    cancellationReason: (r.cancellation_reason as string) ?? undefined,
    videoDeadlineMinutes: (r.video_deadline_minutes as number) ?? 1440,
    registrationLimit: (r.registration_limit as number) ?? undefined,
    ruleSetId: (r.rule_set_id as string) ?? undefined,
    createdBy: (r.created_by as string) ?? undefined,
    publishedBy: (r.published_by as string) ?? undefined,
    createdAt: ts(r.created_at),
  };
}

function toPB(r: Row): PersonalBest {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    eventType: r.event_type as string,
    bestSingleMs: (r.best_single_ms as number) ?? null,
    bestAo5Ms: (r.best_ao5_ms as number) ?? null,
    bestMeanMs: (r.best_mean_ms as number) ?? null,
    bestMedianMs: (r.best_median_ms as number) ?? null,
    bestRank: (r.best_rank as number) ?? null,
    updatedAt: ts(r.updated_at),
  };
}

function toEvent(r: Row): CompetitionEvent {
  return {
    id: r.id as string,
    competitionId: r.competition_id as string,
    eventType: r.event_type as string,
    roundCount: r.round_count as number,
    cutoffMs: (r.cutoff_ms as number) ?? undefined,
    timeLimitMs: (r.time_limit_ms as number) ?? undefined,
    fee: (r.fee as number) ?? undefined,
    archived: (r.archived as boolean) ?? false,
  };
}

function toPromo(r: Row): PromoCode {
  return {
    id: r.id as string, code: r.code as string,
    type: (r.type as PromoCode["type"]) ?? "general",
    discountType: r.discount_type as PromoCode["discountType"],
    discountValue: r.discount_value as number,
    maxUses: (r.max_uses as number) ?? 0,
    maxUsesPerUser: (r.max_uses_per_user as number) ?? 0,
    usedCount: r.used_count as number,
    competitionId: (r.competition_id as string) ?? undefined,
    competitionEventId: (r.competition_event_id as string) ?? undefined,
    validFrom: r.valid_from ? ts(r.valid_from) : undefined,
    validTo: r.valid_until ? ts(r.valid_until) : undefined,
    active: r.active as boolean, createdAt: ts(r.created_at),
  };
}

function toRound(r: Row): Round {
  return {
    id: r.id as string,
    competitionEventId: r.competition_event_id as string,
    roundNumber: r.round_number as number,
    status: r.status as Round["status"],
    format: (r.format as Round["format"]) ?? undefined,
    cutoffMs: (r.cutoff_ms as number) ?? undefined,
    timeLimitMs: (r.time_limit_ms as number) ?? undefined,
    advancementCount: (r.advancement_count as number) ?? undefined,
    advancementCriteria: r.advancement_criteria
      ? (typeof r.advancement_criteria === "string"
          ? JSON.parse(r.advancement_criteria)
          : r.advancement_criteria) as Round["advancementCriteria"]
      : undefined,
    opensAt: r.opens_at ? ts(r.opens_at) : undefined,
    closesAt: r.closes_at ? ts(r.closes_at) : undefined,
    durationMinutes: (r.duration_minutes as number) ?? undefined,
    resultsPublishedAt: r.results_published_at ? ts(r.results_published_at) : undefined,
    videoRequired: (r.video_required as boolean) ?? false,
  };
}

function toScrambleSet(r: Row): ScrambleSet {
  return {
    id: r.id as string,
    roundId: r.round_id as string,
    scrambles: r.scrambles_json as string[],
    generatedAt: ts(r.generated_at),
    lockedAt: r.locked_at ? ts(r.locked_at) : undefined,
    lockedBy: (r.locked_by as string) ?? undefined,
  };
}

function toResult(r: Row): Result {
  const rawReasons = r.flag_reasons;
  return {
    id: r.id as string,
    roundId: r.round_id as string,
    userId: r.user_id as string,
    solves: r.solves_json as Result["solves"],
    bestSingleMs: (r.best_single_ms as number) ?? null,
    ao5Ms: (r.ao5_ms as number) ?? null,
    meanMs: (r.mean_ms as number) ?? null,
    medianMs: (r.median_ms as number) ?? null,
    stdMs: (r.std_ms as number) ?? null,
    rank: (r.rank as number) ?? null,
    videoUrl: (r.video_url as string) ?? null,
    flagStatus: r.flag_status as Result["flagStatus"],
    flagReasons: (rawReasons
      ? (typeof rawReasons === "string" ? JSON.parse(rawReasons) : rawReasons)
      : []) as Result["flagReasons"],
    judgeOverrides: r.judge_overrides
      ? ((typeof r.judge_overrides === "string"
          ? JSON.parse(r.judge_overrides)
          : r.judge_overrides) as Result["judgeOverrides"])
      : undefined,
    verifiedBy: (r.verified_by as string) ?? undefined,
    verifiedAt: r.verified_at ? ts(r.verified_at) : undefined,
    verificationComment: (r.verification_comment as string) ?? undefined,
    submittedAt: ts(r.submitted_at),
  };
}

function toJudgeAssignment(r: Row): JudgeAssignment {
  return {
    id: r.id as string,
    judgeId: r.judge_id as string,
    roundId: r.round_id as string,
    assignedBy: r.assigned_by as string,
    assignedAt: ts(r.assigned_at),
  };
}

function toRegistration(r: Row): Registration {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    competitionId: r.competition_id as string,
    paymentStatus: r.payment_status as Registration["paymentStatus"],
    // Pre-045 rows read as undefined; they are all active by definition.
    status: (r.status as Registration["status"]) ?? "active",
    createdAt: ts(r.created_at),
  };
}

function toWithdrawalRequest(r: Row): WithdrawalRequest {
  return {
    id: r.id as string,
    registrationId: r.registration_id as string,
    userId: r.user_id as string,
    reason: r.reason as string,
    status: r.status as WithdrawalRequest["status"],
    adminResponse: (r.admin_response as string) ?? undefined,
    resolvedBy: (r.resolved_by as string) ?? undefined,
    createdAt: ts(r.created_at),
    resolvedAt: r.resolved_at ? ts(r.resolved_at) : undefined,
  };
}

function toPayment(r: Row): Payment {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    registrationId: (r.registration_id as string) ?? null,
    competitionId: (r.competition_id as string) ?? null,
    eventIds: (r.event_ids as string) ?? null,
    amount: r.amount as number,
    currency: r.currency as string,
    razorpayOrderId: (r.razorpay_order_id as string) ?? undefined,
    razorpayPaymentId: (r.razorpay_payment_id as string) ?? undefined,
    promoCodeId: (r.promo_code_id as string) ?? undefined,
    status: r.status as Payment["status"],
    createdAt: ts(r.created_at),
  };
}

function toAuditEntry(r: Row): AuditLogEntry {
  return {
    id: r.id as string,
    adminId: r.admin_id as string,
    action: r.action as string,
    target: (r.target as string) ?? undefined,
    reason: (r.reason as string) ?? undefined,
    oldValue: (r.old_value as string) ?? undefined,
    newValue: (r.new_value as string) ?? undefined,
    createdAt: ts(r.created_at),
  };
}

// ── dynamic SET-clause builder ─────────────────────────────────────────────

function buildSet(
  colMap: Record<string, string>,
  fields: Record<string, unknown>,
): { sets: string[]; vals: unknown[]; next: number } {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  for (const [key, col] of Object.entries(colMap)) {
    if (key in fields) {
      sets.push(`${col} = $${i++}`);
      vals.push(fields[key] ?? null);
    }
  }
  return { sets, vals, next: i };
}

// ── PostgreSQL Repository ──────────────────────────────────────────────────

export function createPgRepo(pool: InstanceType<typeof import("pg").Pool>): Repository {
  const roster = new Map<string, Map<string, string>>();

  return {
    // ── users ──────────────────────────────────────────────────────────────
    users: {
      async findAll(search) {
        if (search) {
          const q = `%${search}%`;
          const { rows } = await pool.query(
            "SELECT * FROM users WHERE name ILIKE $1 OR email ILIKE $1 OR cl_id ILIKE $1 ORDER BY created_at DESC",
            [q],
          );
          return rows.map(toUser);
        }
        const { rows } = await pool.query("SELECT * FROM users ORDER BY created_at DESC");
        return rows.map(toUser);
      },
      async findPaginated({ search, limit, offset }) {
        const params: unknown[] = [];
        let where = "";
        if (search) {
          params.push(`%${search}%`);
          where = `WHERE name ILIKE $1 OR email ILIKE $1 OR cl_id ILIKE $1`;
        }
        const countQ = await pool.query(`SELECT COUNT(*)::int AS total FROM users ${where}`, params);
        const total = countQ.rows[0]?.total ?? 0;
        const dataParams = [...params, limit, offset];
        const li = params.length + 1;
        const oi = params.length + 2;
        const { rows } = await pool.query(
          `SELECT * FROM users ${where} ORDER BY created_at DESC LIMIT $${li} OFFSET $${oi}`,
          dataParams,
        );
        return { rows: rows.map(toUser), total };
      },
      async findById(id) {
        const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
        return rows[0] ? toUser(rows[0]) : null;
      },
      async findByIds(ids) {
        const map = new Map<string, User>();
        if (ids.length === 0) return map;
        const placeholders = ids.map((_, i) => `$${i + 1}`).join(",");
        const { rows } = await pool.query(
          `SELECT * FROM users WHERE id IN (${placeholders})`,
          ids,
        );
        for (const r of rows) {
          const u = toUser(r);
          map.set(u.id, u);
        }
        return map;
      },
      async findByEmail(email) {
        const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
        return rows[0] ? toUser(rows[0]) : null;
      },
      async findByMobileNo(mobileNo) {
        const { rows } = await pool.query("SELECT * FROM users WHERE mobile_no = $1", [mobileNo]);
        return rows[0] ? toUser(rows[0]) : null;
      },
      async findByClId(clId) {
        const { rows } = await pool.query("SELECT * FROM users WHERE cl_id = $1", [clId]);
        return rows[0] ? toUser(rows[0]) : null;
      },
      async create(user) {
        await pool.query(
          `INSERT INTO users
             (id, cl_id, email, name, last_name, gender, dob, mobile_no, city, state,
              country, avatar_url, instagram, wca_id, wca_verified, role, account_stage,
              email_verified, mobile_verified, password_hash,
              created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21)`,
          [
            user.id, user.clId, user.email || null, user.name,
            user.lastName ?? null, user.gender ?? null, user.dob ?? null,
            user.mobileNo ?? null, user.city ?? null, user.state ?? null,
            user.country ?? null, user.avatarUrl ?? null, user.instagram ?? null,
            user.wcaId ?? null, user.wcaVerified, user.role, user.accountStage,
            user.emailVerified ?? false, user.mobileVerified ?? false, user.passwordHash ?? null,
            user.createdAt,
          ],
        );
      },
      async migrateId(oldId, newId) {
        // Store the Supabase UUID in supabase_id so Google logins resolve correctly.
        // We do NOT rename the PK because FK constraints don’t have ON UPDATE CASCADE.
        await pool.query("UPDATE users SET supabase_id = $1 WHERE id = $2", [newId, oldId]);
      },
      async findBySupabaseId(supabaseId) {
        const { rows } = await pool.query("SELECT * FROM users WHERE supabase_id = $1", [supabaseId]);
        return rows[0] ? toUser(rows[0]) : null;
      },
      async update(id, fields) {
        const COL: Record<string, string> = {
          name: "name", lastName: "last_name", gender: "gender", dob: "dob",
          email: "email", mobileNo: "mobile_no", city: "city", state: "state",
          country: "country", address: "address", landmark: "landmark", pincode: "pincode",
          avatarUrl: "avatar_url", instagram: "instagram", wcaId: "wca_id",
          wcaVerified: "wca_verified", role: "role", accountStage: "account_stage",
          emailVerified: "email_verified", mobileVerified: "mobile_verified",
          passwordHash: "password_hash", supabaseId: "supabase_id",
          profilePrivacy: "profile_privacy",
        };
        const { sets, vals, next } = buildSet(COL, fields as Record<string, unknown>);
        if (sets.length === 0) return this.findById(id);
        sets.push(`updated_at = $${next}`);
        vals.push(new Date().toISOString());
        vals.push(id);
        const { rows } = await pool.query(
          `UPDATE users SET ${sets.join(", ")} WHERE id = $${next + 1} RETURNING *`,
          vals,
        );
        return rows[0] ? toUser(rows[0]) : null;
      },
      async delete(id) {
        await pool.query("DELETE FROM users WHERE id = $1", [id]);
      },
      async nextClId() {
        const year = new Date().getFullYear();
        const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        for (let attempt = 0; attempt < 20; attempt++) {
          let code = "";
          for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
          const clId = `CL-${year}-${code}`;
          const { rows } = await pool.query("SELECT 1 FROM users WHERE cl_id = $1", [clId]);
          if (rows.length === 0) return clId;
        }
        throw new Error("Failed to generate unique CL ID after 20 attempts");
      },
    },

    // ── competitions ───────────────────────────────────────────────────────
    competitions: {
      async findAll(search) {
        if (search) {
          const q = `%${search}%`;
          const { rows } = await pool.query(
            "SELECT * FROM competitions WHERE title ILIKE $1 OR description ILIKE $1 ORDER BY created_at DESC",
            [q],
          );
          return rows.map(toComp);
        }
        const { rows } = await pool.query(
          "SELECT * FROM competitions ORDER BY created_at DESC",
        );
        return rows.map(toComp);
      },
      async findById(id) {
        const { rows } = await pool.query("SELECT * FROM competitions WHERE id = $1", [id]);
        return rows[0] ? toComp(rows[0]) : null;
      },
      async create(comp) {
        await pool.query(
          // video_deadline_minutes and featured_order were missing from this
          // column list while present in the UPDATE map below, so any value set
          // for them at create time was silently dropped.
          `INSERT INTO competitions
             (id, title, type, status, banner_url, mobile_banner_url, description, rules_md,
              base_fee, per_event_fee, registration_opens_at, registration_deadline,
              starts_at, ends_at, featured, featured_order, video_deadline_minutes,
              created_by, cancellation_reason, published_by,
              registration_limit, rule_set_id, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$23)`,
          [
            comp.id, comp.title, comp.type, comp.status,
            comp.bannerUrl ?? null, comp.mobileBannerUrl ?? null,
            comp.description ?? null, comp.rulesMd ?? null,
            comp.baseFee, comp.perEventFee,
            comp.registrationOpensAt ?? null, comp.registrationDeadline ?? null,
            comp.startsAt ?? null, comp.endsAt ?? null,
            comp.featured ?? false, comp.featuredOrder ?? null,
            comp.videoDeadlineMinutes ?? null,
            comp.createdBy ?? null,
            comp.cancellationReason ?? null, comp.publishedBy ?? null,
            comp.registrationLimit ?? null, comp.ruleSetId ?? null, comp.createdAt,
          ],
        );
      },
      async findByTitle(title) {
        const { rows } = await pool.query(
          "SELECT * FROM competitions WHERE lower(title) = lower($1) AND status <> 'cancelled' LIMIT 1",
          [title],
        );
        return rows[0] ? toComp(rows[0]) : null;
      },
      async findByIds(ids) {
        const map = new Map<string, Competition>();
        if (ids.length === 0) return map;
        const { rows } = await pool.query(
          "SELECT * FROM competitions WHERE id = ANY($1::uuid[])",
          [ids],
        );
        for (const r of rows) {
          const c = toComp(r);
          map.set(c.id, c);
        }
        return map;
      },
      async update(id, fields) {
        const COL: Record<string, string> = {
          title: "title", type: "type", status: "status", description: "description",
          rulesMd: "rules_md", baseFee: "base_fee", perEventFee: "per_event_fee",
          registrationOpensAt: "registration_opens_at",
          registrationDeadline: "registration_deadline",
          startsAt: "starts_at", endsAt: "ends_at",
          bannerUrl: "banner_url", mobileBannerUrl: "mobile_banner_url",
          featured: "featured", featuredOrder: "featured_order",
          cancellationReason: "cancellation_reason", videoDeadlineMinutes: "video_deadline_minutes",
          registrationLimit: "registration_limit", ruleSetId: "rule_set_id", publishedBy: "published_by",
        };
        const { sets, vals, next } = buildSet(COL, fields as Record<string, unknown>);
        if (sets.length === 0) return this.findById(id);
        sets.push(`updated_at = $${next}`);
        vals.push(new Date().toISOString());
        vals.push(id);
        const { rows } = await pool.query(
          `UPDATE competitions SET ${sets.join(", ")} WHERE id = $${next + 1} RETURNING *`,
          vals,
        );
        return rows[0] ? toComp(rows[0]) : null;
      },
      async delete(id) {
        await pool.query("DELETE FROM competitions WHERE id = $1", [id]);
      },
      async countRegistrations(compId) {
        const { rows } = await pool.query(
          "SELECT COUNT(*) AS cnt FROM registrations WHERE competition_id = $1",
          [compId],
        );
        return Number(rows[0].cnt);
      },
      async countRegistrationsBatch(ids) {
        if (ids.length === 0) return new Map();
        const placeholders = ids.map((_, i) => `$${i + 1}`).join(",");
        const { rows } = await pool.query(
          `SELECT competition_id, COUNT(*)::int AS cnt FROM registrations WHERE competition_id IN (${placeholders}) GROUP BY competition_id`,
          ids,
        );
        const map = new Map<string, number>();
        for (const id of ids) map.set(id, 0);
        for (const row of rows) map.set(row.competition_id, Number(row.cnt));
        return map;
      },
    },

    // ── competitionEvents ──────────────────────────────────────────────────
    competitionEvents: {
      async findById(id) {
        const { rows } = await pool.query(
          "SELECT * FROM competition_events WHERE id = $1",
          [id],
        );
        return rows[0] ? toEvent(rows[0]) : null;
      },
      async findByCompetition(compId) {
        const { rows } = await pool.query(
          "SELECT * FROM competition_events WHERE competition_id = $1 ORDER BY created_at",
          [compId],
        );
        return rows.map(toEvent);
      },
      async findByCompetitions(compIds) {
        if (compIds.length === 0) return new Map();
        const placeholders = compIds.map((_, i) => `$${i + 1}`).join(",");
        const { rows } = await pool.query(
          `SELECT * FROM competition_events WHERE competition_id IN (${placeholders}) ORDER BY created_at`,
          compIds,
        );
        const map = new Map<string, CompetitionEvent[]>();
        for (const id of compIds) map.set(id, []);
        for (const row of rows) {
          map.get(row.competition_id)!.push(toEvent(row));
        }
        return map;
      },
      async findByRound(roundId) {
        const { rows } = await pool.query(
          `SELECT ce.* FROM competition_events ce
           JOIN rounds r ON r.competition_event_id = ce.id
           WHERE r.id = $1`,
          [roundId],
        );
        return rows[0] ? toEvent(rows[0]) : null;
      },
      async findByRounds(roundIds) {
        if (roundIds.length === 0) return new Map();
        const placeholders = roundIds.map((_, i) => `$${i + 1}`).join(",");
        const { rows } = await pool.query(
          `SELECT ce.*, r.id AS _round_id FROM competition_events ce
           JOIN rounds r ON r.competition_event_id = ce.id
           WHERE r.id IN (${placeholders})`,
          roundIds,
        );
        const map = new Map<string, CompetitionEvent>();
        for (const row of rows) map.set(row._round_id, toEvent(row));
        return map;
      },
      async create(event) {
        await pool.query(
          `INSERT INTO competition_events
             (id, competition_id, event_type, round_count, cutoff_ms, time_limit_ms, fee)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            event.id, event.competitionId, event.eventType, event.roundCount,
            event.cutoffMs ?? null, event.timeLimitMs ?? null, event.fee ?? null,
          ],
        );
      },
      async update(id, fields) {
        const COL: Record<string, string> = {
          roundCount: "round_count", cutoffMs: "cutoff_ms", timeLimitMs: "time_limit_ms",
          fee: "fee", archived: "archived",
        };
        const { sets, vals, next } = buildSet(COL, fields as Record<string, unknown>);
        if (sets.length === 0) return this.findById(id);
        vals.push(id);
        const { rows } = await pool.query(
          `UPDATE competition_events SET ${sets.join(", ")} WHERE id = $${next} RETURNING *`, vals,
        );
        return rows[0] ? toEvent(rows[0]) : null;
      },
      async delete(id) {
        await pool.query("DELETE FROM competition_events WHERE id = $1", [id]);
      },
    },

    // ── rounds ─────────────────────────────────────────────────────────────
    rounds: {
      async findById(id) {
        const { rows } = await pool.query("SELECT * FROM rounds WHERE id = $1", [id]);
        return rows[0] ? toRound(rows[0]) : null;
      },
      async findAll() {
        const { rows } = await pool.query("SELECT * FROM rounds ORDER BY round_number");
        return rows.map(toRound);
      },
      async findActive() {
        const { rows } = await pool.query(
          "SELECT * FROM rounds WHERE status NOT IN ('advanced', 'cancelled') ORDER BY round_number",
        );
        return rows.map(toRound);
      },
      async findByCompetition(compId) {
        const { rows } = await pool.query(
          `SELECT r.* FROM rounds r
           JOIN competition_events ce ON ce.id = r.competition_event_id
           WHERE ce.competition_id = $1
           ORDER BY r.round_number`,
          [compId],
        );
        return rows.map(toRound);
      },
      async create(round) {
        await pool.query(
          `INSERT INTO rounds
             (id, competition_event_id, round_number, advancement_count, status, opens_at, closes_at, duration_minutes, advancement_criteria, video_required, format, cutoff_ms, time_limit_ms)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            round.id, round.competitionEventId, round.roundNumber,
            round.advancementCount ?? null, round.status,
            round.opensAt ?? null, round.closesAt ?? null,
            round.durationMinutes ?? null,
            round.advancementCriteria ? JSON.stringify(round.advancementCriteria) : null,
            round.videoRequired ?? false,
            round.format ?? "a",
            round.cutoffMs ?? null,
            round.timeLimitMs ?? null,
          ],
        );
      },
      async update(id, fields) {
        const COL: Record<string, string> = {
          status: "status", opensAt: "opens_at", closesAt: "closes_at",
          advancementCount: "advancement_count", durationMinutes: "duration_minutes",
          advancementCriteria: "advancement_criteria", resultsPublishedAt: "results_published_at",
          videoRequired: "video_required",
          format: "format", cutoffMs: "cutoff_ms", timeLimitMs: "time_limit_ms",
        };
        const raw = fields as Record<string, unknown>;
        if (raw.advancementCriteria !== undefined) {
          raw.advancementCriteria = raw.advancementCriteria ? JSON.stringify(raw.advancementCriteria) : null;
        }
        const { sets, vals, next } = buildSet(COL, raw);
        if (sets.length === 0) return this.findById(id);
        vals.push(id);
        const { rows } = await pool.query(
          `UPDATE rounds SET ${sets.join(", ")} WHERE id = $${next} RETURNING *`,
          vals,
        );
        return rows[0] ? toRound(rows[0]) : null;
      },
      async delete(id) {
        await pool.query("DELETE FROM rounds WHERE id = $1", [id]);
      },
      async compareAndUpdateStatus(id, expectedStatus, newStatus) {
        const { rowCount } = await pool.query(
          "UPDATE rounds SET status = $1 WHERE id = $2 AND status = $3",
          [newStatus, id, expectedStatus],
        );
        return (rowCount ?? 0) > 0;
      },
    },

    // ── scrambleSets ───────────────────────────────────────────────────────
    scrambleSets: {
      async findByRound(roundId) {
        const { rows } = await pool.query(
          "SELECT * FROM scramble_sets WHERE round_id = $1",
          [roundId],
        );
        return rows[0] ? toScrambleSet(rows[0]) : null;
      },
      async findByRounds(roundIds) {
        if (roundIds.length === 0) return new Map();
        const { rows } = await pool.query(
          `SELECT * FROM scramble_sets WHERE round_id = ANY($1)`,
          [roundIds],
        );
        const map = new Map<string, ScrambleSet>();
        for (const r of rows) {
          const s = toScrambleSet(r);
          map.set(s.roundId, s);
        }
        return map;
      },
      async upsert(set) {
        await pool.query(
          `INSERT INTO scramble_sets (id, round_id, scrambles_json, generated_at, locked_at, locked_by)
           VALUES ($1,$2,$3::jsonb,$4,$5,$6)
           ON CONFLICT (round_id) DO UPDATE SET
             scrambles_json = EXCLUDED.scrambles_json,
             generated_at   = EXCLUDED.generated_at,
             locked_at      = EXCLUDED.locked_at,
             locked_by      = EXCLUDED.locked_by`,
          [
            set.id, set.roundId, JSON.stringify(set.scrambles),
            set.generatedAt, set.lockedAt ?? null, set.lockedBy ?? null,
          ],
        );
      },
    },

    // ── results ────────────────────────────────────────────────────────────
    results: {
      async findById(id) {
        const { rows } = await pool.query("SELECT * FROM results WHERE id = $1", [id]);
        return rows[0] ? toResult(rows[0]) : null;
      },
      async findByRound(roundId) {
        const { rows } = await pool.query(
          "SELECT * FROM results WHERE round_id = $1",
          [roundId],
        );
        return rows.map(toResult);
      },
      async findByRoundSlim(roundId) {
        const { rows } = await pool.query(
          "SELECT id, user_id, ao5_ms, best_single_ms, rank, flag_status FROM results WHERE round_id = $1",
          [roundId],
        );
        return rows.map((r: Row) => ({
          id: r.id as string,
          userId: r.user_id as string,
          ao5Ms: (r.ao5_ms as number) ?? null,
          bestSingleMs: (r.best_single_ms as number) ?? null,
          rank: (r.rank as number) ?? null,
          flagStatus: r.flag_status as Result["flagStatus"],
        }));
      },
      async findByUser(userId) {
        const { rows } = await pool.query(
          "SELECT * FROM results WHERE user_id = $1 ORDER BY submitted_at",
          [userId],
        );
        return rows.map(toResult);
      },
      async findByRounds(roundIds) {
        if (roundIds.length === 0) return [];
        const { rows } = await pool.query(
          "SELECT * FROM results WHERE round_id = ANY($1::uuid[])",
          [roundIds],
        );
        return rows.map(toResult);
      },
      async countByUsers(userIds) {
        const map = new Map<string, number>();
        if (userIds.length === 0) return map;
        const { rows } = await pool.query(
          `SELECT user_id, COUNT(*) AS cnt FROM results
           WHERE user_id = ANY($1::uuid[]) GROUP BY user_id`,
          [userIds],
        );
        for (const r of rows) map.set(r.user_id, Number(r.cnt));
        return map;
      },
      async create(result) {
        await pool.query(
          `INSERT INTO results
             (id, round_id, user_id, solves_json, best_single_ms, ao5_ms, mean_ms,
              median_ms, std_ms, rank, video_url, flag_status, flag_reasons,
              verified_by, verified_at, submitted_at)
           VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16)`,
          [
            result.id, result.roundId, result.userId,
            JSON.stringify(result.solves),
            result.bestSingleMs, result.ao5Ms, result.meanMs,
            result.medianMs, result.stdMs, result.rank,
            result.videoUrl, result.flagStatus,
            JSON.stringify(result.flagReasons ?? []),
            result.verifiedBy ?? null, result.verifiedAt ?? null,
            result.submittedAt,
          ],
        );
      },
      async createIfAbsent(result) {
        // Advisory lock on the round serialises concurrent submissions, so the
        // duplicate check and the insert cannot interleave.
        return withAdvisoryLock(`round:${result.roundId}`, async (client) => {
          const { rows } = await client.query(
            "SELECT 1 FROM results WHERE round_id = $1 AND user_id = $2 LIMIT 1",
            [result.roundId, result.userId],
          );
          if (rows.length > 0) return false;

          await client.query(
            `INSERT INTO results
               (id, round_id, user_id, solves_json, best_single_ms, ao5_ms, mean_ms,
                median_ms, std_ms, rank, video_url, flag_status, flag_reasons,
                judge_overrides, verified_by, verified_at, submitted_at)
             VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16,$17)`,
            [
              result.id, result.roundId, result.userId,
              JSON.stringify(result.solves),
              result.bestSingleMs, result.ao5Ms, result.meanMs,
              result.medianMs, result.stdMs, result.rank,
              result.videoUrl, result.flagStatus,
              JSON.stringify(result.flagReasons ?? []),
              result.judgeOverrides ? JSON.stringify(result.judgeOverrides) : null,
              result.verifiedBy ?? null, result.verifiedAt ?? null,
              result.submittedAt,
            ],
          );
          return true;
        });
      },
      async update(id, fields) {
        const COL: Record<string, string> = {
          flagStatus: "flag_status", verifiedBy: "verified_by", verifiedAt: "verified_at",
          verificationComment: "verification_comment",
          rank: "rank", videoUrl: "video_url", userId: "user_id",
          bestSingleMs: "best_single_ms", ao5Ms: "ao5_ms",
          meanMs: "mean_ms", medianMs: "median_ms", stdMs: "std_ms",
          flagReasons: "flag_reasons", judgeOverrides: "judge_overrides",
        };
        // Serialise jsonb columns before passing to buildSet
        if (fields.flagReasons !== undefined) {
          (fields as Record<string, unknown>).flagReasons = JSON.stringify(fields.flagReasons);
        }
        if ("judgeOverrides" in fields) {
          const overrides = (fields as Record<string, unknown>).judgeOverrides;
          (fields as Record<string, unknown>).judgeOverrides =
            overrides === undefined || overrides === null ? null : JSON.stringify(overrides);
        }
        const { sets, vals, next } = buildSet(COL, fields as Record<string, unknown>);
        if (sets.length === 0) return this.findById(id);
        vals.push(id);
        const { rows } = await pool.query(
          `UPDATE results SET ${sets.join(", ")} WHERE id = $${next} RETURNING *`,
          vals,
        );
        return rows[0] ? toResult(rows[0]) : null;
      },
      async updateRanks(rankings) {
        if (rankings.length === 0) return;
        const ids = rankings.map((r) => r.id);
        const ranks = rankings.map((r) => (r.rank === null ? null : Math.trunc(r.rank)));
        await pool.query(
          `UPDATE results SET rank = u.rank
           FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::integer[]) AS rank) u
           WHERE results.id = u.id`,
          [ids, ranks],
        );
      },
    },

    // ── registrations ──────────────────────────────────────────────────────
    registrations: {
      async findById(id) {
        const { rows } = await pool.query("SELECT * FROM registrations WHERE id = $1", [id]);
        return rows[0] ? toRegistration(rows[0]) : null;
      },
      async findByIds(ids) {
        const map = new Map<string, Registration>();
        if (ids.length === 0) return map;
        const { rows } = await pool.query(
          "SELECT * FROM registrations WHERE id = ANY($1::uuid[])",
          [ids],
        );
        for (const r of rows) {
          const reg = toRegistration(r);
          map.set(reg.id, reg);
        }
        return map;
      },
      async findByUser(userId) {
        const { rows } = await pool.query(
          "SELECT * FROM registrations WHERE user_id = $1 ORDER BY created_at DESC",
          [userId],
        );
        return rows.map(toRegistration);
      },
      async findByCompetition(compId) {
        const { rows } = await pool.query(
          "SELECT * FROM registrations WHERE competition_id = $1",
          [compId],
        );
        return rows.map(toRegistration);
      },
      async findByUserAndComp(userId, compId) {
        const { rows } = await pool.query(
          "SELECT * FROM registrations WHERE user_id = $1 AND competition_id = $2",
          [userId, compId],
        );
        return rows[0] ? toRegistration(rows[0]) : null;
      },
      async create(reg) {
        await pool.query(
          `INSERT INTO registrations (id, user_id, competition_id, payment_status, status, created_at)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [reg.id, reg.userId, reg.competitionId, reg.paymentStatus, reg.status ?? "active", reg.createdAt],
        );
      },
      async update(id, fields) {
        const COL: Record<string, string> = { paymentStatus: "payment_status", userId: "user_id", status: "status" };
        const { sets, vals, next } = buildSet(COL, fields as Record<string, unknown>);
        if (sets.length === 0) return;
        vals.push(id);
        await pool.query(`UPDATE registrations SET ${sets.join(", ")} WHERE id = $${next}`, vals);
      },
      async delete(id) {
        await pool.query("DELETE FROM registration_events WHERE registration_id = $1", [id]);
        await pool.query("DELETE FROM registrations WHERE id = $1", [id]);
      },
      async addEvent(registrationId, competitionEventId) {
        await pool.query(
          `INSERT INTO registration_events (registration_id, competition_event_id)
           VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [registrationId, competitionEventId],
        );
      },
      async removeEvents(registrationId) {
        await pool.query("DELETE FROM registration_events WHERE registration_id = $1", [registrationId]);
      },
      async countEvents(registrationId) {
        const { rows } = await pool.query(
          "SELECT COUNT(*) AS cnt FROM registration_events WHERE registration_id = $1",
          [registrationId],
        );
        return Number(rows[0].cnt);
      },
      async findEvents(registrationId) {
        const { rows } = await pool.query(
          `SELECT ce.* FROM competition_events ce
           JOIN registration_events re ON re.competition_event_id = ce.id
           WHERE re.registration_id = $1`,
          [registrationId],
        );
        return rows.map(toEvent);
      },
      async findEventsForAll(registrationIds) {
        const map = new Map<string, CompetitionEvent[]>();
        if (registrationIds.length === 0) return map;
        const { rows } = await pool.query(
          `SELECT re.registration_id, ce.* FROM competition_events ce
           JOIN registration_events re ON re.competition_event_id = ce.id
           WHERE re.registration_id = ANY($1::uuid[])`,
          [registrationIds],
        );
        for (const r of rows) {
          const list = map.get(r.registration_id) ?? [];
          list.push(toEvent(r));
          map.set(r.registration_id, list);
        }
        return map;
      },
      // The `status = 'active'` filter below is `isActiveRegistration`
      // (lib/registrationStatus.ts) expressed in SQL, so the check can run inside
      // the query. Keep the two in step — mem-repo carries the same note.
      async isRegisteredForEvent(userId: string, competitionEventId: string) {
        const { rows } = await pool.query(
          `SELECT 1 FROM registrations r
           JOIN registration_events re ON re.registration_id = r.id
           WHERE r.user_id = $1 AND re.competition_event_id = $2
             AND r.status = 'active'
           LIMIT 1`,
          [userId, competitionEventId],
        );
        return rows.length > 0;
      },
    },

    // ── payments ───────────────────────────────────────────────────────────
    payments: {
      async hasCompletedPayment(userId: string) {
        const { rows } = await pool.query(
          "SELECT 1 FROM payments WHERE user_id = $1 AND status = 'paid' LIMIT 1",
          [userId],
        );
        return rows.length > 0;
      },
      async findAll() {
        const { rows } = await pool.query("SELECT * FROM payments ORDER BY created_at DESC");
        return rows.map(toPayment);
      },
      async findById(id) {
        const { rows } = await pool.query("SELECT * FROM payments WHERE id = $1", [id]);
        return rows[0] ? toPayment(rows[0]) : null;
      },
      async findByOrderId(orderId) {
        const { rows } = await pool.query(
          "SELECT * FROM payments WHERE razorpay_order_id = $1",
          [orderId],
        );
        return rows[0] ? toPayment(rows[0]) : null;
      },
      async findByRegistration(registrationId) {
        const { rows } = await pool.query(
          "SELECT * FROM payments WHERE registration_id = $1 AND status = 'pending' LIMIT 1",
          [registrationId],
        );
        return rows[0] ? toPayment(rows[0]) : null;
      },
      async findPendingByUserAndComp(userId, competitionId) {
        const { rows } = await pool.query(
          "SELECT * FROM payments WHERE user_id = $1 AND competition_id = $2 AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
          [userId, competitionId],
        );
        return rows[0] ? toPayment(rows[0]) : null;
      },
      async findByRegistrationIds(registrationIds) {
        const map = new Map<string, Payment>();
        if (registrationIds.length === 0) return map;
        const { rows } = await pool.query(
          `SELECT DISTINCT ON (registration_id) *
           FROM payments
           WHERE registration_id = ANY($1::uuid[])
           ORDER BY registration_id, created_at DESC`,
          [registrationIds],
        );
        for (const r of rows) {
          const p = toPayment(r);
          if (p.registrationId) map.set(p.registrationId, p);
        }
        return map;
      },
      async create(payment) {
        await pool.query(
          `INSERT INTO payments
             (id, user_id, registration_id, competition_id, event_ids, amount, currency,
              razorpay_order_id, razorpay_payment_id, promo_code_id, status, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
          [
            payment.id, payment.userId, payment.registrationId ?? null,
            payment.competitionId ?? null, payment.eventIds ?? null,
            payment.amount, payment.currency,
            payment.razorpayOrderId ?? null, payment.razorpayPaymentId ?? null,
            payment.promoCodeId ?? null,
            payment.status, payment.createdAt,
          ],
        );
      },
      async update(id, fields) {
        const COL: Record<string, string> = {
          razorpayPaymentId: "razorpay_payment_id",
          registrationId: "registration_id",
          status: "status",
          userId: "user_id",
        };
        const { sets, vals, next } = buildSet(COL, fields as Record<string, unknown>);
        if (sets.length === 0) return;
        sets.push(`updated_at = $${next}`);
        vals.push(new Date().toISOString());
        vals.push(id);
        await pool.query(
          `UPDATE payments SET ${sets.join(", ")} WHERE id = $${next + 1}`,
          vals,
        );
      },
    },

    // ── auditLog ───────────────────────────────────────────────────────────
    auditLog: {
      async findAll(limit = 100, offset = 0) {
        const { rows } = await pool.query(
          "SELECT * FROM audit_log ORDER BY created_at DESC LIMIT $1 OFFSET $2",
          [limit, offset],
        );
        return rows.map(toAuditEntry);
      },
      async findByAdmin(adminId: string) {
        const { rows } = await pool.query(
          "SELECT * FROM audit_log WHERE admin_id = $1 ORDER BY created_at DESC LIMIT 200",
          [adminId],
        );
        return rows.map(toAuditEntry);
      },
      async findByTarget(target: string) {
        const { rows } = await pool.query(
          "SELECT * FROM audit_log WHERE target = $1 ORDER BY created_at DESC",
          [target],
        );
        return rows.map(toAuditEntry);
      },
      async create(entry: AuditLogEntry) {
        await pool.query(
          `INSERT INTO audit_log (id, admin_id, action, target, reason, old_value, new_value, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            entry.id, entry.adminId ?? null, entry.action,
            entry.target ?? null, entry.reason ?? null,
            entry.oldValue ?? null, entry.newValue ?? null,
            entry.createdAt,
          ],
        );
      },
    },

    // ── verification tokens ───────────────────────────────────────────────
    verificationTokens: {
      async create(t) {
        await pool.query(
          `INSERT INTO verification_tokens (id, user_id, type, token, identifier, expires_at)
           VALUES ($1,$2,$3,$4,$5, to_timestamp($6 / 1000.0))`,
          [t.id, t.userId, t.type, t.token, t.identifier ?? null, t.expiresAt],
        );
      },
      async findByToken(token, type) {
        const { rows } = await pool.query(
          "SELECT * FROM verification_tokens WHERE token = $1 AND type = $2 LIMIT 1",
          [token, type],
        );
        if (!rows[0]) return null;
        const r = rows[0] as Row;
        return { id: r.id as string, userId: r.user_id as string, type: r.type as string, token: r.token as string, identifier: (r.identifier as string) ?? undefined, expiresAt: new Date(r.expires_at as string).getTime() };
      },
      async findByIdentifier(identifier, type) {
        const { rows } = await pool.query(
          "SELECT * FROM verification_tokens WHERE identifier = $1 AND type = $2 ORDER BY expires_at DESC LIMIT 1",
          [identifier, type],
        );
        if (!rows[0]) return null;
        const r = rows[0] as Row;
        return { id: r.id as string, userId: r.user_id as string, type: r.type as string, token: r.token as string, identifier: (r.identifier as string) ?? undefined, expiresAt: new Date(r.expires_at as string).getTime() };
      },
      async delete(id) {
        await pool.query("DELETE FROM verification_tokens WHERE id = $1", [id]);
      },
      async deleteExpired() {
        await pool.query("DELETE FROM verification_tokens WHERE expires_at < now()");
      },
    },

    // ── announcements ──────────────────────────────────────────────────────
    announcements: {
      async findAll(publishedOnly) {
        const { rows } = await pool.query(
          publishedOnly
            ? "SELECT * FROM announcements WHERE published = true ORDER BY pinned DESC, created_at DESC"
            : "SELECT * FROM announcements ORDER BY pinned DESC, created_at DESC",
        );
        return rows.map((r: Row): Announcement => ({
          id: r.id as string, title: r.title as string, bodyMd: r.body_md as string,
          imageUrl: (r.image_url as string) ?? undefined,
          redirectUrl: (r.redirect_url as string) ?? undefined,
          pinned: r.pinned as boolean, published: r.published as boolean,
          createdBy: (r.created_by as string) ?? undefined,
          createdAt: ts(r.created_at), updatedAt: ts(r.updated_at),
        }));
      },
      async findById(id) {
        const { rows } = await pool.query("SELECT * FROM announcements WHERE id = $1", [id]);
        if (!rows[0]) return null;
        const r = rows[0] as Row;
        return {
          id: r.id as string, title: r.title as string, bodyMd: r.body_md as string,
          imageUrl: (r.image_url as string) ?? undefined,
          redirectUrl: (r.redirect_url as string) ?? undefined,
          pinned: r.pinned as boolean, published: r.published as boolean,
          createdBy: (r.created_by as string) ?? undefined,
          createdAt: ts(r.created_at), updatedAt: ts(r.updated_at),
        };
      },
      async create(a) {
        await pool.query(
          `INSERT INTO announcements (id, title, body_md, image_url, redirect_url, pinned, published, created_by, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
          [a.id, a.title, a.bodyMd, a.imageUrl ?? null, a.redirectUrl ?? null, a.pinned, a.published, a.createdBy ?? null, a.createdAt],
        );
      },
      async update(id, fields) {
        const COL: Record<string, string> = {
          title: "title", bodyMd: "body_md", imageUrl: "image_url", redirectUrl: "redirect_url", pinned: "pinned", published: "published",
        };
        const { sets, vals, next } = buildSet(COL, fields as Record<string, unknown>);
        if (sets.length === 0) return this.findById(id);
        sets.push(`updated_at = now()`);
        vals.push(id);
        const { rows } = await pool.query(
          `UPDATE announcements SET ${sets.join(", ")} WHERE id = $${next} RETURNING *`,
          vals,
        );
        if (!rows[0]) return null;
        const r = rows[0] as Row;
        return {
          id: r.id as string, title: r.title as string, bodyMd: r.body_md as string,
          imageUrl: (r.image_url as string) ?? undefined,
          redirectUrl: (r.redirect_url as string) ?? undefined,
          pinned: r.pinned as boolean, published: r.published as boolean,
          createdBy: (r.created_by as string) ?? undefined,
          createdAt: ts(r.created_at), updatedAt: ts(r.updated_at),
        };
      },
      async delete(id) {
        await pool.query("DELETE FROM announcements WHERE id = $1", [id]);
      },
    },

    // ── advancements ───────────────────────────────────────────────────────
    advancements: {
      // Replaces the round's list wholesale, including with nothing: an empty
      // save clears it. Returning early on empty left the stale list in place
      // here while mem-repo cleared it, so a re-shortlist that disqualified
      // everyone left the old advancers still admitted to the next round.
      async save(roundId, entries) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("DELETE FROM round_advancements WHERE round_id = $1", [roundId]);
          for (const e of entries) {
            await client.query(
              "INSERT INTO round_advancements (round_id, user_id, rank) VALUES ($1,$2,$3)",
              [e.roundId, e.userId, e.rank],
            );
          }
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }
      },
      async isAdvanced(destRoundId, userId) {
        const redis = await getRedis();
        if (redis) {
          const cached = await redis.sismember(`adv:${destRoundId}`, userId);
          if (cached) return true;
          const exists = await redis.exists(`adv:${destRoundId}`);
          if (exists) return false;
        }
        const { rows } = await pool.query(
          `SELECT 1 FROM round_advancements ra
           JOIN rounds src ON ra.round_id = src.id
           JOIN rounds dst ON dst.competition_event_id = src.competition_event_id
             AND dst.round_number = src.round_number + 1
           WHERE dst.id = $1 AND ra.user_id = $2
           LIMIT 1`,
          [destRoundId, userId],
        );
        return rows.length > 0;
      },
      async findByRound(roundId) {
        const { rows } = await pool.query(
          "SELECT * FROM round_advancements WHERE round_id = $1 ORDER BY rank",
          [roundId],
        );
        return rows.map((r: Row): RoundAdvancement => ({
          roundId: r.round_id as string,
          userId: r.user_id as string,
          rank: r.rank as number,
        }));
      },
      async findByRounds(roundIds) {
        if (roundIds.length === 0) return new Map();
        const { rows } = await pool.query(
          "SELECT * FROM round_advancements WHERE round_id = ANY($1) ORDER BY rank",
          [roundIds],
        );
        const map = new Map<string, RoundAdvancement[]>();
        for (const r of rows) {
          const adv: RoundAdvancement = {
            roundId: r.round_id as string,
            userId: r.user_id as string,
            rank: r.rank as number,
          };
          const list = map.get(adv.roundId);
          if (list) list.push(adv);
          else map.set(adv.roundId, [adv]);
        }
        return map;
      },
    },

    // ── personalBests ──────────────────────────────────────────────────────
    personalBests: {
      async findAll() {
        const { rows } = await pool.query("SELECT * FROM personal_bests");
        return rows.map(toPB);
      },
      async findByUser(userId) {
        const { rows } = await pool.query(
          "SELECT * FROM personal_bests WHERE user_id = $1",
          [userId],
        );
        return rows.map(toPB);
      },
      async findRanked(eventType, limit, offset) {
        const { rows } = await pool.query(
          `SELECT *, COUNT(*) OVER() AS total_count FROM personal_bests
           WHERE (best_ao5_ms IS NOT NULL OR best_single_ms IS NOT NULL)
             AND ($1::text IS NULL OR event_type = $1)
           ORDER BY COALESCE(best_ao5_ms, best_single_ms) ASC
           LIMIT $2 OFFSET $3`,
          [eventType ?? null, limit, offset],
        );
        if (rows.length > 0) {
          return { rows: rows.map(toPB), total: Number(rows[0].total_count) };
        }
        // Page past the end — still report the true total
        const { rows: count } = await pool.query(
          `SELECT COUNT(*) AS cnt FROM personal_bests
           WHERE (best_ao5_ms IS NOT NULL OR best_single_ms IS NOT NULL)
             AND ($1::text IS NULL OR event_type = $1)`,
          [eventType ?? null],
        );
        return { rows: [], total: Number(count[0].cnt) };
      },
      async upsert(pb) {
        await pool.query(
          `INSERT INTO personal_bests
             (id, user_id, event_type, best_single_ms, best_ao5_ms, best_mean_ms,
              best_median_ms, best_rank, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
           ON CONFLICT (user_id, event_type) DO UPDATE SET
             best_single_ms = LEAST(EXCLUDED.best_single_ms, personal_bests.best_single_ms),
             best_ao5_ms    = LEAST(EXCLUDED.best_ao5_ms,    personal_bests.best_ao5_ms),
             best_mean_ms   = LEAST(EXCLUDED.best_mean_ms,   personal_bests.best_mean_ms),
             best_median_ms = LEAST(EXCLUDED.best_median_ms, personal_bests.best_median_ms),
             best_rank      = LEAST(EXCLUDED.best_rank,      personal_bests.best_rank),
             updated_at     = now()`,
          [
            pb.id, pb.userId, pb.eventType,
            pb.bestSingleMs, pb.bestAo5Ms, pb.bestMeanMs,
            pb.bestMedianMs, pb.bestRank,
          ],
        );
      },
      async replace(pb) {
        await pool.query(
          `INSERT INTO personal_bests
             (id, user_id, event_type, best_single_ms, best_ao5_ms, best_mean_ms,
              best_median_ms, best_rank, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
           ON CONFLICT (user_id, event_type) DO UPDATE SET
             best_single_ms = EXCLUDED.best_single_ms,
             best_ao5_ms    = EXCLUDED.best_ao5_ms,
             best_mean_ms   = EXCLUDED.best_mean_ms,
             best_median_ms = EXCLUDED.best_median_ms,
             best_rank      = EXCLUDED.best_rank,
             updated_at     = now()`,
          [
            pb.id, pb.userId, pb.eventType,
            pb.bestSingleMs, pb.bestAo5Ms, pb.bestMeanMs,
            pb.bestMedianMs, pb.bestRank,
          ],
        );
      },
    },

    // ── practice ───────────────────────────────────────────────────────────
    practice: {
      async createSession(session) {
        await pool.query(
          `INSERT INTO practice_sessions (id, user_id, event_type, name, created_at)
           VALUES ($1,$2,$3,$4,$5)`,
          [session.id, session.userId, session.eventType, session.name ?? null, session.createdAt],
        );
      },
      async findSession(id) {
        const { rows } = await pool.query("SELECT * FROM practice_sessions WHERE id = $1", [id]);
        if (!rows[0]) return null;
        const r = rows[0] as Row;
        return {
          id: r.id as string, userId: r.user_id as string,
          eventType: r.event_type as string, name: (r.name as string) ?? undefined,
          createdAt: ts(r.created_at), endedAt: r.ended_at ? ts(r.ended_at) : undefined,
        } satisfies PracticeSession;
      },
      async findSessionsByUser(userId) {
        const { rows } = await pool.query(
          "SELECT * FROM practice_sessions WHERE user_id = $1 ORDER BY created_at DESC",
          [userId],
        );
        return rows.map((r: Row): PracticeSession => ({
          id: r.id as string, userId: r.user_id as string,
          eventType: r.event_type as string, name: (r.name as string) ?? undefined,
          createdAt: ts(r.created_at), endedAt: r.ended_at ? ts(r.ended_at) : undefined,
        }));
      },
      async updateSession(id, fields) {
        const sets: string[] = [];
        const vals: unknown[] = [];
        let i = 1;
        if (fields.name !== undefined) { sets.push(`name = $${i++}`); vals.push(fields.name); }
        if (fields.eventType !== undefined) { sets.push(`event_type = $${i++}`); vals.push(fields.eventType); }
        if (sets.length === 0) return this.findSession(id);
        vals.push(id);
        await pool.query(`UPDATE practice_sessions SET ${sets.join(", ")} WHERE id = $${i}`, vals);
        return this.findSession(id);
      },
      async deleteSession(id) {
        await pool.query("DELETE FROM practice_solves WHERE session_id = $1", [id]);
        await pool.query("DELETE FROM practice_sessions WHERE id = $1", [id]);
      },
      async endSession(id) {
        await pool.query(
          "UPDATE practice_sessions SET ended_at = now() WHERE id = $1", [id],
        );
      },
      async addSolve(solve) {
        await pool.query(
          `INSERT INTO practice_solves (id, session_id, time_ms, scramble, penalty, note, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            solve.id, solve.sessionId, solve.timeMs, solve.scramble,
            solve.penalty, solve.note ?? null, solve.createdAt,
          ],
        );
      },
      async findSolve(id) {
        const { rows } = await pool.query("SELECT * FROM practice_solves WHERE id = $1", [id]);
        if (!rows[0]) return null;
        const r: Row = rows[0];
        return {
          id: r.id as string, sessionId: r.session_id as string,
          timeMs: r.time_ms as number, scramble: r.scramble as string,
          penalty: r.penalty as PracticeSolve["penalty"],
          note: (r.note as string) ?? undefined, createdAt: ts(r.created_at),
        };
      },
      async findSolvesBySession(sessionId) {
        const { rows } = await pool.query(
          "SELECT * FROM practice_solves WHERE session_id = $1 ORDER BY created_at",
          [sessionId],
        );
        return rows.map((r: Row): PracticeSolve => ({
          id: r.id as string, sessionId: r.session_id as string,
          timeMs: r.time_ms as number, scramble: r.scramble as string,
          penalty: r.penalty as PracticeSolve["penalty"],
          note: (r.note as string) ?? undefined, createdAt: ts(r.created_at),
        }));
      },
      async findSolvesBySessionIds(sessionIds) {
        if (sessionIds.length === 0) return [];
        const placeholders = sessionIds.map((_, i) => `$${i + 1}`).join(", ");
        const { rows } = await pool.query(
          `SELECT * FROM practice_solves WHERE session_id IN (${placeholders}) ORDER BY created_at`,
          sessionIds,
        );
        return rows.map((r: Row): PracticeSolve => ({
          id: r.id as string, sessionId: r.session_id as string,
          timeMs: r.time_ms as number, scramble: r.scramble as string,
          penalty: r.penalty as PracticeSolve["penalty"],
          note: (r.note as string) ?? undefined, createdAt: ts(r.created_at),
        }));
      },
      async deleteSolve(id) {
        await pool.query("DELETE FROM practice_solves WHERE id = $1", [id]);
      },
    },

    // ── dailyChallenge ─────────────────────────────────────────────────────
    dailyChallenge: {
      async findByDate(date) {
        const { rows } = await pool.query(
          "SELECT * FROM daily_challenges WHERE date = $1", [date],
        );
        if (!rows[0]) return null;
        const r = rows[0] as Row;
        return {
          id: r.id as string, date: ts(r.date).slice(0, 10),
          eventType: r.event_type as string, scramble: r.scramble as string,
          createdAt: ts(r.created_at),
        } satisfies DailyChallenge;
      },
      async create(challenge) {
        await pool.query(
          `INSERT INTO daily_challenges (id, date, event_type, scramble, created_at)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (date) DO NOTHING`,
          [challenge.id, challenge.date, challenge.eventType, challenge.scramble, challenge.createdAt],
        );
      },
      async submitResult(result) {
        await pool.query(
          `INSERT INTO daily_challenge_results (id, challenge_id, user_id, time_ms, penalty, submitted_at)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [result.id, result.challengeId, result.userId, result.timeMs, result.penalty ?? "none", result.submittedAt],
        );
      },
      async findResultByUserAndChallenge(userId, challengeId) {
        const { rows } = await pool.query(
          "SELECT * FROM daily_challenge_results WHERE user_id = $1 AND challenge_id = $2",
          [userId, challengeId],
        );
        if (!rows[0]) return null;
        const r = rows[0] as Row;
        return {
          id: r.id as string, challengeId: r.challenge_id as string,
          userId: r.user_id as string, timeMs: r.time_ms as number,
          penalty: (r.penalty as DailyChallengeResult["penalty"]) ?? "none",
          submittedAt: ts(r.submitted_at),
        } satisfies DailyChallengeResult;
      },
      async findResultsByChallenge(challengeId) {
        const { rows } = await pool.query(
          `SELECT dcr.*, u.cl_id, u.name FROM daily_challenge_results dcr
           JOIN users u ON u.id = dcr.user_id
           WHERE dcr.challenge_id = $1 ORDER BY dcr.time_ms`,
          [challengeId],
        );
        return rows.map((r: Row): DailyChallengeResult & { clId: string; name: string } => ({
          id: r.id as string, challengeId: r.challenge_id as string,
          userId: r.user_id as string, timeMs: r.time_ms as number,
          penalty: (r.penalty as DailyChallengeResult["penalty"]) ?? "none",
          submittedAt: ts(r.submitted_at),
          clId: r.cl_id as string, name: r.name as string,
        }));
      },
      async findUserStreak(userId) {
        const { rows } = await pool.query(
          `SELECT DISTINCT dc.date FROM daily_challenge_results dcr
           JOIN daily_challenges dc ON dc.id = dcr.challenge_id
           WHERE dcr.user_id = $1 ORDER BY dc.date DESC`,
          [userId],
        );
        if (rows.length === 0) return 0;
        const dates = (rows as Row[]).map((r) => ts(r.date).slice(0, 10));
        let streak = 0;
        const d = new Date();
        const MAX_LOOKBACK = 365;
        for (let i = 0; i < MAX_LOOKBACK; i++) {
          const dateStr = d.toISOString().slice(0, 10);
          if (dates.includes(dateStr)) {
            streak++;
            d.setDate(d.getDate() - 1);
          } else if (streak === 0) {
            d.setDate(d.getDate() - 1);
            if (!dates.includes(d.toISOString().slice(0, 10))) break;
          } else {
            break;
          }
        }
        return streak;
      },
    },

    // ── appeals ────────────────────────────────────────────────────────────
    appeals: {
      async findAll() {
        const { rows } = await pool.query("SELECT * FROM appeals ORDER BY created_at DESC");
        return rows.map((r: Row): Appeal => ({
          id: r.id as string, resultId: r.result_id as string, userId: r.user_id as string,
          reason: r.reason as string, status: r.status as Appeal["status"],
          adminResponse: (r.admin_response as string) ?? undefined,
          createdAt: ts(r.created_at), resolvedAt: r.resolved_at ? ts(r.resolved_at) : undefined,
        }));
      },
      async findById(id: string) {
        const { rows } = await pool.query("SELECT * FROM appeals WHERE id = $1", [id]);
        if (!rows[0]) return null;
        const r = rows[0] as Row;
        return { id: r.id as string, resultId: r.result_id as string, userId: r.user_id as string,
          reason: r.reason as string, status: r.status as Appeal["status"],
          adminResponse: (r.admin_response as string) ?? undefined,
          createdAt: ts(r.created_at), resolvedAt: r.resolved_at ? ts(r.resolved_at) : undefined };
      },
      async findByResult(resultId: string) {
        const { rows } = await pool.query("SELECT * FROM appeals WHERE result_id = $1", [resultId]);
        if (!rows[0]) return null;
        const r = rows[0] as Row;
        return { id: r.id as string, resultId: r.result_id as string, userId: r.user_id as string,
          reason: r.reason as string, status: r.status as Appeal["status"],
          adminResponse: (r.admin_response as string) ?? undefined,
          createdAt: ts(r.created_at), resolvedAt: r.resolved_at ? ts(r.resolved_at) : undefined };
      },
      async findByUser(userId: string) {
        const { rows } = await pool.query("SELECT * FROM appeals WHERE user_id = $1 ORDER BY created_at DESC", [userId]);
        return rows.map((r: Row): Appeal => ({
          id: r.id as string, resultId: r.result_id as string, userId: r.user_id as string,
          reason: r.reason as string, status: r.status as Appeal["status"],
          adminResponse: (r.admin_response as string) ?? undefined,
          createdAt: ts(r.created_at), resolvedAt: r.resolved_at ? ts(r.resolved_at) : undefined,
        }));
      },
      async create(appeal: Appeal) {
        await pool.query(
          `INSERT INTO appeals (id, result_id, user_id, reason, status, admin_response, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [appeal.id, appeal.resultId, appeal.userId, appeal.reason, appeal.status, appeal.adminResponse ?? null, appeal.createdAt],
        );
      },
      async update(id: string, fields: Partial<Appeal>) {
        const COL: Record<string, string> = { status: "status", adminResponse: "admin_response", resolvedBy: "resolved_by" };
        const { sets, vals, next } = buildSet(COL, fields as Record<string, unknown>);
        if (sets.length === 0) return this.findById(id);
        let idx = next;
        sets.push(`updated_at = $${idx}`);
        vals.push(new Date().toISOString());
        idx++;
        if (fields.status === "accepted" || fields.status === "rejected") {
          sets.push(`resolved_at = $${idx}`);
          vals.push(new Date().toISOString());
          idx++;
        }
        vals.push(id);
        const { rows } = await pool.query(
          `UPDATE appeals SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`, vals,
        );
        if (!rows[0]) return null;
        const r = rows[0] as Row;
        return { id: r.id as string, resultId: r.result_id as string, userId: r.user_id as string,
          reason: r.reason as string, status: r.status as Appeal["status"],
          adminResponse: (r.admin_response as string) ?? undefined,
          resolvedBy: (r.resolved_by as string) ?? undefined,
          createdAt: ts(r.created_at), resolvedAt: r.resolved_at ? ts(r.resolved_at) : undefined };
      },
    },

    // ── rank tiers ────────────────────────────────────────────────────────
    withdrawalRequests: {
      async findAll() {
        const { rows } = await pool.query(
          "SELECT * FROM withdrawal_requests ORDER BY created_at DESC",
        );
        return rows.map(toWithdrawalRequest);
      },
      async findById(id: string) {
        const { rows } = await pool.query("SELECT * FROM withdrawal_requests WHERE id = $1", [id]);
        return rows[0] ? toWithdrawalRequest(rows[0]) : null;
      },
      async findPendingByRegistration(registrationId: string) {
        const { rows } = await pool.query(
          "SELECT * FROM withdrawal_requests WHERE registration_id = $1 AND status = 'pending' LIMIT 1",
          [registrationId],
        );
        return rows[0] ? toWithdrawalRequest(rows[0]) : null;
      },
      async findByUser(userId: string) {
        const { rows } = await pool.query(
          "SELECT * FROM withdrawal_requests WHERE user_id = $1 ORDER BY created_at DESC",
          [userId],
        );
        return rows.map(toWithdrawalRequest);
      },
      async create(request: WithdrawalRequest) {
        await pool.query(
          `INSERT INTO withdrawal_requests (id, registration_id, user_id, reason, status, created_at)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [request.id, request.registrationId, request.userId, request.reason, request.status, request.createdAt],
        );
      },
      async update(id: string, fields: Partial<WithdrawalRequest>) {
        const COL: Record<string, string> = {
          status: "status", adminResponse: "admin_response", resolvedBy: "resolved_by",
        };
        const { sets, vals, next } = buildSet(COL, fields as Record<string, unknown>);
        if (sets.length === 0) return this.findById(id);
        let idx = next;
        if (fields.status === "approved" || fields.status === "rejected") {
          sets.push(`resolved_at = $${idx}`);
          vals.push(new Date().toISOString());
          idx++;
        }
        vals.push(id);
        const { rows } = await pool.query(
          `UPDATE withdrawal_requests SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`, vals,
        );
        return rows[0] ? toWithdrawalRequest(rows[0]) : null;
      },
    },

    rankTiers: {
      async findAll() {
        const { rows } = await pool.query("SELECT * FROM rank_tiers ORDER BY event_type, max_ao5_ms");
        return rows.map((r: Row): RankTier => ({
          id: r.id as string, name: r.name as string, eventType: r.event_type as string,
          maxAo5Ms: r.max_ao5_ms as number, color: r.color as string, createdAt: ts(r.created_at),
        }));
      },
      async findById(id: string) {
        const { rows } = await pool.query("SELECT * FROM rank_tiers WHERE id = $1", [id]);
        if (!rows[0]) return null;
        const r = rows[0] as Row;
        return { id: r.id as string, name: r.name as string, eventType: r.event_type as string,
          maxAo5Ms: r.max_ao5_ms as number, color: r.color as string, createdAt: ts(r.created_at) };
      },
      async findByEvent(eventType: string) {
        const { rows } = await pool.query("SELECT * FROM rank_tiers WHERE event_type = $1 ORDER BY max_ao5_ms", [eventType]);
        return rows.map((r: Row): RankTier => ({
          id: r.id as string, name: r.name as string, eventType: r.event_type as string,
          maxAo5Ms: r.max_ao5_ms as number, color: r.color as string, createdAt: ts(r.created_at),
        }));
      },
      async create(tier: RankTier) {
        await pool.query(
          "INSERT INTO rank_tiers (id, event_type, name, max_ao5_ms, color, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
          [tier.id, tier.eventType, tier.name, tier.maxAo5Ms, tier.color, tier.createdAt],
        );
      },
      async update(id: string, fields: Partial<RankTier>) {
        const COL: Record<string, string> = { name: "name", eventType: "event_type", maxAo5Ms: "max_ao5_ms", color: "color" };
        const { sets, vals, next } = buildSet(COL, fields as Record<string, unknown>);
        if (sets.length === 0) return this.findById(id);
        vals.push(id);
        const { rows } = await pool.query(`UPDATE rank_tiers SET ${sets.join(", ")} WHERE id = $${next} RETURNING *`, vals);
        if (!rows[0]) return null;
        const r = rows[0] as Row;
        return { id: r.id as string, name: r.name as string, eventType: r.event_type as string,
          maxAo5Ms: r.max_ao5_ms as number, color: r.color as string, createdAt: ts(r.created_at) };
      },
      async delete(id: string) {
        await pool.query("DELETE FROM rank_tiers WHERE id = $1", [id]);
      },
    },

    // ── promo codes ──────────────────────────────────────────────────────
    promoCodes: {
      async findAll() {
        const { rows } = await pool.query("SELECT * FROM promo_codes ORDER BY created_at DESC");
        return rows.map((r: Row) => toPromo(r));
      },
      async findById(id: string) {
        const { rows } = await pool.query("SELECT * FROM promo_codes WHERE id = $1", [id]);
        return rows[0] ? toPromo(rows[0] as Row) : null;
      },
      async findByCode(code: string) {
        const { rows } = await pool.query("SELECT * FROM promo_codes WHERE UPPER(code) = UPPER($1)", [code]);
        return rows[0] ? toPromo(rows[0] as Row) : null;
      },
      async create(promo: PromoCode) {
        await pool.query(
          `INSERT INTO promo_codes (id, code, type, discount_type, discount_value, max_uses, max_uses_per_user, used_count, competition_id, competition_event_id, valid_from, valid_until, active, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [promo.id, promo.code, promo.type, promo.discountType, promo.discountValue, promo.maxUses, promo.maxUsesPerUser, promo.usedCount,
           promo.competitionId ?? null, promo.competitionEventId ?? null, promo.validFrom ?? null, promo.validTo ?? null, promo.active, promo.createdAt],
        );
      },
      async update(id: string, fields: Partial<PromoCode>) {
        const COL: Record<string, string> = {
          code: "code", type: "type", discountType: "discount_type", discountValue: "discount_value",
          maxUses: "max_uses", maxUsesPerUser: "max_uses_per_user", active: "active",
          validFrom: "valid_from", validTo: "valid_until",
          competitionId: "competition_id", competitionEventId: "competition_event_id",
        };
        const { sets, vals, next } = buildSet(COL, fields as Record<string, unknown>);
        if (sets.length === 0) return this.findById(id);
        vals.push(id);
        await pool.query(`UPDATE promo_codes SET ${sets.join(", ")} WHERE id = $${next}`, vals);
        return this.findById(id);
      },
      async delete(id: string) {
        await pool.query("DELETE FROM promo_codes WHERE id = $1", [id]);
      },
      async incrementUsed(id: string) {
        const { rowCount } = await pool.query(
          "UPDATE promo_codes SET used_count = used_count + 1 WHERE id = $1 AND (max_uses = 0 OR used_count < max_uses)",
          [id],
        );
        return (rowCount ?? 0) > 0;
      },
      async recordUsage(promoCodeId: string, userId: string) {
        // No ON CONFLICT: every redemption needs its own row, because
        // `userUsageCount` counts rows to enforce max_uses_per_user. Swallowing
        // the conflict pinned that count at 1, so a code allowing more than one
        // use per person could be redeemed without limit. Migration 047 drops
        // the unique constraint that made the clause necessary.
        await pool.query(
          `INSERT INTO promo_code_usages (id, promo_code_id, user_id) VALUES ($1, $2, $3)`,
          [randomUUID(), promoCodeId, userId],
        );
      },
      async userUsageCount(promoCodeId: string, userId: string): Promise<number> {
        const { rows } = await pool.query(
          "SELECT COUNT(*)::int AS cnt FROM promo_code_usages WHERE promo_code_id = $1 AND user_id = $2",
          [promoCodeId, userId],
        );
        return (rows[0] as Row)?.cnt as number ?? 0;
      },
    },

    // ── banners ──────────────────────────────────────────────────────────
    banners: {
      async findAll() {
        const { rows } = await pool.query('SELECT * FROM banners ORDER BY "order"');
        return rows.map((r: Row): Banner => ({
          id: r.id as string, title: r.title as string,
          imageUrl: (r.image_url as string) ?? undefined,
          mobileImageUrl: (r.mobile_image_url as string) ?? undefined,
          ctaText: (r.cta_text as string) ?? undefined,
          ctaLink: (r.link_url as string) ?? undefined,
          linkUrl: (r.link_url as string) ?? undefined,
          expiresAt: r.expires_at ? ts(r.expires_at) : undefined,
          active: r.active as boolean, order: r.order as number, createdAt: ts(r.created_at),
        }));
      },
      async findById(id: string) {
        const { rows } = await pool.query("SELECT * FROM banners WHERE id = $1", [id]);
        if (!rows[0]) return null;
        const r = rows[0] as Row;
        return { id: r.id as string, title: r.title as string,
          imageUrl: (r.image_url as string) ?? undefined,
          mobileImageUrl: (r.mobile_image_url as string) ?? undefined,
          ctaText: (r.cta_text as string) ?? undefined,
          ctaLink: (r.link_url as string) ?? undefined,
          linkUrl: (r.link_url as string) ?? undefined,
          expiresAt: r.expires_at ? ts(r.expires_at) : undefined,
          active: r.active as boolean, order: r.order as number, createdAt: ts(r.created_at) };
      },
      async create(banner: Banner) {
        await pool.query(
          'INSERT INTO banners (id, title, image_url, mobile_image_url, cta_text, link_url, "order", active, expires_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [banner.id, banner.title, banner.imageUrl ?? null, banner.mobileImageUrl ?? null, banner.ctaText ?? null, banner.ctaLink ?? banner.linkUrl ?? null, banner.order, banner.active, banner.expiresAt ?? null, banner.createdAt],
        );
      },
      async update(id: string, fields: Partial<Banner>) {
        const COL: Record<string, string> = { title: "title", imageUrl: "image_url", mobileImageUrl: "mobile_image_url", ctaText: "cta_text", ctaLink: "link_url", linkUrl: "link_url", active: "active", order: '"order"', expiresAt: "expires_at" };
        const { sets, vals, next } = buildSet(COL, fields as Record<string, unknown>);
        if (sets.length === 0) return this.findById(id);
        vals.push(id);
        await pool.query(`UPDATE banners SET ${sets.join(", ")} WHERE id = $${next}`, vals);
        return this.findById(id);
      },
      async delete(id: string) {
        await pool.query("DELETE FROM banners WHERE id = $1", [id]);
      },
    },

    // ── faq ──────────────────────────────────────────────────────────────
    faq: {
      async findAll(publishedOnly?: boolean) {
        const { rows } = await pool.query(
          publishedOnly
            ? 'SELECT * FROM faq_entries WHERE published = true ORDER BY "order"'
            : 'SELECT * FROM faq_entries ORDER BY "order"',
        );
        return rows.map((r: Row): FaqEntry => ({
          id: r.id as string, question: r.question as string, answerMd: r.answer as string,
          order: r.order as number, published: r.published as boolean, createdAt: ts(r.created_at),
        }));
      },
      async findById(id: string) {
        const { rows } = await pool.query("SELECT * FROM faq_entries WHERE id = $1", [id]);
        if (!rows[0]) return null;
        const r = rows[0] as Row;
        return { id: r.id as string, question: r.question as string, answerMd: r.answer as string,
          order: r.order as number, published: r.published as boolean, createdAt: ts(r.created_at) };
      },
      async create(entry: FaqEntry) {
        await pool.query(
          'INSERT INTO faq_entries (id, question, answer, "order", published, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
          [entry.id, entry.question, entry.answerMd, entry.order, entry.published, entry.createdAt],
        );
      },
      async update(id: string, fields: Partial<FaqEntry>) {
        const COL: Record<string, string> = { question: "question", answerMd: "answer", order: '"order"', published: "published" };
        const { sets, vals, next } = buildSet(COL, fields as Record<string, unknown>);
        if (sets.length === 0) return this.findById(id);
        sets.push(`updated_at = now()`);
        vals.push(id);
        await pool.query(`UPDATE faq_entries SET ${sets.join(", ")} WHERE id = $${next}`, vals);
        return this.findById(id);
      },
      async delete(id: string) {
        await pool.query("DELETE FROM faq_entries WHERE id = $1", [id]);
      },
    },

    contentPages: {
      async findAll(publishedOnly?: boolean) {
        const { rows } = await pool.query(
          publishedOnly
            ? "SELECT * FROM content_pages WHERE published = true ORDER BY title"
            : "SELECT * FROM content_pages ORDER BY title",
        );
        return rows.map((r: Row): ContentPage => ({
          id: r.id as string, slug: r.slug as string, title: r.title as string,
          bodyMd: r.body_md as string, published: r.published as boolean,
          updatedAt: ts(r.updated_at), createdAt: ts(r.created_at),
        }));
      },
      async findBySlug(slug: string) {
        const { rows } = await pool.query("SELECT * FROM content_pages WHERE slug = $1", [slug]);
        if (!rows[0]) return null;
        const r = rows[0] as Row;
        return { id: r.id as string, slug: r.slug as string, title: r.title as string,
          bodyMd: r.body_md as string, published: r.published as boolean,
          updatedAt: ts(r.updated_at), createdAt: ts(r.created_at) };
      },
      async findById(id: string) {
        const { rows } = await pool.query("SELECT * FROM content_pages WHERE id = $1", [id]);
        if (!rows[0]) return null;
        const r = rows[0] as Row;
        return { id: r.id as string, slug: r.slug as string, title: r.title as string,
          bodyMd: r.body_md as string, published: r.published as boolean,
          updatedAt: ts(r.updated_at), createdAt: ts(r.created_at) };
      },
      async create(page: ContentPage) {
        await pool.query(
          "INSERT INTO content_pages (id, slug, title, body_md, published, updated_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [page.id, page.slug, page.title, page.bodyMd, page.published, page.updatedAt, page.createdAt],
        );
      },
      async update(id: string, fields: Partial<ContentPage>) {
        const COL: Record<string, string> = { slug: "slug", title: "title", bodyMd: "body_md", published: "published" };
        const { sets, vals, next } = buildSet(COL, fields as Record<string, unknown>);
        if (sets.length === 0) return this.findById(id);
        sets.push("updated_at = now()");
        vals.push(id);
        await pool.query(`UPDATE content_pages SET ${sets.join(", ")} WHERE id = $${next}`, vals);
        return this.findById(id);
      },
      async delete(id: string) {
        await pool.query("DELETE FROM content_pages WHERE id = $1", [id]);
      },
    },

    ruleSets: {
      async findAll() {
        const { rows } = await pool.query("SELECT * FROM rule_sets ORDER BY name ASC");
        return rows.map((r: Row) => ({
          id: r.id as string,
          name: r.name as string,
          content: r.content as string,
          createdAt: ts(r.created_at),
          updatedAt: ts(r.updated_at),
        }));
      },
      async findById(id) {
        const { rows } = await pool.query("SELECT * FROM rule_sets WHERE id = $1", [id]);
        if (!rows[0]) return null;
        const r = rows[0];
        return { id: r.id as string, name: r.name as string, content: r.content as string, createdAt: ts(r.created_at), updatedAt: ts(r.updated_at) };
      },
      async findByIds(ids) {
        const map = new Map<string, RuleSet>();
        if (ids.length === 0) return map;
        const { rows } = await pool.query(
          "SELECT * FROM rule_sets WHERE id = ANY($1::uuid[])",
          [ids],
        );
        for (const r of rows) {
          map.set(r.id as string, {
            id: r.id as string,
            name: r.name as string,
            content: r.content as string,
            createdAt: ts(r.created_at),
            updatedAt: ts(r.updated_at),
          });
        }
        return map;
      },
      async create(ruleSet) {
        await pool.query(
          "INSERT INTO rule_sets (id, name, content, created_at, updated_at) VALUES ($1,$2,$3,$4,$5)",
          [ruleSet.id, ruleSet.name, ruleSet.content, ruleSet.createdAt, ruleSet.updatedAt],
        );
      },
      async update(id, fields) {
        const sets: string[] = [];
        const vals: unknown[] = [];
        let i = 1;
        if (typeof fields.name === "string") { sets.push(`name = $${i++}`); vals.push(fields.name); }
        if (typeof fields.content === "string") { sets.push(`content = $${i++}`); vals.push(fields.content); }
        if (sets.length === 0) return this.findById(id);
        sets.push(`updated_at = $${i++}`);
        vals.push(new Date().toISOString());
        vals.push(id);
        const { rows } = await pool.query(
          `UPDATE rule_sets SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
          vals,
        );
        if (!rows[0]) return null;
        const r = rows[0];
        return { id: r.id as string, name: r.name as string, content: r.content as string, createdAt: ts(r.created_at), updatedAt: ts(r.updated_at) };
      },
      async delete(id) {
        await pool.query("DELETE FROM rule_sets WHERE id = $1", [id]);
      },
    },

    competitionRuleSets: {
      async findByCompetition(competitionId) {
        const { rows } = await pool.query(
          "SELECT rule_set_id FROM competition_rule_sets WHERE competition_id = $1 ORDER BY position",
          [competitionId],
        );
        return rows.map((r: Row) => r.rule_set_id as string);
      },
      async findByCompetitions(competitionIds) {
        const map = new Map<string, string[]>();
        if (competitionIds.length === 0) return map;
        const { rows } = await pool.query(
          `SELECT competition_id, rule_set_id FROM competition_rule_sets
           WHERE competition_id = ANY($1::uuid[])
           ORDER BY competition_id, position`,
          [competitionIds],
        );
        for (const r of rows) {
          const compId = r.competition_id as string;
          if (!map.has(compId)) map.set(compId, []);
          map.get(compId)!.push(r.rule_set_id as string);
        }
        return map;
      },
      async replace(competitionId, ruleSetIds) {
        // Delete-then-insert in one transaction so a failed insert cannot leave
        // the competition with no rule sets.
        await withTransaction(async (client) => {
          await client.query("DELETE FROM competition_rule_sets WHERE competition_id = $1", [competitionId]);
          for (const [position, ruleSetId] of ruleSetIds.entries()) {
            await client.query(
              `INSERT INTO competition_rule_sets (competition_id, rule_set_id, position)
               VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
              [competitionId, ruleSetId, position],
            );
          }
        });
      },
    },

    systemSettings: {
      async get(): Promise<SystemSettings> {
        const { rows } = await pool.query(
          "SELECT data FROM system_settings WHERE id = 'default'",
        );
        const defaults: SystemSettings = {
          eventDurations: {},
          registrationDurationDays: 5,
          gapBetweenEventsMinutes: 0,
          defaultRoundDurationMinutes: 20,
          videoDeadlineMinutes: 1440,
          autoPublishLeadMinutes: 30,
          publishWarningLeadHours: 5,
          flagRuleDefaults: {
            nearRecordPct: 5,
            personalDeviationPct: 30,
            missingVideo: true,
            borderlineCutoffMargin: 3,
          },
          recordReferences: {},
        };
        if (rows.length === 0) return defaults;
        // Merge stored data over defaults so new fields get populated
        const stored = rows[0].data as Partial<SystemSettings>;
        return {
          ...defaults,
          ...stored,
          flagRuleDefaults: { ...defaults.flagRuleDefaults, ...stored.flagRuleDefaults },
          recordReferences: { ...defaults.recordReferences, ...stored.recordReferences },
        };
      },
      async update(fields: Partial<SystemSettings>): Promise<SystemSettings> {
        const current = await this.get();
        const merged = { ...current, ...fields };
        // Deep-merge nested objects
        if (fields.eventDurations) {
          merged.eventDurations = { ...current.eventDurations, ...fields.eventDurations };
        }
        if (fields.flagRuleDefaults) {
          merged.flagRuleDefaults = { ...current.flagRuleDefaults, ...fields.flagRuleDefaults };
        }
        if (fields.recordReferences) {
          merged.recordReferences = { ...current.recordReferences, ...fields.recordReferences };
        }
        await pool.query(
          `INSERT INTO system_settings (id, data, updated_at)
           VALUES ('default', $1, now())
           ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = now()`,
          [JSON.stringify(merged)],
        );
        return merged;
      },
    },

    async ping() {
      const t0 = Date.now();
      await pool.query("SELECT 1");
      return { backend: "postgresql", latencyMs: Date.now() - t0 };
    },

    // ── judge assignments ────────────────────────────────────────────────
    judgeAssignments: {
      async findById(id) {
        const { rows } = await pool.query("SELECT * FROM judge_assignments WHERE id = $1", [id]);
        return rows[0] ? toJudgeAssignment(rows[0]) : null;
      },
      async findByRound(roundId) {
        const { rows } = await pool.query(
          "SELECT * FROM judge_assignments WHERE round_id = $1",
          [roundId],
        );
        return rows.map(toJudgeAssignment);
      },
      async findByJudge(judgeId) {
        const { rows } = await pool.query(
          "SELECT * FROM judge_assignments WHERE judge_id = $1",
          [judgeId],
        );
        return rows.map(toJudgeAssignment);
      },
      async create(assignment) {
        await pool.query(
          `INSERT INTO judge_assignments (id, judge_id, round_id, assigned_by, assigned_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (judge_id, round_id) DO NOTHING`,
          [assignment.id, assignment.judgeId, assignment.roundId, assignment.assignedBy, assignment.assignedAt],
        );
      },
      async delete(id) {
        await pool.query("DELETE FROM judge_assignments WHERE id = $1", [id]);
      },
    },

    // ── roster (Redis primary, in-memory fallback for dev) ─────────────────
    roster: {
      async join(roundId, userId, name) {
        const redis = await getRedis();
        if (redis) {
          await redis.hset(`roster:${roundId}`, userId, name);
          return;
        }
        if (!roster.has(roundId)) roster.set(roundId, new Map());
        roster.get(roundId)!.set(userId, name);
      },
      async leave(roundId, userId) {
        const redis = await getRedis();
        if (redis) {
          await redis.hdel(`roster:${roundId}`, userId);
          return;
        }
        roster.get(roundId)?.delete(userId);
      },
      async snapshot(roundId) {
        const redis = await getRedis();
        if (redis) {
          const data = await redis.hgetall(`roster:${roundId}`);
          return Object.entries(data).map(([userId, name]) => ({ userId, name }));
        }
        const r = roster.get(roundId);
        if (!r) return [];
        return [...r.entries()].map(([userId, name]) => ({ userId, name }));
      },
    },
  };
}
