import { describe, expect, it } from "vitest";
import { createMemoryProjectStorage } from "./storage";

describe("createMemoryProjectStorage", () => {
  it("reports kind and availability", () => {
    const storage = createMemoryProjectStorage();
    expect(storage.kind).toBe("memory");
    expect(storage.available).toBe(true);
  });

  it("returns null for a key that was never written", async () => {
    const storage = createMemoryProjectStorage();
    await expect(storage.read("missing")).resolves.toBeNull();
  });

  it("round-trips write -> read", async () => {
    const storage = createMemoryProjectStorage();
    await storage.write("proj-1", '{"hello":"world"}');
    await expect(storage.read("proj-1")).resolves.toBe('{"hello":"world"}');
  });

  it("overwrites an existing key", async () => {
    const storage = createMemoryProjectStorage();
    await storage.write("proj-1", "one");
    await storage.write("proj-1", "two");
    await expect(storage.read("proj-1")).resolves.toBe("two");
  });

  it("remove() deletes a key", async () => {
    const storage = createMemoryProjectStorage();
    await storage.write("proj-1", "one");
    await storage.remove("proj-1");
    await expect(storage.read("proj-1")).resolves.toBeNull();
  });

  it("remove() on a missing key is a no-op", async () => {
    const storage = createMemoryProjectStorage();
    await expect(storage.remove("missing")).resolves.toBeUndefined();
  });

  it("list() returns keys newest-write-first", async () => {
    const storage = createMemoryProjectStorage();
    await storage.write("a", "1");
    await storage.write("b", "1");
    await storage.write("c", "1");
    await expect(storage.list()).resolves.toEqual(["c", "b", "a"]);
  });

  it("list() moves a re-written key back to the front", async () => {
    const storage = createMemoryProjectStorage();
    await storage.write("a", "1");
    await storage.write("b", "1");
    await storage.write("a", "2");
    await expect(storage.list()).resolves.toEqual(["a", "b"]);
  });

  it("keeps separate keys independent", async () => {
    const storage = createMemoryProjectStorage();
    await storage.write("a", "alpha");
    await storage.write("b", "beta");
    await expect(storage.read("a")).resolves.toBe("alpha");
    await expect(storage.read("b")).resolves.toBe("beta");
  });
});
