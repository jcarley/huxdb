import { describe, expect, it } from "vitest";
import { closeQuestion, formatSize, normalizeText, sameSource, withoutSqlExtension } from "./queryFiles";

describe("sameSource", () => {
  it("compares by kind and identity", () => {
    expect(sameSource({ kind: "saved", id: "a" }, { kind: "saved", id: "a" })).toBe(true);
    expect(sameSource({ kind: "saved", id: "a" }, { kind: "saved", id: "b" })).toBe(false);
    expect(sameSource({ kind: "file", path: "/a" }, { kind: "file", path: "/a" })).toBe(true);
    expect(sameSource({ kind: "saved", id: "/a" }, { kind: "file", path: "/a" })).toBe(false);
    expect(sameSource(undefined, { kind: "saved", id: "a" })).toBe(false);
  });
});

describe("normalizeText", () => {
  it("leaves only newlines", () => {
    expect(normalizeText("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });
});

describe("withoutSqlExtension", () => {
  it("drops only a trailing .sql", () => {
    expect(withoutSqlExtension("report.SQL")).toBe("report");
    expect(withoutSqlExtension("my.sql.backup")).toBe("my.sql.backup");
  });
});

describe("formatSize", () => {
  it("picks a unit", () => {
    expect(formatSize(12)).toBe("12 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("closeQuestion", () => {
  it("keeps designers on save and data tabs on commit", () => {
    expect(closeQuestion("table", true, false)).toBe("save");
    expect(closeQuestion("view", false, false)).toBe("save");
    expect(closeQuestion("data", false, false)).toBe("commit");
  });

  it("asks a query tab about its text before its transaction", () => {
    expect(closeQuestion("query", true, false)).toBe("save");
    expect(closeQuestion("query", true, true)).toBe("commit");
    expect(closeQuestion("query", false, false)).toBe("commit");
  });
});
