import { syntaxTree } from "@codemirror/language";
import { describe, expect, it } from "vitest";
import { callAtCursor, cursorContext, nameAtCursor, visibleCtes, visibleSources } from "./sqlScope";
import { stateAt } from "./testCatalog";

function at(marked: string) {
  const { state, pos } = stateAt(marked);
  const tree = syntaxTree(state);
  const slice = (from: number, to: number) => state.sliceDoc(from, to);
  const name = nameAtCursor(tree, slice, pos);
  return { tree, slice, pos, name, context: cursorContext(tree, slice, pos, name.from) };
}

const clause = (marked: string) => at(marked).context?.clause;
const sources = (marked: string) => visibleSources(at(marked).context!.scope).map(({ source }) => source.name);
const tables = (marked: string) =>
  visibleSources(at(marked).context!.scope).flatMap(({ source }) => (source.kind === "table" ? [source.path.join(".")] : []));
const output = (marked: string) => {
  const { scope } = at(marked).context!;
  return scope.output.map((item) => ("name" in item ? item.name : `${item.qualifier ?? ""}*`));
};

describe("clauses", () => {
  it.each([
    ["SELECT |", "expression"],
    ["SELECT a, | FROM t", "expression"],
    ["SELECT a FROM |", "table"],
    ["SELECT a FROM t, |", "table"],
    ["SELECT a FROM t JOIN |", "table"],
    ["SELECT a FROM t LEFT OUTER JOIN |", "table"],
    ["SELECT a FROM t JOIN u ON |", "expression"],
    ["SELECT a FROM t JOIN u ON a = |", "expression"],
    ["SELECT a FROM t JOIN u USING (|)", "expression"],
    ["SELECT a FROM t WHERE |", "expression"],
    ["SELECT a FROM t WHERE x = 1 AND |", "expression"],
    ["SELECT a FROM t GROUP BY |", "sort"],
    ["SELECT a FROM t ORDER BY |", "sort"],
    ["SELECT a FROM t HAVING |", "expression"],
    ["SELECT a FROM t LIMIT |", "other"],
    ["UPDATE |", "table"],
    ["UPDATE t SET |", "expression"],
    ["DELETE FROM |", "table"],
    ["DELETE FROM t USING |", "table"],
    ["DELETE FROM t WHERE |", "expression"],
    ["INSERT INTO |", "table"],
    ["INSERT INTO t (|", "insert-columns"],
    ["INSERT INTO t (a, |) VALUES (1)", "insert-columns"],
    ["INSERT INTO t (a) VALUES (|)", "other"],
    ["INSERT INTO t (a) SELECT |", "expression"],
    ["UPDATE t SET a = 1 RETURNING |", "expression"],
    ["|", undefined],
    ["SELECT 1; |", undefined],
    ["SELECT 1;\n\n|", undefined],
  ])("%s is %s", (sql, expected) => {
    expect(clause(sql)).toBe(expected);
  });

  it("uses the clause before the word being typed", () => {
    expect(clause("SELECT a FROM| t")).toBe("expression");
    expect(clause("SELECT a FROM us|")).toBe("table");
  });

  it("finds the cursor in trailing whitespace", () => {
    expect(clause("SELECT * FROM t WHERE    |")).toBe("expression");
    expect(sources("SELECT * FROM t WHERE \n  |")).toEqual(["t"]);
  });

  it("keeps the enclosing clause inside a call", () => {
    expect(clause("SELECT lower(|) FROM t")).toBe("expression");
    expect(clause("SELECT * FROM t WHERE a IN (|)")).toBe("expression");
  });
});

