import { describe, expect, it } from "vitest";
import { buildIndex } from "./catalogIndex";
import { pickOverloads, signatureAt, splitArguments } from "./signatureHelp";
import { catalog, fn, stateAt } from "./testCatalog";

const signature = (marked: string) => signatureAt(stateAt(marked).state, buildIndex(catalog));

describe("splitArguments", () => {
  it.each([
    ["", []],
    ["text", ["text"]],
    ["a integer, b text", ["a integer", "b text"]],
    ["a integer, b text DEFAULT 'x, y'::text", ["a integer", "b text DEFAULT 'x, y'::text"]],
    ["a numeric DEFAULT round(1.5, 1), b integer", ["a numeric DEFAULT round(1.5, 1)", "b integer"]],
    ['a integer DEFAULT ARRAY[1, 2], "b, c" text', ["a integer DEFAULT ARRAY[1, 2]", '"b, c" text']],
    ["a integer, OUT b text, INOUT c text", ["a integer", "INOUT c text"]],
    ['VARIADIC "any"', ['VARIADIC "any"']],
  ])("%s", (text, expected) => {
    expect(splitArguments(text)).toEqual(expected);
  });
});

describe("pickOverloads", () => {
  const one = fn("f", "a", "x", 1, 1);
  const two = fn("f", "a, b", "x", 2, 2);
  const three = fn("f", "a, b, c", "x", 2, 3);
  const many = fn("f", "VARIADIC a", "x", 0, 1, true);

  it("keeps those with room for the argument, shortest first", () => {
    expect(pickOverloads([three, one, two], 0)).toEqual([one, two, three]);
    expect(pickOverloads([one, two, three], 1)).toEqual([two, three]);
    expect(pickOverloads([one, two, three], 2)).toEqual([three]);
  });

  it("always keeps a variadic one", () => {
    expect(pickOverloads([one, many], 5)).toEqual([many]);
  });

  it("shows them all if none fits", () => {
    expect(pickOverloads([one, two], 7)).toEqual([one, two]);
  });

  it("keeps a function with no arguments for its empty call", () => {
    const none = fn("f", "", "x", 0, 0);
    expect(pickOverloads([none], 0)).toEqual([none]);
  });
});

describe("signatureAt", () => {
  it("shows the overloads that fit, and the argument", () => {
    const first = signature("SELECT round(|)");
    expect(first).toMatchObject({ name: "round", argument: 0, open: 12 });
    expect(first?.overloads).toHaveLength(3);
    const second = signature("SELECT round(a, |)");
    expect(second?.argument).toBe(1);
    expect(second?.overloads).toEqual([{ parameters: ["numeric", "integer"], result: "numeric" }]);
  });

  it("finds user functions, qualified ones and any case", () => {
    expect(signature("SELECT add_user(|")?.name).toBe("add_user");
    expect(signature("SELECT pg_catalog.lower(|)")?.name).toBe("lower");
    expect(signature("SELECT LOWER(|)")?.name).toBe("lower");
    expect(signature("SELECT left(|")?.name).toBe("left");
  });

  it("follows only the tab's search path", () => {
    expect(signature("SELECT app_fn(|)")).toBeNull();
    expect(signature("SELECT app.app_fn(|)")?.name).toBe("app_fn");
  });

  it("is quiet for anything unknown or not a call", () => {
    expect(signature("SELECT nothing(|)")).toBeNull();
    expect(signature("SELECT lower(a)|")).toBeNull();
    expect(signature("INSERT INTO users (|")).toBeNull();
    expect(signature("SELECT lower('a|')")).toBeNull();
  });

  it("is quiet with a selection", () => {
    const { state } = stateAt("SELECT lower(|)");
    const selected = state.update({ selection: { anchor: 8, head: 13 } }).state;
    expect(signatureAt(selected, buildIndex(catalog))).toBeNull();
  });

  it("caps what it shows", () => {
    const many = {
      searchPath: ["public"],
      schemas: [{ name: "public", relations: [], functions: Array.from({ length: 9 }, () => fn("f", "a", "x", 1, 1)) }],
    };
    const shown = signatureAt(stateAt("SELECT f(|)").state, buildIndex(many));
    expect(shown?.overloads).toHaveLength(6);
    expect(shown?.hidden).toBe(3);
  });
});
