import type {
  User,
  Competition,
  CompetitionEvent,
  Round,
  ScrambleSet,
  Result,
  ResultSlim,
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
  RankTier,
  Banner,
  FaqEntry,
  ContentPage,
  JudgeAssignment,
  SystemSettings,
  RuleSet,
} from "./types";

export interface Repository {
  users: {
    findAll(search?: string): Promise<User[]>;
    findPaginated(opts: { search?: string; limit: number; offset: number }): Promise<{ rows: User[]; total: number }>;
    findById(id: string): Promise<User | null>;
    findByIds(ids: string[]): Promise<Map<string, User>>;
    findByEmail(email: string): Promise<User | null>;
    findByMobileNo(mobileNo: string): Promise<User | null>;
    findByClId(clId: string): Promise<User | null>;
    create(user: User): Promise<void>;
    update(id: string, fields: Partial<User>): Promise<User | null>;
    /** Stores the Supabase UUID in supabase_id — used to link a local account on first Google login. */
    migrateId(oldId: string, newId: string): Promise<void>;
    /** Look up a user by their Supabase Auth UUID (set on first Google sign-in). */
    findBySupabaseId(supabaseId: string): Promise<User | null>;
    delete(id: string): Promise<void>;
    nextClId(): Promise<string>;
  };

  competitions: {
    findAll(search?: string): Promise<Competition[]>;
    findById(id: string): Promise<Competition | null>;
    findByIds(ids: string[]): Promise<Map<string, Competition>>;
    findByTitle(title: string): Promise<Competition | null>;
    create(comp: Competition): Promise<void>;
    update(id: string, fields: Partial<Competition>): Promise<Competition | null>;
    delete(id: string): Promise<void>;
    countRegistrations(id: string): Promise<number>;
    countRegistrationsBatch(ids: string[]): Promise<Map<string, number>>;
  };

  competitionEvents: {
    findById(id: string): Promise<CompetitionEvent | null>;
    findByCompetition(compId: string): Promise<CompetitionEvent[]>;
    findByCompetitions(compIds: string[]): Promise<Map<string, CompetitionEvent[]>>;
    findByRound(roundId: string): Promise<CompetitionEvent | null>;
    findByRounds(roundIds: string[]): Promise<Map<string, CompetitionEvent>>;
    create(event: CompetitionEvent): Promise<void>;
    update(id: string, fields: Partial<CompetitionEvent>): Promise<CompetitionEvent | null>;
    delete(id: string): Promise<void>;
  };

  rounds: {
    findById(id: string): Promise<Round | null>;
    findAll(): Promise<Round[]>;
    findActive(): Promise<Round[]>;
    findByCompetition(compId: string): Promise<Round[]>;
    create(round: Round): Promise<void>;
    update(id: string, fields: Partial<Round>): Promise<Round | null>;
    delete(id: string): Promise<void>;
    /** Atomic CAS: update status only if current status matches expectedStatus. Returns true if updated. */
    compareAndUpdateStatus(id: string, expectedStatus: string, newStatus: string): Promise<boolean>;
  };

  scrambleSets: {
    findByRound(roundId: string): Promise<ScrambleSet | null>;
    findByRounds(roundIds: string[]): Promise<Map<string, ScrambleSet>>;
    upsert(set: ScrambleSet): Promise<void>;
  };

  results: {
    findById(id: string): Promise<Result | null>;
    findByRound(roundId: string): Promise<Result[]>;
    findByRoundSlim(roundId: string): Promise<ResultSlim[]>;
    findByRounds(roundIds: string[]): Promise<Result[]>;
    /** userId is the user UUID (users.id). */
    findByUser(userId: string): Promise<Result[]>;
    /** Result counts per user, one query (verification queue context). */
    countByUsers(userIds: string[]): Promise<Map<string, number>>;
    create(result: Result): Promise<void>;
    update(id: string, fields: Partial<Result>): Promise<Result | null>;
    updateRanks(rankings: { id: string; rank: number }[]): Promise<void>;
  };