describe("sources", () => {
  it("reads tables and aliases", () => {
    expect(sources("SELECT | FROM users")).toEqual(["users"]);
    expect(sources("SELECT | FROM users u")).toEqual(["u"]);
    expect(sources("SELECT | FROM users AS u, orders o")).toEqual(["u", "o"]);
    expect(sources("SELECT | FROM a x JOIN b y ON true LEFT JOIN c ON true")).toEqual(["x", "y", "c"]);
    expect(tables("SELECT | FROM public.users u")).toEqual(["public.users"]);
    expect(tables("SELECT | FROM ONLY users")).toEqual(["users"]);
  });

  it("folds names as the server does", () => {
    expect(tables("SELECT | FROM USERS U")).toEqual(["users"]);
    expect(sources("SELECT | FROM USERS U")).toEqual(["u"]);
    expect(tables('SELECT | FROM "Users" "U"')).toEqual(["Users"]);
    expect(sources('SELECT | FROM "Users" "U"')).toEqual(["U"]);
  });

  it("takes keyword-looking names as names", () => {
    expect(tables("SELECT | FROM name")).toEqual(["name"]);
    expect(sources("SELECT | FROM users label WHERE true")).toEqual(["label"]);
  });

  it("doesn't take a clause word as an alias", () => {
    expect(sources("SELECT | FROM users WHERE x")).toEqual(["users"]);
    expect(sources("SELECT | FROM users ORDER BY x")).toEqual(["users"]);
    expect(sources("SELECT | FROM a JOIN b ON true")).toEqual(["a", "b"]);
    expect(sources("SELECT | FROM a LEFT JOIN b ON true")).toEqual(["a", "b"]);
    expect(sources("SELECT | FROM users FOR UPDATE")).toEqual(["users"]);
  });

  it("reads what getAliases misses", () => {
    expect(sources("UPDATE users u SET a = 1 WHERE |")).toEqual(["u"]);
    expect(sources("UPDATE users AS u SET a = |")).toEqual(["u"]);
    expect(sources("UPDATE users u SET a = 1 FROM orders o WHERE |")).toEqual(["u", "o"]);
    expect(sources("DELETE FROM users u USING orders o WHERE |")).toEqual(["u", "o"]);
    expect(sources("DELETE FROM users WHERE |")).toEqual(["users"]);
    expect(sources("MERGE INTO users u USING orders o ON |")).toEqual(["u", "o"]);
  });

  it("reads table functions", () => {
    expect(sources("SELECT | FROM generate_series(1, 3) g")).toEqual(["g"]);
    expect(sources("SELECT | FROM a JOIN LATERAL f(1) g ON true")).toEqual(["a", "g"]);
  });

  it("reads a parenthesized join", () => {
    expect(sources("SELECT | FROM (a JOIN b ON true)")).toEqual(["a", "b"]);
  });

  it("repairs an unclosed call before FROM", () => {
    expect(sources("SELECT lower(na| FROM users u")).toEqual(["u"]);
    expect(clause("SELECT lower(na| FROM users u")).toBe("expression");
    expect(sources("SELECT lower(trim(na| FROM users u WHERE x")).toEqual(["u"]);
    expect(sources("SELECT coalesce(a, | FROM t JOIN v ON true")).toEqual(["t", "v"]);
  });

  it("ignores comments and half-typed tails", () => {
    expect(sources("SELECT | FROM /* c */ users -- d\n u")).toEqual(["u"]);
    expect(sources("SELECT u. | FROM users u JOIN")).toEqual(["u"]);
  });

  it("gives an INSERT's target only to its column list and RETURNING", () => {
    expect(sources("INSERT INTO t (a) SELECT | FROM x")).toEqual(["x"]);
    expect(sources("INSERT INTO t (a) VALUES (1) RETURNING |")).toEqual(["t"]);
    expect(at("INSERT INTO t (|").context!.scope.target?.name).toBe("t");
  });
});

describe("syntax that looks like a clause", () => {
  it("reads IS DISTINCT FROM as an expression", () => {
    expect(clause("SELECT * FROM t WHERE a IS DISTINCT FROM b AND |")).toBe("expression");
    expect(sources("SELECT * FROM t WHERE a IS NOT DISTINCT FROM b AND |")).toEqual(["t"]);
    expect(sources("SELECT a IS DISTINCT FROM b AS d FROM t WHERE |")).toEqual(["t"]);
    expect(output("SELECT a IS DISTINCT FROM b AS d, c FROM t|")).toEqual(["d", "c"]);
  });

  it("keeps a SELECT list going past WITHIN GROUP", () => {
    expect(output("SELECT percentile_cont(.5) WITHIN GROUP (ORDER BY x) AS p, y FROM t|")).toEqual(["p", "y"]);
  });

  it("reads a comma after ON or USING as another table", () => {
    expect(sources("SELECT | FROM a JOIN b ON a.id = b.id, c")).toEqual(["a", "b", "c"]);
    expect(sources("SELECT | FROM a JOIN b USING (id), c")).toEqual(["a", "b", "c"]);
    expect(clause("SELECT * FROM a JOIN b ON a.id = b.id, |")).toBe("table");
    expect(clause("SELECT * FROM (a JOIN b ON a.x = b.x) y, |")).toBe("table");
  });

  it("doesn't read other commas as tables", () => {
    expect(clause("SELECT * FROM a WHERE f(x, y) AND b = 1 ORDER BY c, |")).toBe("sort");
    expect(clause("UPDATE t SET a = 1, |")).toBe("expression");
  });

  it("reads a join's USING inside a DELETE's", () => {
    expect(sources("DELETE FROM t USING a JOIN b USING (id) WHERE |")).toEqual(["t", "a", "b"]);
  });

  it("gives ON CONFLICT the target and EXCLUDED", () => {
    expect(sources("INSERT INTO t (a) VALUES (1) ON CONFLICT (|")).toEqual(["t", "excluded"]);
    expect(sources("INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET b = |")).toEqual(["t", "excluded"]);
    expect(sources("INSERT INTO t (a) VALUES (1) ON CONFLICT DO NOTHING RETURNING |")).toEqual(["t"]);
    expect(sources("INSERT INTO t (a) SELECT b FROM x RETURNING |")).toEqual(["t"]);
    expect(sources("INSERT INTO t (a) SELECT b FROM x JOIN y ON |")).toEqual(["x", "y"]);
  });

  it("doesn't take DEFAULT VALUES for an alias", () => {
    expect(at("INSERT INTO t DEFAULT VALUES|").context!.scope.target?.name).toBe("t");
  });

  it("reads WITH ORDINALITY's alias", () => {
    expect(sources("SELECT | FROM generate_series(1, 3) WITH ORDINALITY AS g (n, i)")).toEqual(["g"]);
  });

  it("knows the calls that use FROM", () => {
    expect(clause("SELECT extract(year FROM cr|")).toBe("expression");
    expect(sources("SELECT extract(year FROM cr| FROM users u")).toEqual(["u"]);
    expect(sources("SELECT substring(a FROM 1 FOR | FROM users u")).toEqual(["u"]);
    expect(sources("SELECT trim(BOTH FROM | FROM users u")).toEqual(["u"]);
    expect(sources("SELECT trim(na| FROM users u")).toEqual(["u"]);
    expect(sources("SELECT extract(| FROM users u")).toEqual(["u"]);
  });
});

