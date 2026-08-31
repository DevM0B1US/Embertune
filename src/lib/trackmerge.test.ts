import { describe, expect, it } from "vitest";
import { mergeTracks, sameTrack } from "./trackmerge";
import type { Track } from "./types";

function track(id: number, over: Partial<Track> = {}): Track {
  return {
    id,
    title: `Track ${id}`,
    artist: "Artist",
    album: "Album",
    duration: 100,
    path: `/mock/${id}.mp3`,
    source_url: "",
    source: "local",
    added_at: id,
    favorite: false,
    ...over,
  };
}

describe("sameTrack", () => {
  it("is true for identical field values", () => {
    expect(sameTrack(track(1), track(1))).toBe(true);
  });
  it("is false when any displayed field differs", () => {
    expect(sameTrack(track(1), track(1, { title: "Changed" }))).toBe(false);
    expect(sameTrack(track(1), track(1, { favorite: true }))).toBe(false);
    expect(sameTrack(track(1), track(1, { duration: 99 }))).toBe(false);
  });
});

describe("mergeTracks (audit P10)", () => {
  it("keeps the previous object reference when nothing changed", () => {
    const prev = [track(1), track(2)];
    const next = [track(1), track(2)];
    const merged = mergeTracks(prev, next);
    expect(merged[0]).toBe(prev[0]); // same reference — <For> keeps the DOM node
    expect(merged[1]).toBe(prev[1]);
  });

  it("swaps in the new object when a field changed", () => {
    const prev = [track(1)];
    const next = [track(1, { favorite: true })];
    const merged = mergeTracks(prev, next);
    expect(merged[0]).toBe(next[0]);
  });

  it("adopts brand-new tracks and drops removed ones", () => {
    const prev = [track(1), track(2)];
    const next = [track(2), track(3)];
    const merged = mergeTracks(prev, next);
    expect(merged.map((t) => t.id)).toEqual([2, 3]);
    expect(merged[0]).toBe(prev[1]);
    expect(merged[1]).toBe(next[1]);
  });

  it("returns the next array as-is when there is no previous library", () => {
    const next = [track(1)];
    expect(mergeTracks([], next)).toBe(next);
  });
});
