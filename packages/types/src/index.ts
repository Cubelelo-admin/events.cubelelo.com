/**
 * Shared domain types for the Cubelelo Events Platform.
 * Mirrors the PostgreSQL enums + core entities in ARCHITECTURE.md §3.
 */

export * from "./wca.js";

// ─────────────────────────── Enums ───────────────────────────
export type UserRole = "user" | "judge" | "moderator" | "admin" | "super_admin";
export type AccountStage = "active" | "migrated_stub" | "suspended" | "banned" | "deleted";
export type CompStatus = "draft" | "published" | "upcoming" | "registration_open" | "registration_closed" | "cancelled" | "live" | "results_pending" | "completed";
export type CompType = "paid" | "free" | "practice";
export type RoundStatus = "pending" | "open" | "closed" | "advanced" | "cancelled";
export type PaymentStatus = "pending" | "paid" | "failed" | "refunded" | "refund_pending";
export type SolvePenalty = "none" | "plus2" | "dnf";
export type FlagStatus = "clean" | "flagged" | "verified" | "plus2" | "dnf" | "disqualified";

// ─────────────────────────── Solves ───────────────────────────
/** A single timed attempt. `time_ms` is the raw solve time; penalties applied at compute time. */
export interface Solve {
  time_ms: number;
  /** Inspection penalty — auto-assigned by timer (>15s = +2, >17s = DNF). */
  inspectionPenalty: SolvePenalty;
  /** Manual penalty — user self-assigns after stopping (cube unsolved = DNF, 1 move away = +2). */
  penalty: SolvePenalty;
}

/** Averaging stats computed from a set of solves (WCA trimming rules). */
export interface SolveStats {
  best_single_ms: number | null;
  ao5_ms: number | null;
  mean_ms: number | null;
  median_ms: number | null;
  std_ms: number | null;
}

// ─────────────────────────── Core entities (subset) ───────────────────────────
export interface User {
  id: string; // Supabase auth uid
  cl_id: string; // CL-YYYY-XXXX
  email: string;
  name: string;
  last_name?: string | null;
  dob?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  wca_id?: string | null;
  wca_verified: boolean;
  role: UserRole;
  account_stage: AccountStage;
}