describe("nested scopes", () => {
  it("sees outward from a correlated subquery", () => {
    expect(sources("SELECT * FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE |)")).toEqual(["o", "u"]);
    expect(sources("SELECT * FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.|")).toEqual(["o", "u"]);
    expect(sources("SELECT (SELECT | FROM orders o) FROM users u")).toEqual(["o", "u"]);
  });

  it("stays in the outer scope outside the parentheses", () => {
    expect(sources("SELECT * FROM users u WHERE EXISTS (SELECT 1 FROM orders o) AND |")).toEqual(["u"]);
    expect(sources("SELECT * FROM users u WHERE a IN (SELECT b FROM c)|")).toEqual(["u"]);
  });

  it("doesn't let a derived table see its siblings", () => {
    expect(sources("SELECT * FROM users u, (SELECT | FROM orders o) d")).toEqual(["o"]);
  });

  it("lets a LATERAL one", () => {
    expect(sources("SELECT * FROM users u, LATERAL (SELECT | FROM orders o) d")).toEqual(["o", "u", "d"]);
  });

  it("gives a derived table its alias", () => {
    expect(sources("SELECT | FROM (SELECT id FROM users) d")).toEqual(["d"]);
    expect(sources("SELECT | FROM (SELECT id FROM users) AS d (x)")).toEqual(["d"]);
  });

  it("scopes each side of a set operation", () => {
    expect(sources("SELECT a FROM t1 UNION SELECT | FROM t2")).toEqual(["t2"]);
    expect(sources("SELECT | FROM t1 UNION ALL SELECT b FROM t2")).toEqual(["t1"]);
    expect(sources("SELECT a FROM t1 EXCEPT SELECT b FROM t2 ORDER BY |")).toEqual(["t2"]);
  });

  it("scopes only the current statement", () => {
    expect(sources("SELECT 1 FROM a; SELECT | FROM b; SELECT 2 FROM c")).toEqual(["b"]);
  });
});

describe("CTEs", () => {
  const ctes = (marked: string) => visibleCtes(at(marked).context!.scope).map((c) => c.name);

  it("lists them in the main query and later ones", () => {
    expect(ctes("WITH a AS (SELECT 1), b AS (SELECT 2) SELECT | FROM a")).toEqual(["a", "b"]);
    expect(ctes("WITH a AS (SELECT 1), b AS (SELECT | FROM ) SELECT 1")).toContain("a");
    expect(ctes("WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n FROM |) SELECT 1")).toContain("t");
    expect(ctes("WITH a AS MATERIALIZED (SELECT 1), b AS NOT MATERIALIZED (SELECT 2) SELECT |")).toEqual(["a", "b"]);
  });

  it("reaches them from a subquery", () => {
    expect(ctes("WITH a AS (SELECT 1) SELECT * FROM t WHERE x IN (SELECT | FROM )")).toEqual(["a"]);
  });

  it("finds a WITH list after something else", () => {
    expect(ctes("CREATE VIEW v AS WITH x AS (SELECT 1 a) SELECT | FROM x")).toEqual(["x"]);
    expect(ctes("EXPLAIN ANALYZE WITH x AS (SELECT 1) SELECT |")).toEqual(["x"]);
    expect(ctes("CREATE TABLE t AS WITH x AS (SELECT 1) SELECT |")).toEqual(["x"]);
    expect(ctes("INSERT INTO t WITH x AS (SELECT 1) SELECT |")).toEqual(["x"]);
    expect(at("INSERT INTO t WITH x AS (SELECT 1) SELECT |").context!.scope.target?.name).toBe("t");
  });

  it("isn't fooled by other WITHs", () => {
    expect(ctes("CREATE VIEW v WITH (security_barrier) AS SELECT |")).toEqual([]);
    expect(ctes("SELECT | FROM f() WITH ORDINALITY AS g")).toEqual([]);
  });

  it("works before an UPDATE", () => {
    expect(ctes("WITH a AS (SELECT 1) UPDATE t SET x = |")).toEqual(["a"]);
  });

  it("keeps the outer query's sources out of a CTE", () => {
    expect(sources("WITH a AS (SELECT | FROM b) SELECT * FROM c")).toEqual(["b"]);
  });

  it("survives a half-typed list", () => {
    expect(ctes("WITH a AS (SELECT 1), b AS |")).toEqual(["a"]);
    expect(sources("WITH a AS (SELECT 1 FROM t WHERE |")).toEqual(["t"]);
  });
});

