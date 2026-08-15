import type { Solve, SolvePenalty, WcaFormat } from "@cubers/types";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

const FRIENDLY_ERRORS: Record<string, string> = {
  // Registration
  registration_full: "This competition is full — no more spots available.",
  registration_not_open: "Registration is not open for this competition.",
  already_registered: "You are already registered for this competition.",
  email_not_verified: "Please verify your email before registering.",
  no_events_selected: "Please select at least one event.",
  not_synced: "Your account isn't synced yet. Please sign in again.",
  invalid_event_id: "One of the selected events is invalid.",
  event_not_available: "One of the selected events is not available.",
  registration_closed_cannot_withdraw: "Registration is closed — you can no longer withdraw.",
  paid_registration_contact_admin:
    "This competition was paid for — send the organiser a withdrawal request and they'll settle the refund.",
  competition_not_found: "Competition not found.",
  event_has_results:
    "This event already has results, so it can't be deleted. Leave it archived instead.",
  // Image upload
  banner_required: "A desktop banner is required before this competition can be published.",
  // Leaving a competition
  registration_not_active: "This registration is no longer active.",
  registration_has_results:
    "You have already submitted results in this competition, so it can't be withdrawn.",
  request_already_submitted: "You already have a withdrawal request awaiting review.",
  request_already_resolved: "This request has already been resolved.",
  can_only_withdraw_own_registration: "You can only withdraw your own registration.",
  registration_id_and_reason_required: "Please give a reason for withdrawing.",
  withdraw_directly: "This competition is free — you can withdraw without asking.",
  invalid_file_type: "That file type isn't supported. Use a PNG, JPG, GIF, or WebP image.",
  file_too_large_max_5mb: "That image is larger than 5 MB. Please upload a smaller file.",
  no_file: "No file was received. Please pick an image and try again.",
  // Payments
  missing_registration_id: "Registration not found. Please try again.",
  registration_not_found: "Registration not found.",
  already_paid: "This registration is already paid.",
  missing_fields: "Something went wrong. Please try again.",
  invalid_signature: "Payment verification failed. Please contact support if you were charged.",
  payment_not_found: "Payment not found.",
  forbidden: "You don't have permission for this action.",
  razorpay_not_configured: "Online payments are not available right now. Please try later.",
  payment_not_completed: "This payment has not been completed yet.",
  // Promo codes
  invalid_code: "This promo code is invalid or inactive.",
  code_required: "Please enter a promo code.",
  code_exhausted: "This promo code has been fully redeemed.",
  code_not_yet_valid: "This promo code is not active yet.",
  code_expired: "This promo code has expired.",
  code_not_for_this_competition: "This promo code doesn't apply to this competition.",
  code_not_for_selected_events: "This promo code doesn't apply to your selected events.",
  invalid_promo_code: "This promo code is invalid or inactive.",
  promo_not_valid_for_competition: "This promo code doesn't apply to this competition.",
  promo_not_for_selected_events: "This promo code doesn't apply to your selected events.",
  promo_registration_closed: "This promo code is only valid during open registration.",
  promo_welcome_only: "This promo code is only for first-time competitors.",
  promo_expired: "This promo code has expired.",
  promo_already_used: "You've already used this promo code.",
  promo_fully_redeemed: "This promo code has been fully redeemed.",
  // Auth
  invalid_credentials: "Incorrect email or password.",
  account_locked: "Your account has been locked. Please contact support.",
  user_not_found: "Account not found.",
  otp_delivery_failed: "Failed to send verification code. Please try again.",
  // Payments
  payment_gateway_unavailable: "Payment gateway is temporarily unavailable. Please try again in a moment.",
  // Judging
  attempt_penalties_required:
    "Select which attempt the penalty applies to before applying a +2 or DNF.",
  invalid_solve_penalties: "The attempt penalties don't match this result's attempts.",
  reason_required: "Please give a reason for this action.",
  invalid_action: "That verification action isn't valid.",
  not_assigned_to_round: "You aren't assigned to judge this round.",
  // Results
  invalid_solves: "Those attempt times aren't valid for this round's format.",
  round_not_open: "This round isn't open for submissions.",
  already_submitted: "You've already submitted a result for this round.",
  not_shortlisted: "You didn't advance to this round.",
  not_registered_for_event: "You aren't registered for this event.",
  // General
  internal_error: "Something went wrong. Please try again.",
  invalid_request: "Invalid request. Please check your input and try again.",
};

export function friendlyError(raw: string): string {
  const codeMatch = raw.match(/"error"\s*:\s*"([^"]+)"/);
  const code = codeMatch?.[1] ?? raw;
  if (FRIENDLY_ERRORS[code]) return FRIENDLY_ERRORS[code];
  if (/^\d{3}\s/.test(raw)) return "Something went wrong. Please try again.";
  return raw;
}

export function assetUrl(path: string | undefined | null): string {
  if (!path) return "";
  const url = path.startsWith("http://") || path.startsWith("https://") ? path : `${BASE_URL}${path}`;
  return url.replace(/ /g, "%20");
}

// ── Auth token (set by the AuthProvider; attached to every request) ──
let authToken: string | null = null;
export function setAuthToken(token: string | null): void {
  authToken = token;
}
function authHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  if (authToken) h.authorization = `Bearer ${authToken}`;
  if (BASE_URL.includes("ngrok")) h["ngrok-skip-browser-warning"] = "1";
  return h;
}

export interface AuthUser {
  id: string;
  clId: string;
  email: string;
  name: string;
  role: string;
  city?: string;
  state?: string;
  country?: string;
  address?: string;
  landmark?: string;
  pincode?: string;
  instagram?: string;
  wcaId?: string;
  mobileNo?: string;
  wcaVerified?: boolean;
  emailVerified?: boolean;
  mobileVerified?: boolean;
  hasPassword?: boolean;
  profilePrivacy?: "public" | "private";
}

export interface AdvancementCriteria {
  method: "rank" | "time" | "best_single";
  rankLimit?: number;
  timeLimitMs?: number;
  bestSingleMs?: number;
}

export interface RoundRef {
  id: string;
  roundNumber: number;
  status: string;
  eventType: string;
  /** WCA format code: 1=Bo1, 2=Bo2, 3=Bo3, a=Ao5, m=Mo3. */
  format?: WcaFormat;
  /** Attempts this round gives a competitor, derived from `format` by the API. */
  attempts?: number;
  /** Effective cutoff / time limit — the round's own value, else the event default. */
  cutoffMs?: number | null;
  timeLimitMs?: number | null;
  /** The round's own override, null when it inherits the event default. */
  ownCutoffMs?: number | null;
  ownTimeLimitMs?: number | null;
  scrambleLocked?: boolean;
  opensAt?: string | null;
  closesAt?: string | null;
  durationMinutes?: number | null;
  advancementCount?: number | null;
  advancementCriteria?: AdvancementCriteria | null;
  resultsPublishedAt?: string | null;
}

export interface CompetitionSummary {
  id: string;
  title: string;
  type: string;
  status: string;
  description?: string;
  baseFee?: number;
  perEventFee?: number;
  registrationOpensAt?: string | null;
  registrationDeadline?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  bannerUrl?: string;
  mobileBannerUrl?: string;
  featured?: boolean;
  createdAt?: string;
  createdBy?: string | null;
  eventTypes?: string[];
  registrationCount?: number;
  registrationLimit?: number | null;
  cancellationReason?: string | null;
}

export interface EventDetail {
  id: string;
  eventType: string;
  roundCount: number;
  cutoffMs?: number;
  timeLimitMs?: number;
  fee?: number;
  archived?: boolean;
  rounds: RoundRef[];
}

