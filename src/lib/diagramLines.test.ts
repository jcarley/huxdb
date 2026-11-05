import { describe, expect, it } from "vitest";
import { namePlace, routePath, selfLoop, selfLoopNamePlace, shortName } from "./diagramLines";

it("draws a route through its points", () => {
  expect(routePath([{ x: 0, y: 1 }, { x: 2, y: 3 }])).toBe("M0 1 L2 3");
});

describe("selfLoop", () => {
  it("leaves and returns along one side", () => {
    expect(selfLoop(100, 10, 50)).toBe("M100 10 L136 10 L136 50 L100 50");
  });

  it("widens for columns further apart, so loops nest, up to a limit", () => {
    const right = (y: number) => selfLoopNamePlace(0, 0, y).x;
    expect(right(80)).toBeGreaterThan(right(20));
    expect(right(10000)).toBe(64);
  });

  it("puts its name on the child column's row, so two loops' names don't stack", () => {
    expect(selfLoopNamePlace(0, 30, 10).y).toBe(30);
    expect(selfLoopNamePlace(0, 48, 10).y).toBe(48);
  });
});

it("starts a line's name at its own child column", () => {
  expect(namePlace(100, 40)).toEqual({ x: 121, y: 40 });
});

it("shortens a long name and leaves a short one", () => {
  expect(shortName("fk_short")).toBe("fk_short");
  expect(shortName("x".repeat(29))).toBe(`${"x".repeat(27)}…`);
  expect(shortName("x".repeat(28))).toBe("x".repeat(28));
});