describe("output", () => {
  it.each([
    ["SELECT id, name AS n, u.email, count(*), count(*) c, a::int, a::int AS b, 1 + 2, 1 + 2 total, *, u.* FROM t|", ["id", "n", "email", "count", "c", "a", "b", "total", "*", "u*"]],
    ["SELECT DISTINCT a FROM t|", ["a"]],
    ["SELECT DISTINCT ON (x) a FROM t|", ["a"]],
    ["SELECT ALL a FROM t|", ["a"]],
    ['SELECT "Mixed", a AS "B c" FROM t|', ["Mixed", "B c"]],
    ["SELECT lower(a) FROM t|", ["lower"]],
    ["SELECT pg_catalog.lower(a) x, 'lit', 1 FROM t|", ["x"]],
    ["SELECT a, FROM t|", ["a"]],
  ])("%s", (sql, expected) => {
    expect(output(sql)).toEqual(expected);
  });

  it("takes a data-modifying CTE's RETURNING", () => {
    const { scope } = at("WITH a AS (DELETE FROM t RETURNING id, name AS n) SELECT |").context!;
    expect(visibleCtes(scope)[0].query.output).toEqual([{ name: "id" }, { name: "n" }]);
  });
});

describe("the name at the cursor", () => {
  it("reads qualifiers as the server does", () => {
    expect(at("SELECT U.|").name).toMatchObject({ path: ["u"], empty: false });
    expect(at("SELECT public.USERS.na|").name.path).toEqual(["public", "users"]);
    expect(at('SELECT "Users".|').name.path).toEqual(["Users"]);
    expect(at("SELECT /* c */ na|").name.path).toEqual([]);
  });

  it("is empty with nothing typed", () => {
    expect(at("SELECT |").name.empty).toBe(true);
    expect(at("SELECT 1|").name.empty).toBe(true);
    expect(at("SELECT tex|").name.empty).toBe(false);
  });
});

describe("calls", () => {
  const call = (marked: string) => {
    const { tree, slice, pos } = at(marked);
    return callAtCursor(tree, slice, pos);
  };

  it("counts arguments at its own level", () => {
    expect(call("SELECT lower(|)")).toMatchObject({ path: ["lower"], argument: 0 });
    expect(call("SELECT round(a, |)")).toMatchObject({ argument: 1 });
    expect(call("SELECT round(a, f(b, c), |")).toMatchObject({ path: ["round"], argument: 2 });
    expect(call("SELECT round(f(b, |")).toMatchObject({ path: ["f"], argument: 1 });
    expect(call("SELECT round(a, 'x, y', |)")).toMatchObject({ argument: 2 });
  });

  it("reads schema-qualified and keyword-named calls", () => {
    expect(call("SELECT pg_catalog.lower(|)")).toMatchObject({ path: ["pg_catalog", "lower"] });
    expect(call("SELECT left(|")).toMatchObject({ path: ["left"] });
    expect(call("SELECT LOWER(|)")).toMatchObject({ path: ["lower"] });
  });

  it("isn't one outside the parentheses or after a keyword", () => {
    expect(call("SELECT lower(a)|")).toBeNull();
    expect(call("SELECT lower|(a)")).toBeNull();
    expect(call("SELECT * FROM t WHERE a IN (|)")).toBeNull();
    expect(call("SELECT (|)")).toBeNull();
    expect(call("SELECT lower('a|')")).toBeNull();
  });

  it("goes through parentheses that aren't calls", () => {
    expect(call("SELECT lower((|))")).toMatchObject({ path: ["lower"] });
    expect(call("SELECT round(a IN (|")).toMatchObject({ path: ["round"], argument: 0 });
  });
});
