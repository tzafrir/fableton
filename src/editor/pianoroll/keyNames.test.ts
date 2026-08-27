import { describe, expect, it } from "vitest";
import { isBlackKeyPitch, noteName } from "./keyNames";

describe("noteName", () => {
  it("puts middle C at C3, the way this app's namesake numbers octaves", () => {
    expect(noteName(60)).toBe("C3");
    expect(noteName(61)).toBe("C#3");
    expect(noteName(59)).toBe("B2");
    expect(noteName(72)).toBe("C4");
  });

  it("names the whole MIDI range without falling off either end", () => {
    expect(noteName(0)).toBe("C-2");
    expect(noteName(127)).toBe("G8");
    for (let pitch = 0; pitch <= 127; pitch += 1) {
      expect(noteName(pitch)).toMatch(/^[A-G]#?-?\d+$/);
    }
  });

  it("marks exactly the five black keys of each octave", () => {
    const black = [];
    for (let pitch = 60; pitch < 72; pitch += 1) if (isBlackKeyPitch(pitch)) black.push(noteName(pitch));
    expect(black).toEqual(["C#3", "D#3", "F#3", "G#3", "A#3"]);
  });
});
