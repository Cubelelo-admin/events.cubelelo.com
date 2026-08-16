import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every TypeScript union that maps to a Postgres enum must be a subset of it.
 *
 * This exists because the test suite runs on `mem-repo`, which has no enums to
 * violate — so a union could drift from its Postgres type with every test still
 * green, and only fail in production on the one operation that writes the new
 * value. That is exactly what happened: `FlagStatus` gained `plus2` and `dnf`
 * for per-attempt judge verdicts, the `flag_status` enum never did, and every
 * judge verdict of +2 or DNF threw a constraint error against Postgres while the
 * suite stayed green.
 *
 * The check reads the migrations rather than a hand-written list, so it tracks
 * whatever the database actually says.
 */

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(here, "../../../packages/database/migrations");
const TYPES_FILES = [
  join(here, "../../../packages/types/src/index.ts"),
  join(here, "../src/db/types.ts"),
];

/** Enum values per Postgres type name, from CREATE TYPE plus any ALTER TYPE. */
function postgresEnums(): Map<string, Set<string>> {
  const enums = new Map<string, Set<string>>();

  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // numeric prefixes, so lexical order is migration order

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");

    // CREATE TYPE x AS ENUM ('a','b', ...) — the body may span lines.
    const created = sql.matchAll(
      /create\s+type\s+(\w+)\s+as\s+enum\s*\(([\s\S]*?)\)/gi,
    );
    for (const m of created) {
      const name = m[1]!.toLowerCase();
      const values = [...m[2]!.matchAll(/'([^']+)'/g)].map((v) => v[1]!);
      if (!enums.has(name)) enums.set(name, new Set());
      for (const v of values) enums.get(name)!.add(v);
    }

    // ALTER TYPE x ADD VALUE [IF NOT EXISTS] 'c'
    const altered = sql.matchAll(
      /alter\s+type\s+(\w+)\s+add\s+value\s+(?:if\s+not\s+exists\s+)?'([^']+)'/gi,
    );
    for (const m of altered) {
      const name = m[1]!.toLowerCase();
      if (!enums.has(name)) enums.set(name, new Set());
      enums.get(name)!.add(m[2]!);
    }
  }

  return enums;
}

/** String-literal unions per exported type name. */
function typescriptUnions(): Map<string, string[]> {
  const unions = new Map<string, string[]>();

  for (const file of TYPES_FILES) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/export\s+type\s+(\w+)\s*=\s*([^;]+);/g)) {
      const body = m[2]!;
      // Only unions made entirely of string literals separated by |.
      const literals = [...body.matchAll(/"([^"]+)"/g)].map((v) => v[1]!);
      if (literals.length === 0) continue;
      const withoutLiterals = body.replace(/"[^"]+"/g, "").replace(/[|\s]/g, "");
      if (withoutLiterals !== "") continue;
      unions.set(m[1]!, literals);
    }
  }

  return unions;
}

/** TypeScript union → the Postgres enum it is stored in. */
const MAPPING: Record<string, string> = {
  UserRole: "user_role",
  AccountStage: "account_stage",
  CompType: "comp_type",
  RoundStatus: "round_status",
  PaymentStatus: "payment_status",
  SolvePenalty: "solve_penalty",
  FlagStatus: "flag_status",
  RegistrationStatus: "registration_status",
};

describe("TypeScript unions match their Postgres enums", () => {
  const enums = postgresEnums();
  const unions = typescriptUnions();

  it("parses both sides — a silent parse failure would pass everything", () => {
    expect(enums.size).toBeGreaterThan(5);
    expect(unions.size).toBeGreaterThan(5);
    // 032 adds this by ALTER TYPE, so finding it proves both forms are read.
    expect(enums.get("round_status")).toContain("cancelled");
  });

  for (const [typeName, enumName] of Object.entries(MAPPING)) {
    it(`${typeName} ⊆ ${enumName}`, () => {
      const literals = unions.get(typeName);
      const values = enums.get(enumName);

      expect(literals, `no string union named ${typeName}`).toBeDefined();
      expect(values, `no Postgres enum named ${enumName}`).toBeDefined();

      const missing = literals!.filter((l) => !values!.has(l));
      expect(
        missing,
        `${typeName} has ${missing.map((m) => `"${m}"`).join(", ")} which ${enumName} ` +
          `does not accept — writing one throws a constraint error against Postgres`,
      ).toEqual([]);
    });
  }
});