export interface CompetitionDetail {
  id: string;
  title: string;
  type: string;
  status: string;
  description?: string;
  rulesMd?: string;
  ruleSets?: { id: string; name: string; content: string }[];
  baseFee?: number;
  perEventFee?: number;
  registrationOpensAt?: string | null;
  registrationDeadline?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  bannerUrl?: string;
  mobileBannerUrl?: string;
  featured?: boolean;
  featuredOrder?: number | null;
  createdBy?: string;
  publishedBy?: string | null;
  publishedByName?: string | null;
  createdAt?: string;
  registrationCount?: number;
  registrationLimit?: number | null;
  cancellationReason?: string | null;
  videoDeadlineMinutes?: number;
  events: EventDetail[];
}

export interface ResultDto {
  id: string;
  userId: string;
  userName?: string;
  userClId?: string;
  roundId?: string;
  ao5Ms: number | null;
  bestSingleMs: number | null;
  rank: number | null;
  solves?: Solve[];
  flagStatus?: string;
  videoUrl?: string;
}

export interface FlaggedResultDto {
  id: string;
  roundId: string;
  userId: string;
  userName: string;
  userClId: string;
  eventType: string;
  roundNumber: number | null;
  ao5Ms: number | null;
  bestSingleMs: number | null;
  solves: Solve[];
  videoUrl: string | null;
  flagStatus: string;
  suspicionReasons: string[];
  submittedAt: string;
}

export interface RegistrationDto {
  id: string;
  competitionId: string;
  competitionTitle: string;
  paymentStatus: string;
  /** Whether the registration still stands. Withdrawn rows are kept on record. */
  status: "active" | "withdrawn" | "removed";
  events: { id: string; eventType: string }[];
  createdAt: string;
}

export interface ProfileRoundResult {
  roundNumber: number;
  rank: number | null;
  bestSingleMs: number | null;
  ao5Ms: number | null;
  solves: Solve[];
}

export interface ProfileEventResult {
  eventType: string;
  rounds: ProfileRoundResult[];
}

export interface ProfileCompetitionEntry {
  competitionId: string;
  competitionTitle: string;
  status: string;
  events: ProfileEventResult[];
}

export interface UserProfile {
  clId: string;
  name: string;
  city?: string;
  state?: string;
  country?: string;
  avatarUrl?: string;
  instagram?: string;
  wcaId?: string;
  wcaVerified?: boolean;
  profilePrivacy?: "public" | "private";
  createdAt?: string;
  personalBests: Record<string, { bestSingle: number | null; bestAo5: number | null }>;
  stats: {
    totalCompetitions: number;
    totalSolves: number;
    eventStats: Record<string, { mean: number | null; stdDev: number | null; solveCount: number }>;
    solveTimeline: Record<string, Array<{ timeMs: number; ao5Ms: number | null; date: string; compTitle: string }>>;
  } | null;
  competitionHistory: ProfileCompetitionEntry[];
}

function handleUnauthorized(status: number): void {
  if (status === 401 && typeof window !== "undefined") {
    localStorage.removeItem("cubers_token");
    setAuthToken(null);
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: authHeaders() });
  if (!res.ok) {
    handleUnauthorized(res.status);
    let detail = "";
    try {
      const body = await res.json();
      if (body?.error) detail = body.error;
    } catch {}
    throw new Error(friendlyError(detail || `${res.status} ${res.statusText}`));
  }
  return res.json() as Promise<T>;
}

async function sendJson<T>(
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  body?: object,
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...authHeaders(),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    handleUnauthorized(res.status);
    let detail = "";
    try {
      const body = await res.json();
      if (body?.error) detail = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(friendlyError(detail || `${res.status} ${res.statusText}`));
  }
  return res.json() as Promise<T>;
}

// ── Competitions ──
export function fetchCompetitions(status?: string): Promise<CompetitionSummary[]> {
  const qs = status ? `?status=${status}` : "";
  return getJson<CompetitionSummary[]>(`/api/v1/competitions${qs}`);
}

export function fetchCompetition(id: string): Promise<CompetitionDetail> {
  return getJson<CompetitionDetail>(`/api/v1/competitions/${id}`);
}

export interface RoundProgress {
  roundId: string;
  roundNumber: number;
  eventType: string | null;
  status: string;
  userStatus: string;
  result: { id: string; rank: number | null; ao5Ms: number | null; bestSingleMs: number | null; videoUrl: string | null; solves?: Array<{ time_ms: number; penalty: string; inspectionPenalty?: string }> } | null;
}

export function fetchMyProgress(compId: string): Promise<{ registered: boolean; rounds: RoundProgress[] }> {
  return getJson(`/api/v1/competitions/${compId}/my-progress`);
}

export interface LiveRankingEntry {
  resultId: string;
  userId: string;
  clId: string;
  name: string;
  rank: number | null;
  ao5Ms: number | null;
  bestSingleMs: number | null;
  flagStatus: string;
}

export function fetchLiveRanking(compId: string, event?: string): Promise<{
  roundId: string | null;
  roundNumber: number | null;
  eventType?: string;
  ranking: LiveRankingEntry[];
}> {
  const q = event ? `?event=${encodeURIComponent(event)}` : "";
  return getJson(`/api/v1/competitions/${compId}/live-ranking${q}`);
}

export interface LiveCompetitionView {
  competition: {
    id: string;
    title: string;
    type: string;
    status: string;
    startsAt: string | null;
    endsAt: string | null;
    videoDeadlineMinutes: number;
    cancellationReason: string | null;
  };
  events: {
    id: string;
    eventType: string;
    roundCount: number;
    rounds: { id: string; roundNumber: number; status: string; opensAt: string | null; closesAt: string | null }[];
  }[];
  activeRound: {
    id: string;
    roundNumber: number;
    status: string;
    eventId: string;
    eventType: string | null;
    opensAt: string | null;
    closesAt: string | null;
  } | null;
  leaderboard: LiveRankingEntry[];
  userResult: { id: string; rank: number | null; ao5Ms: number | null; bestSingleMs: number | null; flagStatus: string } | null;
}

export function fetchLiveCompetition(compId: string): Promise<LiveCompetitionView> {
  return getJson<LiveCompetitionView>(`/api/v1/competitions/${compId}/live`);
}

export interface ParticipantEntry {
  userId: string;
  clId: string;
  name: string;
  city: string | null;
  country: string | null;
  eventTypes: string[];
  registeredAt: string;
}

export function fetchParticipants(compId: string): Promise<{
  count: number;
  participants: ParticipantEntry[];
}> {
  return getJson(`/api/v1/competitions/${compId}/participants`);
}

export interface EventRoundInfo {
  id: string;
  roundNumber: number;
  status: string;
  opensAt: string | null;
  closesAt: string | null;
  advancementCriteria: AdvancementCriteria | null;
  resultCount: number;
  participantCount: number;
}

export interface EventUserRound {
  roundId: string;
  roundNumber: number;
  userStatus: string;
  result: { id: string; rank: number | null; ao5Ms: number | null; bestSingleMs: number | null; videoUrl: string | null } | null;
}

export interface EventPageData {
  competition: {
    id: string;
    title: string;
    status: string;
    rulesMd: string | null;
    startsAt: string | null;
    endsAt: string | null;
    type: string;
    cancellationReason: string | null;
    videoDeadlineMinutes: number;
  };
  event: {
    id: string;
    eventType: string;
    roundCount: number;
    cutoffMs: number | null;
    timeLimitMs: number | null;
  };
  rounds: EventRoundInfo[];
  userStatus: { registered: boolean; rounds: EventUserRound[] } | null;
  finalStandings: { rank: number; userId: string; displayName: string }[] | null;
}

export function fetchEventPage(compId: string, eventId: string): Promise<EventPageData> {
  return getJson(`/api/v1/competitions/${compId}/event/${eventId}`);
}

export function fetchVerifiedResults(roundId: string): Promise<ResultDto[]> {
  return getJson<ResultDto[]>(`/api/v1/rounds/${roundId}/verified-results`);
}

export function fetchScramble(
  roundId: string,
): Promise<{ roundId: string; scrambles: string[] }> {
  return getJson(`/api/v1/rounds/${roundId}/scramble`);
}

