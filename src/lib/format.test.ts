import { describe, expect, it } from "vitest";
import { dlPercent, dlStatusText, fmtBytes, fmtDur, fmtSpeed } from "./format";

describe("fmtDur", () => {
  it("formats minutes and zero-padded seconds", () => {
    expect(fmtDur(0)).toBe("0:00");
    expect(fmtDur(5)).toBe("0:05");
    expect(fmtDur(59)).toBe("0:59");
    expect(fmtDur(60)).toBe("1:00");
    expect(fmtDur(61)).toBe("1:01");
    expect(fmtDur(3599)).toBe("59:59");
    expect(fmtDur(3600)).toBe("60:00");
    expect(fmtDur(3725)).toBe("62:05");
  });
  it("truncates fractional seconds", () => {
    expect(fmtDur(59.9)).toBe("0:59");
    expect(fmtDur(119.99)).toBe("1:59");
  });
  it("handles invalid input", () => {
    expect(fmtDur(-1)).toBe("0:00");
    expect(fmtDur(NaN)).toBe("0:00");
  });
});

describe("fmtBytes", () => {
  it("uses bytes / KB / MB thresholds", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(1023)).toBe("1023 B");
    expect(fmtBytes(1024)).toBe("1 KB");
    expect(fmtBytes(1536)).toBe("2 KB");
    expect(fmtBytes(1024 * 1024)).toBe("1.0 MB");
    expect(fmtBytes(2.5 * 1024 * 1024)).toBe("2.5 MB");
  });
});

describe("fmtSpeed", () => {
  it("uses two decimals for MB/s, none for KB/s", () => {
    expect(fmtSpeed(500)).toBe("500 B/s");
    expect(fmtSpeed(2048)).toBe("2 KB/s");
    expect(fmtSpeed(1.5 * 1024 * 1024)).toBe("1.50 MB/s");
  });
});

describe("dlPercent", () => {
  it("shows an ellipsis before the size is known", () => {
    expect(dlPercent({ percent: -1 })).toBe("…");
  });
  it("rounds to whole percents", () => {
    expect(dlPercent({ percent: 0 })).toBe("0%");
    expect(dlPercent({ percent: 49.4 })).toBe("49%");
    expect(dlPercent({ percent: 99.6 })).toBe("100%");
  });
});

describe("dlStatusText", () => {
  it("maps every known status", () => {
    expect(dlStatusText({ status: "queued", error: null })).toBe("Resolving…");
    expect(dlStatusText({ status: "downloading", error: null })).toBe("Downloading");
    expect(dlStatusText({ status: "completed", error: null })).toBe("Done");
    expect(dlStatusText({ status: "cancelled", error: null })).toBe("Cancelled");
    expect(dlStatusText({ status: "error", error: "boom" })).toBe("Error: boom");
    expect(dlStatusText({ status: "error", error: null })).toBe("Error: unknown");
  });
  it("passes unknown statuses through", () => {
    expect(dlStatusText({ status: "mystery", error: null })).toBe("mystery");
  });
});
