import { CompletionContext } from "@codemirror/autocomplete";
import type { Completion, CompletionResult, CompletionSource } from "@codemirror/autocomplete";
import type { TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { buildIndex, searchScope } from "./catalogIndex";
import { catalogSource, keywordSource } from "./completion";
import { catalog, stateAt } from "./testCatalog";

interface Options {
  schema?: string;
  explicit?: boolean;
  source?: CompletionSource;
}

function query(marked: string, { schema = "", explicit = false, source }: Options = {}) {
  const { state, pos } = stateAt(marked);
  return (source ?? catalogSource(buildIndex(catalog, schema)))(new CompletionContext(state, pos, explicit)) as CompletionResult | null;
}

const labels = (marked: string, options?: Options) => query(marked, options)?.options.map((o) => o.label) ?? [];
const option = (marked: string, label: string, options?: Options) => query(marked, options)?.options.find((o) => o.label === label);

/** The list as it'd show: highest boost first. */
const ranked = (marked: string, options?: Options) =>
  [...(query(marked, options)?.options ?? [])].sort((a: Completion, b: Completion) => (b.boost ?? 0) - (a.boost ?? 0)).map((o) => o.label);

describe("names from Phase 3", () => {
  it("lists tables, schemas and the search path's relations", () => {
    expect(labels("SELECT * FROM us|")).toEqual(expect.arrayContaining(["users", "public", "pg_class"]));
    expect(labels("SELECT * FROM us|")).not.toContain("only_app");
  });

  it("completes a schema, a table and a qualified table", () => {
    expect(labels("SELECT * FROM public.|")).toEqual(expect.arrayContaining(["users", "order", "posts", "a.b"]));
    expect(labels("SELECT * FROM app.|")).toEqual(expect.arrayContaining(["users", "only_app"]));
    const columns = labels("users.|");
    expect(columns).toEqual(expect.arrayContaining(["id", "Mixed", "order"]));
    expect(columns).not.toContain("app_only");
    expect(columns).not.toContain("upper_only");
    expect(labels("public.users.|")).toContain("id");
    expect(labels("app.users.|")).toContain("app_only");
    expect(labels('"Odd One".|')).toContain("t");
    expect(labels('"a.b".|')).toContain("d");
  });

  it("resolves aliases", () => {
    for (const sql of ["SELECT u.| FROM users u", "SELECT u.| FROM users AS u", "SELECT u.| FROM public.users u", "SELECT U.| FROM users u"]) {
      expect(labels(sql)).toContain("id");
    }
    expect(labels("SELECT x.| FROM public.users x JOIN posts p ON true")).toContain("name");
    expect(labels("SELECT p.| FROM public.users x JOIN posts p ON true")).toContain("title");
    expect(labels("SELECT u.| FROM users u; SELECT Y.a FROM Foo y")).toContain("id");
  });

  it("folds case as PostgreSQL does", () => {
    const folded = labels("SELECT u.| FROM Users u");
    expect(folded).toContain("Mixed");
    expect(folded).not.toContain("upper_only");
    expect(labels("SELECT u.| FROM USERS U")).toContain("id");
    const exact = labels('SELECT u.| FROM "Users" u');
    expect(exact).toContain("upper_only");
    expect(exact).not.toContain("id");
  });

  it("quotes what needs it", () => {
    expect(option("SELECT * FROM public.|", "order")?.apply).toBe('"order"');
    expect(option("users.|", "Mixed")?.apply).toBe('"Mixed"');
    expect(option("users.|", "id")?.apply).toBeUndefined();
    expect(option("Od|", "Odd One")?.apply).toBe('"Odd One"');
    expect(labels('SELECT * FROM "us|"')).toContain('"users"');
    expect(option('SELECT * FROM "us|"', '"users"')?.apply).toBeUndefined();
  });

  it("types by kind and shows column types", () => {
    expect(option("users.|", "id")?.detail).toBe("integer");
    expect(option("SELECT * FROM public.|", "posts")?.type).toBe("matview");
    expect(option("SELECT * FROM public.|", "a.b")?.type).toBe("view");
    expect(option("SELECT * FROM public.|", "users")?.type).toBe("table");
    expect(option("Od|", "public")?.type).toBe("namespace");
  });

  it("stays out of strings and comments, even on demand", () => {
    for (const sql of ["SELECT 'us|'", "-- us|", "/* us| */", "SELECT $$ us| $$"]) {
      expect(query(sql, { explicit: true })).toBeNull();
    }
    expect(query("SELECT 1|")).toBeNull();
    expect(query("SELECT |")).toBeNull();
  });

  it("follows the tab's schema", () => {
    expect(labels("us|", { schema: "app" })).toContain("only_app");
    expect(labels("users.|", { schema: "app" })).toContain("app_only");
    expect(labels("users.|", { schema: "app" })).not.toContain("id");
    expect(labels("posts.|", { schema: "app" })).toContain("title");
    expect(searchScope(catalog, "app")).toEqual(["pg_catalog", "app", "public"]);
    expect(searchScope(catalog, "public")).toEqual(["pg_catalog", "public"]);
    expect(searchScope(catalog, "")).toEqual(["pg_catalog", "public"]);
  });

  it("offers no keywords after a dot", () => {
    expect(query("u.sel|", { source: keywordSource(true) })).toBeNull();
    expect(query("sel|", { source: keywordSource(true) })?.options.length).toBeGreaterThan(0);
  });
});

describe("unqualified columns", () => {
  it("finds columns of the tables in FROM", () => {
    expect(labels("SELECT na| FROM users")).toContain("name");
    expect(labels("SELECT na| FROM users u JOIN orders o ON true")).toEqual(expect.arrayContaining(["name", "total"]));
    expect(labels("SELECT * FROM users WHERE na|")).toContain("name");
    expect(labels("SELECT * FROM users u JOIN orders o ON us|")).toContain("user_id");
    expect(labels("SELECT a FROM users GROUP BY na|")).toContain("name");
    expect(labels("UPDATE users SET na|")).toContain("name");
    expect(labels("DELETE FROM users u WHERE na|")).toContain("name");
    expect(labels("INSERT INTO users (na|")).toEqual(expect.arrayContaining(["name", "id"]));
    expect(labels("INSERT INTO users (id) VALUES (1) RETURNING na|")).toContain("name");
  });

  it("works while a call is still open", () => {
    expect(labels("SELECT lower(na| FROM users")).toContain("name");
  });

  it("offers each table's columns under its own name, and the tables' names", () => {
    const options = query("SELECT i| FROM users u JOIN orders o ON true")!.options;
    expect(options.filter((o) => o.label === "id").map((o) => o.detail)).toEqual(["integer · u", "integer · o"]);
    expect(option("SELECT i| FROM users u", "u")?.type).toBe("constant");
  });

  it("shows outer columns in a correlated subquery", () => {
    const sql = "SELECT * FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE na|)";
    expect(labels(sql)).toEqual(expect.arrayContaining(["total", "name"]));
    expect(option(sql, "total")!.boost!).toBeGreaterThan(option(sql, "name")!.boost!);
  });

  it("offers the SELECT list's names to ORDER BY and GROUP BY", () => {
    expect(labels("SELECT name AS n FROM users ORDER BY n|")).toContain("n");
  });
});

describe("clause awareness", () => {
  it("puts tables after FROM and JOIN, not columns", () => {
    for (const sql of ["SELECT * FROM us|", "SELECT * FROM users u JOIN or|", "SELECT id FROM users, or|"]) {
      expect(labels(sql)).toContain("orders");
      expect(labels(sql)).not.toContain("user_id");
    }
  });

  it("puts columns after SELECT, WHERE and ON, not tables", () => {
    for (const sql of ["SELECT or| FROM users", "SELECT * FROM users WHERE or|", "SELECT * FROM users u JOIN posts p ON or|"]) {
      expect(labels(sql)).toContain("name");
      expect(labels(sql)).not.toContain("orders");
    }
  });

  it("offers tables while FROM isn't written yet", () => {
    expect(labels("SELECT us|")).toContain("users");
  });

  it("offers a schema's objects in a table's place, even if a table has its name", () => {
    expect(labels("SELECT * FROM public.|")).toContain("users");
  });

  it("offers nothing where no column goes", () => {
    expect(query("SELECT * FROM users LIMIT n|")).toBeNull();
  });
});

describe("ranking", () => {
  const sql = "SELECT l| FROM users u";

  it("puts columns in scope above functions and tables' names", () => {
    const list = ranked("SELECT n| FROM users u");
    expect(list.slice(0, 4)).toEqual(["id", "name", "Mixed", "order"]);
    expect(list.indexOf("u")).toBe(4);
    expect(list.indexOf("name")).toBeLessThan(list.indexOf("now"));
  });

  it("ranks everything above keywords except PostgreSQL's own", () => {
    expect(option(sql, "name")!.boost!).toBeGreaterThan(-1);
    expect(option(sql, "add_user")!.boost!).toBeGreaterThan(-1);
    expect(option(sql, "lower")!.boost!).toBeLessThan(-1);
    expect(option("SELECT * FROM pg|", "pg_class")!.boost!).toBeLessThan(option("SELECT * FROM us|", "users")!.boost!);
  });

  it("ranks a CTE above a table", () => {
    const with_ = "WITH recent AS (SELECT 1) SELECT * FROM r|";
    expect(option(with_, "recent")!.boost!).toBeGreaterThan(option(with_, "users")!.boost!);
  });
});

describe("CTEs and derived tables", () => {
  it("lists CTE names where tables go", () => {
    expect(option("WITH recent AS (SELECT id FROM users) SELECT * FROM r|", "recent")?.type).toBe("cte");
  });

  it("gives a CTE's columns, bare and qualified", () => {
    const with_ = "WITH recent AS (SELECT id, name AS n FROM users)";
    expect(labels(`${with_} SELECT i| FROM recent`)).toEqual(expect.arrayContaining(["id", "n"]));
    expect(labels(`${with_} SELECT r.| FROM recent r`)).toEqual(["id", "n"]);
    expect(labels(`${with_} SELECT recent.| FROM recent`)).toEqual(["id", "n"]);
  });

  it("expands stars through the catalog", () => {
    expect(labels("WITH r AS (SELECT * FROM users) SELECT r.| FROM r")).toEqual(["id", "name", "Mixed", "order"]);
    expect(labels("WITH r AS (SELECT u.*, 1 AS extra FROM users u JOIN orders o ON true) SELECT r.| FROM r")).toEqual(["id", "name", "Mixed", "order", "extra"]);
    expect(labels("SELECT d.| FROM (SELECT o.* FROM users u JOIN orders o ON true) d")).toEqual(["id", "user_id", "total"]);
  });

  it("chains CTEs, and lets a CTE hide a table", () => {
    expect(labels("WITH a AS (SELECT id FROM users), b AS (SELECT * FROM a) SELECT b.| FROM b")).toEqual(["id"]);
    expect(labels("WITH users AS (SELECT 1 AS only_this) SELECT users.| FROM users")).toEqual(["only_this"]);
  });

  it("applies column lists", () => {
    expect(labels("WITH b(y, z) AS (SELECT 1, 2) SELECT b.| FROM b")).toEqual(["y", "z"]);
    expect(labels("WITH b(y) AS (SELECT id, name FROM users) SELECT b.| FROM b")).toEqual(["y", "name"]);
    expect(labels("SELECT d.| FROM (SELECT id, name FROM users) d (a, b)")).toEqual(["a", "b"]);
    expect(labels("SELECT u.| FROM users u (a)")).toEqual(["a", "name", "Mixed", "order"]);
    expect(labels("SELECT g.| FROM generate_series(1, 3) AS g (n)")).toEqual(["n"]);
  });

  it("survives a CTE that reads itself", () => {
    expect(labels("WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t WHERE n < 5) SELECT t.| FROM t")).toEqual(["n"]);
    expect(labels("WITH RECURSIVE t AS (SELECT * FROM t) SELECT t.| FROM t")).toEqual([]);
    expect(labels("WITH RECURSIVE t AS (SELECT id FROM users UNION ALL SELECT t.| FROM t) SELECT 1")).toEqual(["id"]);
  });

  it("gives a derived table's columns, bare and qualified", () => {
    expect(labels("SELECT * FROM (SELECT id, name AS label FROM users) d WHERE d.|")).toEqual(["id", "label"]);
    expect(labels("SELECT la| FROM (SELECT id, name AS label FROM users) d")).toContain("label");
  });

  it("quotes names that need it", () => {
    expect(option('WITH r AS (SELECT 1 AS "Big") SELECT r.| FROM r', "Big")?.apply).toBe('"Big"');
  });
});

describe("functions", () => {
  it("lists one entry per name", () => {
    const options = query("SELECT ro| FROM users")!.options.filter((o) => o.label === "round");
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ type: "function", detail: "3 overloads" });
  });

  it("shows a single overload's arguments", () => {
    expect(option("SELECT lo| FROM users", "lower")?.detail).toBe("(text)");
  });

  it("opens the call on accept, unless one is there", () => {
    const insertion = (marked: string) => {
      const { state, pos } = stateAt(marked);
      const applied: string[] = [];
      const view = { state, dispatch: (spec: TransactionSpec) => applied.push(state.update(spec).newDoc.toString()) } as unknown as EditorView;
      const lower = query(marked)!.options.find((o) => o.label === "lower")!;
      (lower.apply as (view: EditorView, completion: Completion, from: number, to: number) => void)(view, lower, pos - 2, pos);
      return applied[0];
    };
    expect(insertion("SELECT lo| FROM users")).toBe("SELECT lower( FROM users");
    expect(insertion("SELECT lo|(name) FROM users")).toBe("SELECT lower(name) FROM users");
  });

  it("completes a schema's functions", () => {
    expect(labels("SELECT app.|")).toContain("app_fn");
    expect(labels("SELECT app_|")).not.toContain("app_fn");
  });
});