export function submitResult(
  roundId: string,
  body: { solves: Solve[]; videoUrl?: string },
): Promise<ResultDto> {
  return sendJson("POST", `/api/v1/rounds/${roundId}/results`, body);
}

export function fetchLeaderboard(roundId: string): Promise<ResultDto[]> {
  return getJson<ResultDto[]>(`/api/v1/rounds/${roundId}/results`);
}

// ── Auth ──
export function authRegister(
  identifier: string,
  password: string,
  name?: string,
): Promise<{ token: string; otpSentTo: "email" | "mobile" }> {
  return sendJson("POST", `/api/v1/auth/register`, { identifier, password, name });
}

export function authLogin(
  identifier: string,
  password: string,
): Promise<{ token: string }> {
  return sendJson("POST", `/api/v1/auth/login`, { identifier, password });
}

export function verifyEmailWithGoogle(
  googleToken: string,
): Promise<{ ok: boolean; emailVerified: boolean }> {
  return sendJson("POST", `/api/v1/auth/verify-google`, { googleToken });
}

export function syncUser(): Promise<AuthUser> {
  return sendJson("POST", `/api/v1/auth/sync`);
}

export async function apiSignOut(): Promise<void> {
  await fetch(`${BASE_URL}/api/v1/auth/sign-out`, {
    method: "POST",
    headers: authHeaders(),
  }).catch(() => {});
}

export function verifyEmail(token: string): Promise<{ ok: boolean }> {
  return sendJson("POST", `/api/v1/auth/verify-email`, { token });
}

export function resendVerification(): Promise<{ ok: boolean }> {
  return sendJson("POST", `/api/v1/auth/resend-verification`);
}

export function sendOtp(type: "email" | "mobile", value: string): Promise<{ ok: boolean }> {
  return sendJson("POST", `/api/v1/auth/send-otp`, { type, value });
}

export function verifyOtp(type: "email" | "mobile", value: string, code: string): Promise<{ ok: boolean }> {
  return sendJson("POST", `/api/v1/auth/verify-otp`, { type, value, code });
}

export function forgotPassword(email: string): Promise<{ ok: boolean }> {
  return sendJson("POST", `/api/v1/auth/forgot-password`, { email });
}

export function resetPassword(token: string, newPassword: string): Promise<{ ok: boolean }> {
  return sendJson("POST", `/api/v1/auth/reset-password`, { token, newPassword });
}

export function sendMigrationEmails(): Promise<{ totalStubs: number; sentCount: number }> {
  return sendJson("POST", `/api/v1/admin/migration/send-emails`);
}

export function migrateClaim(body: {
  legacyClId?: string;
  legacyEmail?: string;
}): Promise<AuthUser> {
  return sendJson("POST", `/api/v1/auth/migrate-claim`, body);
}

export function fetchMe(): Promise<AuthUser> {
  return getJson<AuthUser>(`/api/v1/users/me`);
}

export interface SearchResult {
  clId: string;
  name: string;
  avatarUrl?: string;
  city?: string;
  country?: string;
}

export function searchUsers(q: string): Promise<SearchResult[]> {
  return getJson<SearchResult[]>(`/api/v1/users/search?q=${encodeURIComponent(q)}`);
}

export interface GlobalSearchResult {
  type: "user" | "competition" | "announcement" | "page" | "admin";
  id: string;
  title: string;
  subtitle: string;
  href: string | null;
}

export function globalSearch(q: string): Promise<GlobalSearchResult[]> {
  return getJson<GlobalSearchResult[]>(`/api/v1/search?q=${encodeURIComponent(q)}`);
}

// ── Registration ──
export function registerForCompetition(
  competitionId: string,
  eventIds: string[],
): Promise<{ registrationId: string; totalFee: number; paymentStatus: string }> {
  return sendJson("POST", `/api/v1/competitions/${competitionId}/register`, {
    eventIds,
  });
}

export function fetchMyRegistrations(): Promise<RegistrationDto[]> {
  return getJson<RegistrationDto[]>(`/api/v1/me/registrations`);
}

// ── Payments ──
export function createPaymentOrder(
  competitionId: string,
  eventIds: string[],
  promoCode?: string,
): Promise<{ orderId: string; amount: number; currency: string; paymentId: string; keyId: string | null; registrationId?: string; status?: string }> {
  return sendJson("POST", `/api/v1/payments/order`, { competitionId, eventIds, promoCode });
}

export function verifyPayment(
  razorpay_order_id: string,
  razorpay_payment_id: string,
  razorpay_signature: string,
): Promise<{ status: string; registrationId?: string }> {
  return sendJson("POST", `/api/v1/payments/verify`, {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
  });
}

// ── User Profiles ──
export function fetchUserProfile(clId: string): Promise<UserProfile> {
  return getJson<UserProfile>(`/api/v1/users/${clId}`);
}

export function updateMyProfile(
  fields: Record<string, string>,
): Promise<AuthUser> {
  return sendJson("PATCH", `/api/v1/users/me`, fields);
}

export function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<{ ok: boolean }> {
  return sendJson("POST", `/api/v1/auth/change-password`, { currentPassword, newPassword });
}

/**
 * One event and its rounds, as sent to either competition endpoint.
 *
 * Declared once because the create and update bodies previously spelled it out
 * separately and drifted apart — the same divergence this whole pass exists to
 * remove. Mirrors `CompetitionEventInput` on the API.
 */
export interface CompetitionEventPayload {
  eventType: string;
  roundCount?: number;
  /** Event-level defaults that seed new rounds. */
  cutoffMs?: number;
  timeLimitMs?: number;
  fee?: number;
  /** Created but hidden from competitors. */
  archived?: boolean;
  durationMinutes?: number;
  advancementCount?: number;
  advancementCriteria?: AdvancementCriteria;
  roundCriteria?: (AdvancementCriteria | undefined)[];
  roundSchedule?: ({ startTime?: string; durationMinutes?: number } | undefined)[];
  /** Per-round overrides, parallel to the rounds; empty slots inherit. */
  roundFormats?: (WcaFormat | undefined)[];
  roundCutoffMs?: (number | undefined)[];
  roundTimeLimitMs?: (number | undefined)[];
  /** Push changed event-level cutoff / time limit onto existing rounds. */
  applyToExistingRounds?: boolean;
}

// ── Admin ──
export function createCompetition(body: {
  title: string;
  type: string;
  description?: string;
  rulesMd?: string;
  ruleSetIds?: string[];
  baseFee?: number;
  perEventFee?: number;
  registrationLimit?: number;
  registrationOpensAt?: string;
  registrationDeadline?: string;
  startsAt?: string;
  endsAt?: string;
  eventType?: string;
  roundCount?: number;
  events?: CompetitionEventPayload[];
}): Promise<{ id: string }> {
  return sendJson("POST", `/api/v1/admin/competitions`, body);
}

export function updateCompetition(
  id: string,
  body: {
    title?: string;
    status?: string;
    description?: string;
    rulesMd?: string;
    ruleSetIds?: string[];
    baseFee?: number;
    perEventFee?: number;
    registrationOpensAt?: string | null;
    registrationDeadline?: string | null;
    startsAt?: string | null;
    endsAt?: string | null;
    featured?: boolean;
    bannerUrl?: string;
    mobileBannerUrl?: string;
    registrationLimit?: number | null;
    cancellationReason?: string;
    events?: CompetitionEventPayload[];
  },
): Promise<{ id: string; title: string; status: string }> {
  return sendJson("PATCH", `/api/v1/admin/competitions/${id}`, body);
}

export function duplicateCompetition(
  id: string,
  body: { reuseScrambles?: boolean; type?: string; copySchedule?: boolean },
): Promise<{ id: string; title: string }> {
  return sendJson("POST", `/api/v1/admin/competitions/${id}/duplicate`, body);
}

