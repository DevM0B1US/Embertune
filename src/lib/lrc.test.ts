import { describe, expect, it } from "vitest";
import { parseLrc } from "./lrc";

describe("parseLrc", () => {
  it("parses single-timestamp lines", () => {
    const r = parseLrc("[00:12.50]Hello world\n[01:02]Second line");
    expect(r.plain).toBeNull();
    expect(r.lines).toEqual([
      { t: 12.5, text: "Hello world" },
      { t: 62, text: "Second line" },
    ]);
  });

  it("expands repeated-lyric multi-timestamp lines (audit B5)", () => {
    const r = parseLrc("[00:01.00][00:45.00]Same lyric");
    expect(r.plain).toBeNull();
    expect(r.lines).toEqual([
      { t: 1, text: "Same lyric" },
      { t: 45, text: "Same lyric" },
    ]);
  });

  it("does not leak the second timestamp into the text (old bug)", () => {
    const r = parseLrc("[00:01.00][00:45.00]Chorus");
    for (const line of r.lines) expect(line.text).toBe("Chorus");
  });

  it("sorts lines by time even when the file is unordered", () => {
    const r = parseLrc("[00:30]later\n[00:05]earlier");
    expect(r.lines.map((l) => l.text)).toEqual(["earlier", "later"]);
  });

  it("skips metadata tags and honors [offset:]", () => {
    const r = parseLrc("[ar:Artist]\n[ti:Title]\n[offset:+1000]\n[00:05]one");
    // offset +1000ms shifts the timestamp 1s earlier
    expect(r.lines).toEqual([{ t: 4, text: "one" }]);
    expect(r.plain).toBeNull();
  });

  it("treats untimed text as plain lyrics", () => {
    const r = parseLrc("just some words\nanother line");
    expect(r.lines).toEqual([]);
    expect(r.plain).toBe("just some words\nanother line");
  });

  it("metadata-only files are neither timed nor plain text", () => {
    const r = parseLrc("[ar:Artist]\n[by:Someone]");
    expect(r.lines).toEqual([]);
    expect(r.plain).toBeNull();
  });

  it("returns null plain for empty input", () => {
    const r = parseLrc("");
    expect(r.lines).toEqual([]);
    expect(r.plain).toBeNull();
  });

  it("supports multi-digit minute values past 59", () => {
    const r = parseLrc("[75:30]long mix");
    expect(r.lines[0]!.t).toBe(4530);
  });

  it("keeps millisecond precision", () => {
    const r = parseLrc("[00:01.234]precise");
    expect(r.lines[0]!.t).toBe(1.234);
  });
});