  registrations: {
    findById(id: string): Promise<Registration | null>;
    findByIds(ids: string[]): Promise<Map<string, Registration>>;
    findByUser(userId: string): Promise<Registration[]>;
    findByCompetition(compId: string): Promise<Registration[]>;
    findByUserAndComp(userId: string, compId: string): Promise<Registration | null>;
    create(reg: Registration): Promise<void>;
    update(id: string, fields: Partial<Registration>): Promise<void>;
    delete(id: string): Promise<void>;
    addEvent(registrationId: string, competitionEventId: string): Promise<void>;
    removeEvents(registrationId: string): Promise<void>;
    countEvents(registrationId: string): Promise<number>;
    findEvents(registrationId: string): Promise<CompetitionEvent[]>;
    /** Events for many registrations at once, keyed by registration id. */
    findEventsForAll(registrationIds: string[]): Promise<Map<string, CompetitionEvent[]>>;
    hasPaidRegistration(userId: string): Promise<boolean>;
    isRegisteredForEvent(userId: string, competitionEventId: string): Promise<boolean>;
  };

  payments: {
    findAll(): Promise<Payment[]>;
    findById(id: string): Promise<Payment | null>;
    findByOrderId(orderId: string): Promise<Payment | null>;
    findByRegistration(registrationId: string): Promise<Payment | null>;
    /** Latest payment for each registration, keyed by registration id. */
    findByRegistrationIds(registrationIds: string[]): Promise<Map<string, Payment>>;
    create(payment: Payment): Promise<void>;
    update(id: string, fields: Partial<Payment>): Promise<void>;
  };

  auditLog: {
    findAll(limit?: number, offset?: number): Promise<AuditLogEntry[]>;
    findByAdmin(adminId: string): Promise<AuditLogEntry[]>;
    /** Full verification history for a single result (§10 audit trail). */
    findByTarget(target: string): Promise<AuditLogEntry[]>;
    create(entry: AuditLogEntry): Promise<void>;
  };

  verificationTokens: {
    create(token: { id: string; userId: string; type: string; token: string; identifier?: string; expiresAt: number }): Promise<void>;
    findByToken(token: string, type: string): Promise<{ id: string; userId: string; type: string; token: string; identifier?: string; expiresAt: number } | null>;
    findByIdentifier(identifier: string, type: string): Promise<{ id: string; userId: string; type: string; token: string; identifier?: string; expiresAt: number } | null>;
    delete(id: string): Promise<void>;
    deleteExpired(): Promise<void>;
  };

  announcements: {
    findAll(publishedOnly?: boolean): Promise<Announcement[]>;
    findById(id: string): Promise<Announcement | null>;
    create(a: Announcement): Promise<void>;
    update(id: string, fields: Partial<Announcement>): Promise<Announcement | null>;
    delete(id: string): Promise<void>;
  };

  advancements: {
    /** Store shortlisted participants after a round closes. */
    save(roundId: string, entries: RoundAdvancement[]): Promise<void>;
    /** Check if a user was shortlisted for a given round (used to gate round 2+ entry). */
    isAdvanced(roundId: string, userId: string): Promise<boolean>;
    findByRound(roundId: string): Promise<RoundAdvancement[]>;
    findByRounds(roundIds: string[]): Promise<Map<string, RoundAdvancement[]>>;
  };

  personalBests: {
    findAll(): Promise<PersonalBest[]>;
    findByUser(userId: string): Promise<PersonalBest[]>;
    /**
     * One page of rankable PBs (ao5, falling back to best single, ascending),
     * optionally filtered by event. Pagination happens at the DB level.
     */
    findRanked(
      eventType: string | undefined,
      limit: number,
      offset: number,
    ): Promise<{ rows: PersonalBest[]; total: number }>;
    /** Min-merge: only ever improves stored bests. */
    upsert(pb: PersonalBest): Promise<void>;
    /** Overwrite: used when rebuilding a PB after a judge override. */
    replace(pb: PersonalBest): Promise<void>;
  };

  practice: {
    createSession(session: PracticeSession): Promise<void>;
    findSession(id: string): Promise<PracticeSession | null>;
    findSessionsByUser(userId: string): Promise<PracticeSession[]>;
    updateSession(id: string, fields: Partial<PracticeSession>): Promise<PracticeSession | null>;
    deleteSession(id: string): Promise<void>;
    endSession(id: string): Promise<void>;
    addSolve(solve: PracticeSolve): Promise<void>;
    findSolve(id: string): Promise<PracticeSolve | null>;
    findSolvesBySession(sessionId: string): Promise<PracticeSolve[]>;
    findSolvesBySessionIds(sessionIds: string[]): Promise<PracticeSolve[]>;
    deleteSolve(id: string): Promise<void>;
  };