export function createPracticeEvent(
  id: string,
  body: { startsAt?: string; endsAt?: string },
): Promise<{ id: string; title: string; participantsCopied: number }> {
  return sendJson("POST", `/api/v1/admin/competitions/${id}/practice`, body);
}

export interface AdminParticipantEntry {
  registrationId: string;
  userId: string;
  clId: string;
  name: string;
  email: string;
  mobileNo: string | null;
  city: string | null;
  country: string | null;
  eventTypes: string[];
  /** Whether the registration still stands — separate from whether money arrived. */
  status: "active" | "withdrawn" | "removed";
  paymentStatus: string;
  paymentAmount: number;
  paymentId: string | null;
  paymentCurrency: string | null;
  razorpayOrderId: string | null;
  razorpayPaymentId: string | null;
  paymentCreatedAt: string | null;
  registeredAt: string;
}

export function fetchAdminParticipants(compId: string): Promise<{
  count: number;
  participants: AdminParticipantEntry[];
}> {
  return getJson(`/api/v1/admin/competitions/${compId}/participants`);
}

export interface CompetitionScrambles {
  competitionId: string;
  status: string;
  events: Array<{
    eventType: string;
    rounds: Array<{
      roundId: string;
      roundNumber: number;
      status: string;
      scrambles: string[];
      locked: boolean;
      generatedAt?: string;
      hasResults: boolean;
    }>;
  }>;
}

export function fetchCompetitionScrambles(id: string): Promise<CompetitionScrambles> {
  return getJson(`/api/v1/admin/competitions/${id}/scrambles`);
}

export function fetchRoundScrambles(
  roundId: string,
): Promise<{ roundId: string; scrambles: string[]; locked: boolean; generatedAt?: string; lockedAt?: string }> {
  return getJson(`/api/v1/admin/rounds/${roundId}/scrambles`);
}

export async function regenerateRoundScrambles(roundId: string): Promise<{ roundId: string; scrambles: string[]; generatedAt: string }> {
  return sendJson("POST", `/api/v1/admin/rounds/${roundId}/regenerate-scrambles`, {});
}

/**
 * Upload an image, surfacing the server's error code rather than a bare status.
 *
 * These used to throw `Upload failed: 413`, discarding the reason the server had
 * already given — an admin picking a 6 MB photo was told nothing about size. The
 * code is rethrown so `friendlyError` can turn it into a sentence.
 */
async function uploadImage<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append("image", file);
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
  if (!res.ok) {
    let code = `${res.status}`;
    try {
      const body = await res.json();
      if (typeof body?.error === "string") code = body.error;
    } catch {
      // Non-JSON body (a proxy error page, say) — the status is all we have.
    }
    throw new Error(code);
  }
  return res.json();
}

export function uploadCompetitionBanner(id: string, file: File): Promise<{ bannerUrl: string }> {
  return uploadImage(`/api/v1/admin/competitions/${id}/upload-banner`, file);
}

export function uploadCompetitionMobileBanner(id: string, file: File): Promise<{ mobileBannerUrl: string }> {
  return uploadImage(`/api/v1/admin/competitions/${id}/upload-mobile-banner`, file);
}

export function cancelRound(roundId: string): Promise<{ id: string; status: string }> {
  return sendJson("POST", `/api/v1/admin/rounds/${roundId}/cancel`);
}

export function updateRound(
  roundId: string,
  body: {
    opensAt?: string | null;
    closesAt?: string | null;
    advancementCount?: number;
    advancementCriteria?: AdvancementCriteria | null;
    durationMinutes?: number;
    /** WCA format code — decides the round's attempt count and ranking metric. */
    format?: WcaFormat;
    cutoffMs?: number | null;
    timeLimitMs?: number | null;
  },
): Promise<{ id: string; status: string; opensAt: string | null; closesAt: string | null; durationMinutes?: number; format?: WcaFormat | null }> {
  return sendJson("PATCH", `/api/v1/admin/rounds/${roundId}`, body);
}

export function updateCompetitionEvent(
  eventId: string,
  body: {
    fee?: number | null;
    cutoffMs?: number | null;
    timeLimitMs?: number | null;
    roundCount?: number;
    archived?: boolean;
  },
): Promise<{ id: string; eventType: string; fee: number | null; archived?: boolean }> {
  return sendJson("PATCH", `/api/v1/admin/competition-events/${eventId}`, body);
}

export async function deleteCompetitionEvent(eventId: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/v1/admin/competition-events/${eventId}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
}

export function fetchVerificationQueue(
  competitionId: string,
): Promise<FlaggedResultDto[]> {
  return getJson<FlaggedResultDto[]>(`/api/v1/admin/competitions/${competitionId}/queue`);
}

export function verifyResult(
  resultId: string,
  action: string,
  reason?: string,
  comment?: string,
  /** Per-attempt penalties, parallel to the result's solves. null = unchanged. */
  solvePenalties?: (SolvePenalty | null)[],
): Promise<{ id: string; flagStatus: string }> {
  return sendJson("POST", `/api/v1/admin/results/${resultId}/verify`, {
    action,
    reason,
    comment,
    solvePenalties,
  });
}

// ── Admin: users ──────────────────────────────────────────────────────────────

export interface AdminUserDto extends AuthUser {
  dob?: string;
  mobileNo?: string;
  accountStage: string;
  createdAt: string;
}

export async function fetchAdminUsers(params?: {
  search?: string;
  role?: string;
  stage?: string;
  competitionId?: string;
  limit?: number;
}): Promise<AdminUserDto[]> {
  const qs = new URLSearchParams(
    Object.entries(params ?? {}).filter(([, v]) => v) as [string, string][],
  ).toString();
  const res = await getJson<{ data: AdminUserDto[] } | AdminUserDto[]>(`/api/v1/admin/users${qs ? `?${qs}` : ""}`);
  return Array.isArray(res) ? res : res.data;
}

export function updateAdminUser(
  id: string,
  body: { role?: string; accountStage?: string; name?: string; email?: string; mobileNo?: string },
): Promise<AdminUserDto> {
  return sendJson("PATCH", `/api/v1/admin/users/${id}`, body);
}

export async function deleteAdminUser(id: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/v1/admin/users/${id}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
}

export async function deleteCompetition(id: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/v1/admin/competitions/${id}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const msg = body?.error === "cancel_before_deleting"
      ? "Cancel the competition before deleting it"
      : body?.error === "competition_has_registrations"
        ? "Cannot delete — competition has registrations (draft)"
        : `Delete failed: ${res.status}`;
    throw new Error(msg);
  }
}

