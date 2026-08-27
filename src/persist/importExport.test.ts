import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectCodec } from "./codec";
import {
  downloadProjectFile,
  exportProjectBlob,
  importProjectFile,
  importProjectText,
  projectFileName,
  readBlobText,
} from "./importExport";
import { makeFixtureProject } from "./testing/fixture";

describe("projectFileName", () => {
  it("uses the project name", () => {
    const project = makeFixtureProject();
    expect(projectFileName(project)).toBe("Fixture Song.json");
  });

  it("falls back to untitled.json for a blank name", () => {
    const project = { ...makeFixtureProject(), name: "   " };
    expect(projectFileName(project)).toBe("untitled.json");
  });

  it("strips filesystem-unsafe characters", () => {
    const project = { ...makeFixtureProject(), name: 'My/Song:Take*2?"<>|' };
    expect(projectFileName(project)).not.toMatch(/[\\/:*?"<>|]/);
    expect(projectFileName(project).endsWith(".json")).toBe(true);
  });
});

describe("export/import round trip", () => {
  it("exportProjectBlob -> importProjectFile reproduces the project", async () => {
    const codec = createProjectCodec();
    const project = makeFixtureProject();
    const blob = exportProjectBlob(codec, project, { savedAt: "2026-01-01T00:00:00.000Z" });
    expect(blob.type).toBe("application/json");

    const result = await importProjectFile(codec, blob);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.id).toBe(project.id);
    expect(result.warnings).toEqual([]);

    // SS2: "a project must survive open -> edit -> save -> reopen byte-stable
    // except for edits" — so the CONTENT has to come back, not just the id.
    // Re-encoding at a pinned `savedAt` compares the whole document at once.
    expect(codec.encode(result.project, { savedAt: "2026-01-01T00:00:00.000Z" })).toBe(
      codec.encode(project, { savedAt: "2026-01-01T00:00:00.000Z" }),
    );
    // (Decoding also REPAIRS: notes come back sorted by (start, pitch),
    // invariant 4 — which is why the byte comparison above is the real
    // assertion and the clip check below is by content, not by array order.)
    expect(Object.keys(result.project.clips)).toEqual(Object.keys(project.clips));
    for (const [id, clip] of Object.entries(project.clips)) {
      const back = result.project.clips[id];
      expect(back?.length).toBe(clip.length);
      expect(back?.start).toBe(clip.start);
      expect(back?.trackId).toBe(clip.trackId);
      expect([...(back?.notes ?? [])].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
        [...clip.notes].sort((a, b) => a.id.localeCompare(b.id)),
      );
    }
    expect(result.project.channels).toEqual(project.channels);
    expect(result.project.channelOrder).toEqual(project.channelOrder);
    expect(result.project.devices).toEqual(project.devices);
    expect(result.project.tempo).toEqual(project.tempo);
  });

  it("importProjectText surfaces a decode failure for garbage input", () => {
    const codec = createProjectCodec();
    const result = importProjectText(codec, "not json at all");
    expect(result.ok).toBe(false);
  });

  it("exportProjectBlob defaults to pretty-printed JSON", async () => {
    const codec = createProjectCodec();
    const project = makeFixtureProject();
    const blob = exportProjectBlob(codec, project, { savedAt: "2026-01-01T00:00:00.000Z" });
    const text = await readBlobText(blob);
    expect(text).toContain("\n");
  });
});


// SS13's EXPLICIT export half — the browser-file plumbing the app's "Export…"
// button drives. jsdom has no `URL.createObjectURL`, which is exactly the seam
// worth pinning: the anchor's `download` name, and that the object URL is
// always revoked, even when the click throws.
describe("downloadProjectFile", () => {
  const anchors: HTMLAnchorElement[] = [];
  let created: string[] = [];
  let revoked: string[] = [];

  function installUrlDouble(): void {
    created = [];
    revoked = [];
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (blob: Blob) => {
      const url = `blob:fake/${String(created.length)}/${String(blob.size)}`;
      created.push(url);
      return url;
    };
    (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = (url: string) => {
      revoked.push(url);
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    anchors.length = 0;
    delete (URL as unknown as Record<string, unknown>)["createObjectURL"];
    delete (URL as unknown as Record<string, unknown>)["revokeObjectURL"];
  });

  function spyOnAnchors(clickImpl?: () => void): void {
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = realCreate(tag) as HTMLElement;
      if (tag === "a") {
        const anchor = el as HTMLAnchorElement;
        anchor.click = clickImpl ?? ((): void => undefined);
        anchors.push(anchor);
      }
      return el;
    });
  }

  it("clicks a download anchor named after the project, then revokes the URL", () => {
    installUrlDouble();
    spyOnAnchors();
    const codec = createProjectCodec();
    const project = makeFixtureProject();

    downloadProjectFile(codec, project, { savedAt: "2026-01-01T00:00:00.000Z" });

    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.download).toBe("Fixture Song.json");
    expect(anchors[0]?.getAttribute("href")).toBe(created[0]);
    expect(anchors[0]?.rel).toBe("noopener");
    expect(revoked).toEqual(created);
  });

  it("honours an explicit file name", () => {
    installUrlDouble();
    spyOnAnchors();
    downloadProjectFile(createProjectCodec(), makeFixtureProject(), { fileName: "take-2.json" });
    expect(anchors[0]?.download).toBe("take-2.json");
  });

  it("revokes the object URL even when the click throws", () => {
    installUrlDouble();
    spyOnAnchors(() => {
      throw new Error("popup blocked");
    });
    expect(() => downloadProjectFile(createProjectCodec(), makeFixtureProject())).toThrow(
      "popup blocked",
    );
    expect(revoked).toEqual(created);
    expect(revoked).toHaveLength(1);
  });

});