  dailyChallenge: {
    findByDate(date: string): Promise<DailyChallenge | null>;
    create(challenge: DailyChallenge): Promise<void>;
    submitResult(result: DailyChallengeResult): Promise<void>;
    findResultByUserAndChallenge(userId: string, challengeId: string): Promise<DailyChallengeResult | null>;
    findResultsByChallenge(challengeId: string): Promise<DailyChallengeResult[]>;
    findUserStreak(userId: string): Promise<number>;
  };

  appeals: {
    findAll(): Promise<Appeal[]>;
    findById(id: string): Promise<Appeal | null>;
    findByResult(resultId: string): Promise<Appeal | null>;
    findByUser(userId: string): Promise<Appeal[]>;
    create(appeal: Appeal): Promise<void>;
    update(id: string, fields: Partial<Appeal>): Promise<Appeal | null>;
  };

  rankTiers: {
    findAll(): Promise<RankTier[]>;
    findById(id: string): Promise<RankTier | null>;
    findByEvent(eventType: string): Promise<RankTier[]>;
    create(tier: RankTier): Promise<void>;
    update(id: string, fields: Partial<RankTier>): Promise<RankTier | null>;
    delete(id: string): Promise<void>;
  };

  promoCodes: {
    findAll(): Promise<PromoCode[]>;
    findById(id: string): Promise<PromoCode | null>;
    findByCode(code: string): Promise<PromoCode | null>;
    create(promo: PromoCode): Promise<void>;
    update(id: string, fields: Partial<PromoCode>): Promise<PromoCode | null>;
    delete(id: string): Promise<void>;
    incrementUsed(id: string): Promise<boolean>;
    recordUsage(promoCodeId: string, userId: string): Promise<void>;
    userUsageCount(promoCodeId: string, userId: string): Promise<number>;
  };

  banners: {
    findAll(): Promise<Banner[]>;
    findById(id: string): Promise<Banner | null>;
    create(banner: Banner): Promise<void>;
    update(id: string, fields: Partial<Banner>): Promise<Banner | null>;
    delete(id: string): Promise<void>;
  };

  faq: {
    findAll(publishedOnly?: boolean): Promise<FaqEntry[]>;
    findById(id: string): Promise<FaqEntry | null>;
    create(entry: FaqEntry): Promise<void>;
    update(id: string, fields: Partial<FaqEntry>): Promise<FaqEntry | null>;
    delete(id: string): Promise<void>;
  };

  contentPages: {
    findAll(publishedOnly?: boolean): Promise<ContentPage[]>;
    findBySlug(slug: string): Promise<ContentPage | null>;
    findById(id: string): Promise<ContentPage | null>;
    create(page: ContentPage): Promise<void>;
    update(id: string, fields: Partial<ContentPage>): Promise<ContentPage | null>;
    delete(id: string): Promise<void>;
  };

  judgeAssignments: {
    findByRound(roundId: string): Promise<JudgeAssignment[]>;
    findByJudge(judgeId: string): Promise<JudgeAssignment[]>;
    create(assignment: JudgeAssignment): Promise<void>;
    delete(id: string): Promise<void>;
  };

  ruleSets: {
    findAll(): Promise<RuleSet[]>;
    findById(id: string): Promise<RuleSet | null>;
    create(ruleSet: RuleSet): Promise<void>;
    update(id: string, fields: Partial<RuleSet>): Promise<RuleSet | null>;
    delete(id: string): Promise<void>;
  };

  systemSettings: {
    get(): Promise<SystemSettings>;
    update(fields: Partial<SystemSettings>): Promise<SystemSettings>;
  };

  /** Returns the DB backend name and latency, or null if in-memory. */
  ping(): Promise<{ backend: string; latencyMs: number } | null>;

  /** Ephemeral roster — uses Redis when available, falls back to RAM. */
  roster: {
    join(roundId: string, userId: string, name: string): Promise<void>;
    leave(roundId: string, userId: string): Promise<void>;
    snapshot(roundId: string): Promise<{ userId: string; name: string }[]>;
  };
}