export async function deleteMyAccount(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/v1/me`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
}

// ── Admin: payments ───────────────────────────────────────────────────────────

export interface AdminPaymentDto {
  id: string;
  userId: string;
  registrationId: string;
  amount: number;
  currency: string;
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  status: string;
  createdAt: string;
  userName: string;
  userClId: string;
  userEmail: string;
  competitionTitle: string;
}

export async function fetchAdminPayments(params?: { status?: string; competitionId?: string }): Promise<AdminPaymentDto[]> {
  const qs = new URLSearchParams(
    Object.entries(params ?? {}).filter(([, v]) => v) as [string, string][],
  ).toString();
  const res = await getJson<{ data: AdminPaymentDto[] } | AdminPaymentDto[]>(`/api/v1/admin/payments${qs ? `?${qs}` : ""}`);
  return Array.isArray(res) ? res : res.data;
}

export function confirmPayment(paymentId: string, reason?: string): Promise<{ status: string; paymentId: string }> {
  return sendJson("POST", `/api/v1/admin/payments/${paymentId}/confirm`, { reason });
}

// ── Admin: announcements ──────────────────────────────────────────────────────

export interface AnnouncementDto {
  id: string;
  title: string;
  bodyMd: string;
  imageUrl?: string;
  redirectUrl?: string;
  pinned: boolean;
  published: boolean;
  createdAt: string;
  updatedAt: string;
}

export function fetchPublicAnnouncements(): Promise<AnnouncementDto[]> {
  return getJson<AnnouncementDto[]>(`/api/v1/announcements`);
}

export function fetchAdminAnnouncements(): Promise<AnnouncementDto[]> {
  return getJson<AnnouncementDto[]>(`/api/v1/admin/announcements`);
}

export function createAnnouncement(body: {
  title: string;
  bodyMd: string;
  imageUrl?: string;
  redirectUrl?: string;
  pinned?: boolean;
  published?: boolean;
}): Promise<AnnouncementDto> {
  return sendJson("POST", `/api/v1/admin/announcements`, body);
}

export function updateAnnouncement(
  id: string,
  body: { title?: string; bodyMd?: string; imageUrl?: string; redirectUrl?: string; pinned?: boolean; published?: boolean },
): Promise<AnnouncementDto> {
  return sendJson("PATCH", `/api/v1/admin/announcements/${id}`, body);
}

export async function deleteAnnouncement(id: string): Promise<void> {
  const res = await fetch(`${typeof window !== "undefined" ? "" : ""}${BASE_URL}/api/v1/admin/announcements/${id}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Delete announcement failed: ${res.status}`);
}

export async function uploadAnnouncementImage(id: string, file: File): Promise<AnnouncementDto> {
  const form = new FormData();
  form.append("image", file);
  const res = await fetch(`${BASE_URL}/api/v1/admin/announcements/${id}/upload-image`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  return res.json();
}

// ── Admin: promo codes ───────────────────────────────────────────────────

export type PromoCodeType = "competition" | "welcome" | "general" | "special";

export interface PromoCodeDto {
  id: string;
  code: string;
  type: PromoCodeType;
  discountType: "percentage" | "flat";
  discountValue: number;
  maxUses: number;
  maxUsesPerUser: number;
  usedCount: number;
  competitionId?: string;
  competitionEventId?: string;
  validFrom?: string;
  validTo?: string;
  active: boolean;
  createdAt: string;
}

export function fetchPromoCodes(): Promise<PromoCodeDto[]> {
  return getJson<PromoCodeDto[]>(`/api/v1/admin/promo-codes`);
}

export function createPromoCode(body: {
  code: string;
  type?: PromoCodeType;
  discountType: "percentage" | "flat";
  discountValue: number;
  maxUses?: number;
  maxUsesPerUser?: number;
  competitionId?: string;
  competitionEventId?: string;
  validFrom?: string;
  validTo?: string;
}): Promise<PromoCodeDto> {
  return sendJson("POST", `/api/v1/admin/promo-codes`, body);
}

export function updatePromoCode(
  id: string,
  body: Partial<Pick<PromoCodeDto, "code" | "type" | "discountType" | "discountValue" | "maxUses" | "competitionId" | "competitionEventId" | "validFrom" | "validTo" | "active">>,
): Promise<PromoCodeDto> {
  return sendJson("PATCH", `/api/v1/admin/promo-codes/${id}`, body);
}

export async function deletePromoCode(id: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/v1/admin/promo-codes/${id}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
}

export function validatePromoCode(
  code: string,
  competitionId?: string,
  eventIds?: string[],
): Promise<{ valid: boolean; code: string; discountType: string; discountValue: number; competitionEventId?: string }> {
  return sendJson("POST", `/api/v1/promo/validate`, { code, competitionId, eventIds });
}

// ── Admin: migration ──────────────────────────────────────────────────────────

export interface MigrationStats {
  totalUsers: number;
  activeUsers: number;
  unclaimedStubs: number;
  stubs: Array<{ id: string; clId: string; name: string; email: string; createdAt: string }>;
}

export function fetchMigrationStats(): Promise<MigrationStats> {
  return getJson<MigrationStats>(`/api/v1/admin/migration/stats`);
}

export function sendBulkEmail(
  compId: string,
  body: {
    subject: string;
    bodyHtml: string;
    recipients?: Array<{ email: string; name: string }>;
  },
): Promise<{ sent: boolean; message: string; recipientCount: number; recipients: string[] }> {
  return sendJson("POST", `/api/v1/admin/competitions/${compId}/email`, body);
}

export async function downloadCsvCertificates(
  compId: string,
  winners: Array<{
    name: string;
    clId?: string;
    event?: string;
    rank?: number;
    bestSingle?: string;
    average?: string;
  }>,
): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/v1/admin/competitions/${compId}/certificates/csv`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ winners }),
  });
  if (!res.ok) throw new Error(`CSV certificate generation failed: ${res.status}`);
  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const match = disposition.match(/filename="?([^"]+)"?/);
  const filename = match?.[1] ?? "custom_certificates.zip";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export async function downloadCertificatesZip(compId: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/v1/admin/competitions/${compId}/certificates`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Certificate generation failed: ${res.status}`);
  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const match = disposition.match(/filename="?([^"]+)"?/);
  const filename = match?.[1] ?? "certificates.zip";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export async function exportCompetitionCSV(compId: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/v1/admin/competitions/${compId}/export`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Export failed: ${res.status}`);
  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const match = disposition.match(/filename="?([^"]+)"?/);
  const filename = match?.[1] ?? "results.csv";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Appeals ──────────────────────────────────────────────────────────────

export interface AppealDto {
  id: string;
  resultId: string;
  userId: string;
  reason: string;
  status: "pending" | "accepted" | "rejected";
  adminResponse?: string;
  resolvedBy?: string;
  resolvedByName?: string;
  createdAt: string;
  resolvedAt?: string;
  userName?: string;
  userClId?: string;
  flagStatus?: string;
  competitionId?: string;
  competitionName?: string;
  eventType?: string;
  roundNumber?: number;
  solves?: Array<{ time_ms: number; penalty: string; inspectionPenalty?: string }>;
  ao5Ms?: number | null;
  bestSingleMs?: number | null;
  videoUrl?: string | null;
}

export async function submitAppeal(resultId: string, reason: string): Promise<AppealDto> {
  const res = await fetch(`${BASE_URL}/api/v1/appeals`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ resultId, reason }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error ?? `Appeal failed: ${res.status}`);
  }
  return res.json();
}

export async function fetchMyAppeals(): Promise<AppealDto[]> {
  const res = await fetch(`${BASE_URL}/api/v1/me/appeals`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Fetch appeals failed: ${res.status}`);
  return res.json();
}

export async function fetchAllAppeals(): Promise<AppealDto[]> {
  const res = await fetch(`${BASE_URL}/api/v1/admin/appeals`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Fetch appeals failed: ${res.status}`);
  const json = await res.json();
  return Array.isArray(json) ? json : json.data;
}

