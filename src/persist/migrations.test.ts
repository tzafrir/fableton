import { describe, expect, it } from "vitest";
import type { JsonValue, ProjectMigration } from "../types";
import { PROJECT_SCHEMA_VERSION } from "../types";
import { PROJECT_MIGRATIONS, runMigrations } from "./migrations";

describe("PROJECT_MIGRATIONS", () => {
  it("ships exactly one slot: the v1 bootstrap step", () => {
    expect(PROJECT_MIGRATIONS).toHaveLength(1);
    expect(PROJECT_MIGRATIONS[0]).toMatchObject({ from: 0, to: PROJECT_SCHEMA_VERSION });
  });
});

describe("runMigrations", () => {
  it("is a no-op when the file is already at the current schema", () => {
    const value: JsonValue = { hello: "world" };
    const result = runMigrations(PROJECT_SCHEMA_VERSION, value);
    expect(result.value).toBe(value); // same reference: nothing ran
    expect(result.migratedFrom).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it("runs the bootstrap step for schema 0 and reports migratedFrom", () => {
    const value: JsonValue = { hello: "world" };
    const result = runMigrations(0, value);
    expect(result.error).toBeUndefined();
    expect(result.migratedFrom).toBe(0);
    expect(result.value).toEqual(value);
  });

  it("errors when the file is newer than this build understands", () => {
    const result = runMigrations(PROJECT_SCHEMA_VERSION + 1, { a: 1 });
    expect(result.error).toMatch(/newer version/i);
  });

  it("errors when there is a gap in the migration chain", () => {
    // from < current schema, but no migration table entry covers it.
    const result = runMigrations(0, { a: 1 }, []);
    expect(result.error).toMatch(/no migration path/i);
  });

  it("chains multiple steps in order, applying each transform", () => {
    const migrations: ProjectMigration[] = [
      { from: 0, to: 1, label: "add a", migrate: (p) => ({ ...(p as Record<string, JsonValue>), a: 1 }) },
      { from: 1, to: 2, label: "add b", migrate: (p) => ({ ...(p as Record<string, JsonValue>), b: 2 }) },
    ];
    const result = runMigrations(0, {}, migrations, 2);
    expect(result.error).toBeUndefined();
    expect(result.migratedFrom).toBe(0);
    expect(result.value).toEqual({ a: 1, b: 2 });
  });

  it("applies migrate() as a pure function without mutating the input", () => {
    const original: JsonValue = { a: 1 };
    const migrations: ProjectMigration[] = [
      {
        from: 0,
        to: 1,
        label: "rename",
        migrate: (p) => {
          const obj = p as Record<string, JsonValue>;
          return { b: obj["a"] ?? null };
        },
      },
    ];
    const result = runMigrations(0, original, migrations, 1);
    expect(original).toEqual({ a: 1 }); // untouched
    expect(result.value).toEqual({ b: 1 });
  });
});