describe("INSERT ... ON CONFLICT", () => {
  it("offers the target's columns and EXCLUDED", () => {
    const sql = "INSERT INTO users (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET name = ";
    expect(labels(`${sql}excluded.|`)).toContain("name");
    expect(labels(`${sql}na|`)).toContain("name");
  });
});

describe("long scripts", () => {
  it("completes at the end of one", () => {
    const script = "SELECT a, b, c FROM t JOIN u ON t.a = u.b WHERE x IN (SELECT y FROM z);\n".repeat(1000);
    expect(labels(`${script}SELECT na| FROM users`)).toContain("name");
  });
});

describe("half-typed queries", () => {
  it.each([
    ["SELECT u. FROM users u JOIN orders o ON o.user_id = u.|", "name"],
    ["SELECT * FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.|", "name"],
    ["SELECT * FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.|", "total"],
    ["SELECT * FROM users u WHERE id IN (SELECT user_id FROM orders WHERE to|", "total"],
    ["UPDATE users u SET name = 'x' WHERE u.|", "name"],
    ["DELETE FROM users u USING orders o WHERE o.|", "total"],
    ["SELECT * FROM users u, LATERAL (SELECT * FROM orders o WHERE o.user_id = u.id) l WHERE l.|", "total"],
    ['SELECT * FROM "Users" AS "M" WHERE "M".|', "upper_only"],
    ["WITH a AS (SELECT 1 AS x), b(y, z) AS (SELECT 1, 2 FROM a WHERE a.|) SELECT * FROM b", "x"],
    ["SELECT a FROM users UNION SELECT b FROM orders ORDER BY to|", "total"],
  ])("%s", (sql, expected) => {
    expect(labels(sql)).toContain(expected);
  });
});