export async function resolveAppeal(
  id: string,
  action: "accepted" | "rejected",
  adminResponse?: string,
): Promise<AppealDto> {
  const res = await fetch(`${BASE_URL}/api/v1/admin/appeals/${id}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ action, adminResponse }),
  });
  if (!res.ok) throw new Error(`Resolve failed: ${res.status}`);
  return res.json();
}

// ── Withdrawal requests ─────────────────────────────────────────────────
//
// Deliberately the same shape as appeals: a competitor asks, an admin decides.

export interface WithdrawalRequestDto {
  id: string;
  registrationId: string;
  userId: string;
  reason: string;
  status: "pending" | "approved" | "rejected";
  adminResponse?: string;
  resolvedByName?: string;
  createdAt: string;
  resolvedAt?: string;

  competitionId: string | null;
  competitionTitle: string;
  registrationStatus: string | null;

  // Admin listing only.
  userName?: string;
  userClId?: string;
  userEmail?: string;
  competitionType?: string | null;
  registeredAt?: string | null;
  eventTypes?: string[];
  paymentId?: string | null;
  paymentStatus?: string | null;
  paymentAmount?: number;
  paymentCurrency?: string | null;
  razorpayOrderId?: string | null;
  razorpayPaymentId?: string | null;
  paymentCreatedAt?: string | null;
}

/** Leave a free competition outright. Paid ones go through a request. */
export function withdrawRegistration(regId: string): Promise<{ ok: boolean; status: string }> {
  return sendJson("DELETE", `/api/v1/registrations/${regId}`);
}

export function requestWithdrawal(
  registrationId: string,
  reason: string,
): Promise<WithdrawalRequestDto> {
  return sendJson("POST", "/api/v1/withdrawal-requests", { registrationId, reason });
}

export function fetchMyWithdrawalRequests(): Promise<WithdrawalRequestDto[]> {
  return getJson("/api/v1/me/withdrawal-requests");
}

export async function fetchAllWithdrawalRequests(): Promise<WithdrawalRequestDto[]> {
  const json = await getJson<WithdrawalRequestDto[] | { data: WithdrawalRequestDto[] }>(
    "/api/v1/admin/withdrawal-requests",
  );
  return Array.isArray(json) ? json : json.data;
}

export function resolveWithdrawalRequest(
  id: string,
  action: "approved" | "rejected",
  adminResponse?: string,
): Promise<WithdrawalRequestDto> {
  return sendJson("POST", `/api/v1/admin/withdrawal-requests/${id}/resolve`, {
    action,
    adminResponse,
  });
}

/** Organiser removing someone from a competition. */
export function removeParticipant(
  competitionId: string,
  regId: string,
  reason?: string,
): Promise<{ ok: boolean; status: string }> {
  return sendJson(
    "DELETE",
    `/api/v1/admin/competitions/${competitionId}/registrations/${regId}`,
    { reason },
  );
}

// ── WCA verification queue ──────────────────────────────────────────────

export interface WcaQueueUser {
  id: string;
  clId: string;
  name: string;
  email: string;
  wcaId: string;
  wcaVerified: boolean;
}

export async function fetchWcaQueue(): Promise<WcaQueueUser[]> {
  const res = await fetch(`${BASE_URL}/api/v1/admin/wca-queue`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Fetch WCA queue failed: ${res.status}`);
  return res.json();
}

export async function resolveWcaVerification(
  userId: string,
  action: "verify" | "reject",
): Promise<{ id: string; wcaId?: string; wcaVerified: boolean }> {
  const res = await fetch(`${BASE_URL}/api/v1/admin/wca-queue/${userId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ action }),
  });
  if (!res.ok) throw new Error(`WCA action failed: ${res.status}`);
  return res.json();
}

// ── Rank tiers ──────────────────────────────────────────────────────────

export interface RankTierDto {
  id: string;
  name: string;
  eventType: string;
  maxAo5Ms: number;
  color: string;
  createdAt: string;
}

export async function fetchRankTiers(): Promise<RankTierDto[]> {
  const res = await fetch(`${BASE_URL}/api/v1/admin/rank-tiers`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Fetch rank tiers failed: ${res.status}`);
  return res.json();
}

export async function createRankTier(
  data: { name: string; eventType: string; maxAo5Ms: number; color: string },
): Promise<RankTierDto> {
  const res = await fetch(`${BASE_URL}/api/v1/admin/rank-tiers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Create tier failed: ${res.status}`);
  return res.json();
}

export async function updateRankTier(
  id: string,
  fields: Partial<Pick<RankTierDto, "name" | "maxAo5Ms" | "color">>,
): Promise<RankTierDto> {
  const res = await fetch(`${BASE_URL}/api/v1/admin/rank-tiers/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(fields),
  });
  if (!res.ok) throw new Error(`Update tier failed: ${res.status}`);
  return res.json();
}

export async function deleteRankTier(id: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/v1/admin/rank-tiers/${id}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Delete tier failed: ${res.status}`);
}

// ── Account merge ───────────────────────────────────────────────────────

export interface MergeResult {
  kept: { id: string; clId: string; name: string };
  merged: { id: string; clId: string; name: string };
  movedRegistrations: number;
  movedResults: number;
}

export async function mergeAccounts(keepUserId: string, mergeUserId: string): Promise<MergeResult> {
  const res = await fetch(`${BASE_URL}/api/v1/admin/merge-accounts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ keepUserId, mergeUserId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error ?? `Merge failed: ${res.status}`);
  }
  return res.json();
}

// ── Round notifications ─────────────────────────────────────────────────

export async function sendRoundNotification(
  roundId: string,
): Promise<{ sent: boolean; message: string; recipientCount: number }> {
  const res = await fetch(`${BASE_URL}/api/v1/admin/rounds/${roundId}/notify`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Notify failed: ${res.status}`);
  return res.json();
}

export function updateResultVideo(
  resultId: string,
  videoUrl: string,
): Promise<{ ok: boolean; videoUrl: string }> {
  return sendJson("PATCH", `/api/v1/results/${resultId}/video`, { videoUrl });
}

export async function publishRoundResults(
  roundId: string,
): Promise<{ sent: boolean; recipientCount: number; sentCount: number; eventCompleted: boolean; competitionCompleted: boolean }> {
  const res = await fetch(`${BASE_URL}/api/v1/admin/rounds/${roundId}/publish`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Publish failed: ${res.status}`);
  return res.json();
}

// ── Avatar upload ───────────────────────────────────────────────────────

export async function uploadAvatar(file: File): Promise<{ avatarUrl: string }> {
  const form = new FormData();
  form.append("avatar", file);
  const res = await fetch(`${BASE_URL}/api/v1/users/me/avatar`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  return res.json();
}

// ── Invoice download ────────────────────────────────────────────────────

export async function downloadInvoice(paymentId: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/v1/payments/${paymentId}/invoice`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Invoice download failed: ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `invoice-${paymentId}.pdf`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Rankings ────────────────────────────────────────────────────────────────

export interface RankingEntry {
  userId: string;
  clId: string;
  name: string;
  eventType: string;
  bestSingleMs: number | null;
  bestAo5Ms: number | null;
}

export async function fetchRankings(event?: string): Promise<RankingEntry[]> {
  const qs = event ? `?event=${encodeURIComponent(event)}` : "";
  const res = await getJson<{ rankings: RankingEntry[] }>(`/api/v1/rankings${qs}`);
  return res.rankings;
}

// ── Banners ──────────────────────────────────────────────────────────────

export interface BannerDto {
  id: string;
  title: string;
  imageUrl?: string;
  mobileImageUrl?: string;
  ctaText?: string;
  ctaLink?: string;
  linkUrl?: string;
  expiresAt?: string;
  active: boolean;
  order: number;
  createdAt: string;
}

export function fetchAdminBanners(): Promise<BannerDto[]> {
  return getJson<BannerDto[]>(`/api/v1/admin/banners`);
}

export function fetchPublicBanners(): Promise<BannerDto[]> {
  return getJson<BannerDto[]>(`/api/v1/banners`);
}

export function createBanner(body: {
  title: string;
  imageUrl?: string;
  mobileImageUrl?: string;
  ctaText?: string;
  ctaLink?: string;
  linkUrl?: string;
  expiresAt?: string;
  active?: boolean;
  order?: number;
}): Promise<BannerDto> {
  return sendJson("POST", `/api/v1/admin/banners`, body);
}

export function updateBanner(
  id: string,
  body: Partial<Pick<BannerDto, "title" | "imageUrl" | "mobileImageUrl" | "ctaText" | "ctaLink" | "linkUrl" | "expiresAt" | "active" | "order">>,
): Promise<BannerDto> {
  return sendJson("PATCH", `/api/v1/admin/banners/${id}`, body);
}

export async function uploadBannerImage(id: string, file: File): Promise<BannerDto> {
  const form = new FormData();
  form.append("image", file);
  const res = await fetch(`${BASE_URL}/api/v1/admin/banners/${id}/upload-image`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  return res.json();
}

export async function uploadBannerMobileImage(id: string, file: File): Promise<BannerDto> {
  const form = new FormData();
  form.append("image", file);
  const res = await fetch(`${BASE_URL}/api/v1/admin/banners/${id}/upload-mobile-image`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  return res.json();
}

export async function deleteBanner(id: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/v1/admin/banners/${id}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Delete banner failed: ${res.status}`);
}

// ── FAQ ──────────────────────────────────────────────────────────────────

export interface FaqDto {
  id: string;
  question: string;
  answerMd: string;
  order: number;
  published: boolean;
  createdAt: string;
}

export function fetchAdminFaq(): Promise<FaqDto[]> {
  return getJson<FaqDto[]>(`/api/v1/admin/faq`);
}

export function fetchPublicFaq(): Promise<FaqDto[]> {
  return getJson<FaqDto[]>(`/api/v1/faq`);
}

export function createFaq(body: {
  question: string;
  answerMd: string;
  order?: number;
  published?: boolean;
}): Promise<FaqDto> {
  return sendJson("POST", `/api/v1/admin/faq`, body);
}

export function updateFaq(
  id: string,
  body: Partial<Pick<FaqDto, "question" | "answerMd" | "order" | "published">>,
): Promise<FaqDto> {
  return sendJson("PATCH", `/api/v1/admin/faq/${id}`, body);
}

export async function deleteFaq(id: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/v1/admin/faq/${id}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Delete FAQ failed: ${res.status}`);
}

// ── Content Pages ──────────────────────────────────────────────────────

export interface ContentPageDto {
  id: string;
  slug: string;
  title: string;
  bodyMd: string;
  published: boolean;
  updatedAt: string;
  createdAt: string;
}

export function fetchAdminContentPages(): Promise<ContentPageDto[]> {
  return getJson<ContentPageDto[]>(`/api/v1/admin/content-pages`);
}

export function fetchPublicPage(slug: string): Promise<{ slug: string; title: string; bodyMd: string }> {
  return getJson(`/api/v1/pages/${slug}`);
}

export function createContentPage(body: {
  slug: string;
  title: string;
  bodyMd?: string;
  published?: boolean;
}): Promise<ContentPageDto> {
  return sendJson("POST", `/api/v1/admin/content-pages`, body);
}

export function updateContentPage(
  id: string,
  body: Partial<Pick<ContentPageDto, "slug" | "title" | "bodyMd" | "published">>,
): Promise<ContentPageDto> {
  return sendJson("PATCH", `/api/v1/admin/content-pages/${id}`, body);
}

export async function deleteContentPage(id: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/v1/admin/content-pages/${id}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Delete content page failed: ${res.status}`);
}

// ── Staff creation ──────────────────────────────────────────────────────

export function createStaff(body: {
  email: string;
  name: string;
  role: "judge" | "moderator" | "admin";
}): Promise<{ id: string; clId: string; name: string; email: string; role: string }> {
  return sendJson("POST", `/api/v1/admin/create-staff`, body);
}

// ── Practice Sessions ──────────────────────────────────────────────────

export interface PracticeSessionDto {
  id: string;
  userId: string;
  eventType: string;
  name?: string;
  createdAt: string;
  endedAt?: string;
  solveCount?: number;
}

export interface PracticeSolveDto {
  id: string;
  sessionId: string;
  timeMs: number;
  scramble: string;
  penalty: "none" | "plus2" | "dnf";
  note?: string;
  createdAt: string;
}

export async function fetchPracticeSessions(): Promise<PracticeSessionDto[]> {
  const res = await fetch(`${BASE_URL}/api/v1/practice/sessions`, { headers: authHeaders() });
  if (!res.ok) return [];
  const data = await res.json();
  return data.sessions ?? [];
}

export async function createPracticeSession(eventType: string, name?: string): Promise<PracticeSessionDto> {
  const data = await sendJson<{ session: PracticeSessionDto }>("POST", "/api/v1/practice/sessions", { eventType, name });
  return data.session;
}

export async function fetchPracticeSession(id: string): Promise<{ session: PracticeSessionDto; solves: PracticeSolveDto[] }> {
  const res = await fetch(`${BASE_URL}/api/v1/practice/sessions/${id}`, { headers: authHeaders() });
  if (!res.ok) throw new Error("Session not found");
  return res.json();
}

export async function updatePracticeSession(id: string, name: string): Promise<PracticeSessionDto> {
  const data = await sendJson<{ session: PracticeSessionDto }>("PATCH", `/api/v1/practice/sessions/${id}`, { name });
  return data.session;
}

export async function deletePracticeSession(id: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/v1/practice/sessions/${id}`, { method: "DELETE", headers: authHeaders() });
  if (!res.ok) throw new Error(`Delete session failed: ${res.status}`);
}

export async function endPracticeSession(id: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/v1/practice/sessions/${id}/end`, { method: "POST", headers: authHeaders() });
  if (!res.ok) throw new Error(`End session failed: ${res.status}`);
}

export async function addPracticeSolve(sessionId: string, body: {
  timeMs: number; scramble: string; penalty?: string; note?: string;
}): Promise<PracticeSolveDto> {
  const data = await sendJson<{ solve: PracticeSolveDto }>("POST", `/api/v1/practice/sessions/${sessionId}/solves`, body);
  return data.solve;
}

export async function deletePracticeSolve(id: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/v1/practice/solves/${id}`, { method: "DELETE", headers: authHeaders() });
  if (!res.ok) throw new Error(`Delete solve failed: ${res.status}`);
}

// ── Practice Stats ─────────────────────────────────────────────────────

export interface PracticeStatsDto {
  totalSessions: number;
  totalSolves: number;
  totalTimeMs: number;
  eventBests: Record<string, number>;
}

export async function fetchPracticeStats(): Promise<PracticeStatsDto | null> {
  const res = await fetch(`${BASE_URL}/api/v1/practice/stats`, { headers: authHeaders() });
  if (!res.ok) return null;
  const data = await res.json();
  return data.stats ?? null;
}

// ── Daily Challenge ────────────────────────────────────────────────────

export interface DailyChallengeDto {
  id: string;
  date: string;
  eventType: string;
  scramble: string;
}

export interface DailyChallengeResultDto {
  id: string;
  challengeId: string;
  userId: string;
  timeMs: number;
  submittedAt: string;
  clId?: string;
  name?: string;
}

export interface DailyChallengeResponse {
  challenge: DailyChallengeDto;
  userResult: DailyChallengeResultDto | null;
  streak: number;
  leaderboard: DailyChallengeResultDto[];
}

export async function fetchDailyChallenge(): Promise<DailyChallengeResponse> {
  const res = await fetch(`${BASE_URL}/api/v1/daily-challenge`, { headers: authHeaders() });
  if (!res.ok) throw new Error("Failed to fetch daily challenge");
  return res.json();
}

export async function submitDailyChallenge(timeMs: number, penalty?: string): Promise<{ result: DailyChallengeResultDto; streak: number }> {
  return sendJson<{ result: DailyChallengeResultDto; streak: number }>("POST", "/api/v1/daily-challenge/submit", { timeMs, penalty });
}

// ── Verification management ──────────────────────────────────────────────────

export interface FlagReasonDto {
  type: string;
  message: string;
  severity: number;
}

export interface VerificationResultDto {
  id: string;
  userId: string;
  userName: string;
  userClId: string;
  eventType: string;
  roundNumber: number;
  solves: Solve[];
  bestSingleMs: number | null;
  ao5Ms: number | null;
  videoUrl: string | null;
  flagStatus: string;
  flagReasons: FlagReasonDto[];
  /** §7 priority score — higher = more urgent to review. */
  priority: number;
  verifiedBy: string | null;
  verifiedByName?: string | null;
  verifiedAt: string | null;
  verificationComment?: string | null;
  submittedAt: string;
  rank: number | null;
}

export interface JudgeAssignmentDto {
  id: string;
  judgeId: string;
  judgeName: string;
  judgeClId: string;
  assignedAt: string;
  verifiedCount: number;
  totalResults: number;
}

export interface AvailableJudgeDto {
  id: string;
  name: string;
  clId: string;
  role: string;
}

export function fetchRoundResults(roundId: string): Promise<VerificationResultDto[]> {
  return getJson<VerificationResultDto[]>(`/api/v1/admin/verification/rounds/${roundId}/results`);
}

export function fetchRoundJudges(roundId: string): Promise<JudgeAssignmentDto[]> {
  return getJson<JudgeAssignmentDto[]>(`/api/v1/admin/verification/rounds/${roundId}/judges`);
}

export function fetchAvailableJudges(): Promise<AvailableJudgeDto[]> {
  return getJson<AvailableJudgeDto[]>("/api/v1/admin/verification/judges");
}

export function assignJudge(judgeId: string, roundId: string): Promise<{ id: string }> {
  return sendJson("POST", "/api/v1/admin/verification/assign", { judgeId, roundId });
}

export function unassignJudge(assignmentId: string): Promise<{ ok: boolean }> {
  return sendJson("DELETE", `/api/v1/admin/verification/assign/${assignmentId}`, {});
}

// ── Judge panel ──────────────────────────────────────────────────────────────

export interface JudgeRoundDto {
  id: string;
  roundId: string;
  roundNumber: number | null;
  roundStatus: string;
  eventType: string;
  competitionId: string | null;
  competitionTitle: string;
  assignedAt: string;
  totalResults: number;
  verifiedCount: number;
}

export function fetchJudgeAssignments(): Promise<JudgeRoundDto[]> {
  return getJson<JudgeRoundDto[]>("/api/v1/judge/assignments");
}

export function fetchJudgeRoundResults(roundId: string): Promise<VerificationResultDto[]> {
  return getJson<VerificationResultDto[]>(`/api/v1/judge/rounds/${roundId}/results`);
}

export function fetchJudgeRoundScrambles(
  roundId: string,
): Promise<{ roundId: string; scrambles: string[]; locked: boolean; generatedAt?: string; lockedAt?: string }> {
  return getJson(`/api/v1/judge/rounds/${roundId}/scrambles`);
}

export function judgeVerifyResult(
  resultId: string,
  action: string,
  reason?: string,
  comment?: string,
  /** Per-attempt penalties, parallel to the result's solves. null = unchanged. */
  solvePenalties?: (SolvePenalty | null)[],
): Promise<{ id: string; flagStatus: string }> {
  return sendJson("POST", `/api/v1/judge/results/${resultId}/verify`, {
    action,
    reason,
    comment,
    solvePenalties,
  });
}

// ── Verification Hub (§1) ────────────────────────────────────────────────────

export interface HubRoundStats {
  total: number;
  flagged: number;
  verified: number;
  clean: number;
}

export interface HubRoundJudge {
  judgeId: string;
  judgeName: string;
  judgeClId: string;
}

export interface HubRound {
  id: string;
  roundNumber: number;
  status: string;
  videoRequired: boolean;
  resultsPublishedAt: string | null;
  stats: HubRoundStats;
  verificationStatus: "complete" | "has_flagged" | "in_progress" | "empty";
  judges: HubRoundJudge[];
}

export interface HubEvent {
  eventType: string;
  competitionEventId: string;
  rounds: HubRound[];
}

export interface VerificationHubDto {
  competition: { id: string; title: string; status: string };
  events: HubEvent[];
}

export function fetchVerificationHub(compId: string): Promise<VerificationHubDto> {
  return getJson<VerificationHubDto>(`/api/v1/admin/verification/hub?compId=${compId}`);
}

export interface HubOverviewComp {
  id: string;
  title: string;
  status: string;
  startsAt: string | null;
  endsAt: string | null;
  bannerUrl: string | null;
  mobileBannerUrl: string | null;
  registrationCount: number;
  roundCount: number;
  eventCount: number;
  stats: { total: number; verified: number; flagged: number; clean: number };
  verificationStatus: "complete" | "needs_review" | "in_progress" | "empty";
}

export function fetchVerificationOverview(): Promise<{ competitions: HubOverviewComp[] }> {
  return getJson<{ competitions: HubOverviewComp[] }>("/api/v1/admin/verification/hub/overview");
}

export function updateVideoRequired(roundId: string, videoRequired: boolean): Promise<{ id: string; videoRequired: boolean }> {
  return sendJson("PATCH", `/api/v1/rounds/${roundId}/video-required`, { videoRequired });
}

/** §6 — Re-run flag engine on all unverified results in a round. */
export function reflagRound(roundId: string): Promise<{ roundId: string; totalResults: number; updated: number }> {
  return sendJson("POST", `/api/v1/admin/verification/rounds/${roundId}/reflag`, {});
}

/** §8 — Bulk verify multiple results at once. */
export function bulkVerify(
  resultIds: string[],
  action: string,
  reason?: string,
  comment?: string,
): Promise<{ updated: number; previousStates: { id: string; flagStatus: string }[] }> {
  return sendJson("POST", "/api/v1/admin/verification/bulk-verify", { resultIds, action, reason, comment });
}

/** §8 — Undo a bulk action by restoring previous states. */
export function bulkUndo(
  restorations: { id: string; flagStatus: string }[],
): Promise<{ restored: number }> {
  return sendJson("POST", "/api/v1/admin/verification/bulk-undo", { restorations });
}

/** §10 — Get audit trail for a specific result. */
export interface AuditTrailEntry {
  id: string;
  action: string;
  adminName: string;
  reason: string | null;
  oldValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
  createdAt: string;
}

export function fetchResultAudit(resultId: string): Promise<AuditTrailEntry[]> {
  return getJson<AuditTrailEntry[]>(`/api/v1/admin/verification/results/${resultId}/audit`);
}

// ── System Settings ──────────────────────────────────────────────────────────

export interface SystemSettingsDto {
  eventDurations: Record<string, number>;
  registrationDurationDays: number;
  gapBetweenEventsMinutes: number;
  defaultRoundDurationMinutes: number;
  videoDeadlineMinutes: number;
}

export interface SchedulingDefaults {
  eventDurations: Record<string, number>;
  registrationDurationDays: number;
  gapBetweenEventsMinutes: number;
  defaultRoundDurationMinutes: number;
  /** Global default shown as the placeholder on a competition's own field. */
  videoDeadlineMinutes?: number;
}

export async function fetchSystemSettings(): Promise<SystemSettingsDto> {
  const res = await fetch(`${BASE_URL}/api/v1/admin/settings`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Fetch settings failed: ${res.status}`);
  return res.json();
}

export async function updateSystemSettings(
  fields: Partial<SystemSettingsDto>,
): Promise<SystemSettingsDto> {
  const res = await fetch(`${BASE_URL}/api/v1/admin/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(fields),
  });
  if (!res.ok) throw new Error(`Update settings failed: ${res.status}`);
  return res.json();
}

export async function fetchSchedulingDefaults(): Promise<SchedulingDefaults> {
  const res = await fetch(`${BASE_URL}/api/v1/settings/scheduling`);
  if (!res.ok) throw new Error(`Fetch scheduling defaults failed: ${res.status}`);
  return res.json();
}

// ── Rule Sets ──

export interface RuleSetDto {
  id: string;
  name: string;
  content: string;
  createdAt?: string;
  updatedAt?: string;
}

export function fetchRuleSets(): Promise<RuleSetDto[]> {
  return getJson("/api/v1/rule-sets");
}

export function fetchAdminRuleSets(): Promise<RuleSetDto[]> {
  return getJson("/api/v1/admin/rule-sets");
}

export function createRuleSet(body: { name: string; content: string }): Promise<RuleSetDto> {
  return sendJson("POST", "/api/v1/admin/rule-sets", body);
}

export function updateRuleSet(id: string, body: { name?: string; content?: string }): Promise<RuleSetDto> {
  return sendJson("PATCH", `/api/v1/admin/rule-sets/${id}`, body);
}

export function deleteRuleSet(id: string): Promise<{ ok: boolean }> {
  return sendJson("DELETE", `/api/v1/admin/rule-sets/${id}`);
}
