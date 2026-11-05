//! Finds the statements in a script and what each one does to a transaction.
//!
//! Pure, and modeled on psql's lexer: strings, dollar quotes, comments and
//! parentheses hide semicolons, and so does a `BEGIN ATOMIC` routine body. Bad
//! SQL still splits, and anything unterminated runs to the end of the text, so
//! the server is what reports it.

use std::ops::Range;

/// What a statement does to the transaction state (see [`next_state`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TxEffect {
    None,
    Begin,
    Commit { chain: bool },
    Rollback { chain: bool },
    RollbackTo,
    PrepareTransaction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Info {
    pub tx: TxEffect,
    /// May have a result with columns even if it returns no rows.
    pub may_return_rows: bool,
    /// Reads only, so cancelling it loses nothing. A `SELECT` calling a
    /// function that writes still counts.
    pub plain_read: bool,
    /// Why huxdb won't send it, if it won't.
    pub refused: Option<&'static str>,
    /// Creates, changes or drops objects, as far as its text shows: a `DO` block
    /// or a function call can too, which is why completion has a manual refresh.
    pub changes_catalog: bool,
}

/// One statement, from its first token to just past its `;`, in bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Statement {
    pub range: Range<usize>,
    pub info: Info,
}

const COPY_REFUSED: &str = "COPY to or from the client isn't supported here. Use a server-side file or the import tools.";
const LISTEN_REFUSED: &str = "LISTEN isn't supported here.";

/// How many leading words classify a statement.
const LEAD_WORDS: usize = 8;

/// Words seen so far in the current statement.
#[derive(Default)]
struct Current {
    start: Option<usize>,
    end: usize,
    /// The first [`LEAD_WORDS`] words, uppercased.
    lead: Vec<String>,
    writes: bool,
    returning: bool,
    client_copy: bool,
    /// Depth inside a `BEGIN ATOMIC` body.
    begin_depth: usize,
}

impl Current {
    fn token(&mut self, start: usize, end: usize) {
        self.start.get_or_insert(start);
        self.end = end;
    }

    fn word(&mut self, text: &str, paren_depth: usize) {
        let upper = text.to_ascii_uppercase();
        match upper.as_str() {
            "INSERT" | "UPDATE" | "DELETE" | "MERGE" => self.writes = true,
            "RETURNING" => self.returning = true,
            "STDIN" | "STDOUT" if paren_depth == 0 => self.client_copy = true,
            _ => {}
        }
        if paren_depth == 0 && self.creates_routine() {
            match upper.as_str() {
                "BEGIN" => self.begin_depth += 1,
                "CASE" if self.begin_depth > 0 => self.begin_depth += 1,
                "END" if self.begin_depth > 0 => self.begin_depth -= 1,
                _ => {}
            }
        }
        if self.lead.len() < LEAD_WORDS {
            self.lead.push(upper);
        }
    }

    /// `CREATE [OR REPLACE] FUNCTION | PROCEDURE`.
    fn creates_routine(&self) -> bool {
        let lead: Vec<&str> = self.lead.iter().map(String::as_str).collect();
        matches!(
            lead.as_slice(),
            ["CREATE", "FUNCTION" | "PROCEDURE", ..] | ["CREATE", "OR", "REPLACE", "FUNCTION" | "PROCEDURE", ..]
        )
    }

    fn finish(&mut self, out: &mut Vec<Statement>) {
        if let Some(start) = self.start {
            out.push(Statement { range: start..self.end, info: self.info() });
        }
        *self = Current::default();
    }

    fn info(&self) -> Info {
        let first = self.lead.first().map_or("", String::as_str);
        let may_return_rows = match first {
            "SELECT" | "WITH" | "VALUES" | "TABLE" | "SHOW" | "EXPLAIN" | "FETCH" | "EXECUTE" | "CALL" => true,
            "INSERT" | "UPDATE" | "DELETE" | "MERGE" => self.returning,
            _ => false,
        };
        let plain_read = match first {
            "SELECT" | "VALUES" | "TABLE" | "SHOW" => true,
            "WITH" => !self.writes,
            _ => false,
        };
        let refused = match first {
            "COPY" if self.client_copy => Some(COPY_REFUSED),
            "LISTEN" => Some(LISTEN_REFUSED),
            _ => None,
        };
        let changes_catalog = matches!(first, "CREATE" | "ALTER" | "DROP" | "IMPORT");
        Info { tx: tx_effect(&self.lead), may_return_rows, plain_read, refused, changes_catalog }
    }
}

fn tx_effect(lead: &[String]) -> TxEffect {
    let word = |i: usize| lead.get(i).map_or("", String::as_str);
    // `AND NO CHAIN` is the default.
    let chain = lead.windows(2).any(|w| w[0] == "AND" && w[1] == "CHAIN");
    match word(0) {
        "BEGIN" => TxEffect::Begin,
        "START" if word(1) == "TRANSACTION" => TxEffect::Begin,
        "PREPARE" if word(1) == "TRANSACTION" => TxEffect::PrepareTransaction,
        "COMMIT" | "END" if word(1) == "PREPARED" => TxEffect::None,
        "COMMIT" | "END" => TxEffect::Commit { chain },
        "ROLLBACK" | "ABORT" if word(1) == "PREPARED" => TxEffect::None,
        "ROLLBACK" | "ABORT" if word(1) == "TO" || word(2) == "TO" => TxEffect::RollbackTo,
        "ROLLBACK" | "ABORT" => TxEffect::Rollback { chain },
        _ => TxEffect::None,
    }
}

fn starts_word(c: u8) -> bool {
    c.is_ascii_alphabetic() || c == b'_' || c >= 0x80
}

fn in_word(c: u8) -> bool {
    starts_word(c) || c.is_ascii_digit() || c == b'$'
}

/// Past a `'…'` whose opening quote is at `i`. `''` stays inside it, and with
/// `backslashes` (an `E''` string) so does `\'`.
fn skip_string(b: &[u8], mut i: usize, backslashes: bool) -> usize {
    i += 1;
    while i < b.len() {
        match b[i] {
            b'\\' if backslashes => i += 2,
            b'\'' if b.get(i + 1) == Some(&b'\'') => i += 2,
            b'\'' => return i + 1,
            _ => i += 1,
        }
    }
    b.len()
}

/// Past a `"…"` whose opening quote is at `i`.
fn skip_quoted_name(b: &[u8], mut i: usize) -> usize {
    i += 1;
    while i < b.len() {
        if b[i] != b'"' {
            i += 1;
        } else if b.get(i + 1) == Some(&b'"') {
            i += 2;
        } else {
            return i + 1;
        }
    }
    b.len()
}

/// Past a `/* … */` starting at `i`, if it ends. These nest.
fn skip_block_comment(b: &[u8], mut i: usize) -> Option<usize> {
    let mut depth = 0;
    while i < b.len() {
        if b[i..].starts_with(b"/*") {
            depth += 1;
            i += 2;
        } else if b[i..].starts_with(b"*/") {
            depth -= 1;
            i += 2;
            if depth == 0 {
                return Some(i);
            }
        } else {
            i += 1;
        }
    }
    None
}

/// The `$tag$` at `i`, if there is one. `$1` isn't: a tag can't start with a digit.
fn dollar_tag(b: &[u8], i: usize) -> Option<&[u8]> {
    let mut end = i + 1;
    if end < b.len() && starts_word(b[end]) {
        while end < b.len() && (starts_word(b[end]) || b[end].is_ascii_digit()) {
            end += 1;
        }
    }
    (b.get(end) == Some(&b'$')).then(|| &b[i..=end])
}

/// Past the closing tag of a dollar quote whose opening `tag` ends at `i`.
fn skip_dollar_quote(b: &[u8], i: usize, tag: &[u8]) -> usize {
    b[i..].windows(tag.len()).position(|w| w == tag).map_or(b.len(), |at| i + at + tag.len())
}

/// The statements in `sql`. Text with only comments and whitespace has none.
pub fn split(sql: &str) -> Vec<Statement> {
    let b = sql.as_bytes();
    let mut out = Vec::new();
    let mut current = Current::default();
    let mut parens = 0usize;
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        let start = i;
        match c {
            _ if c.is_ascii_whitespace() => {
                i += 1;
                continue;
            }
            b'-' if b.get(i + 1) == Some(&b'-') => {
                i = b[i..].iter().position(|&c| c == b'\n').map_or(b.len(), |n| i + n);
                continue;
            }
            b'/' if b.get(i + 1) == Some(&b'*') => match skip_block_comment(b, i) {
                Some(end) => {
                    i = end;
                    continue;
                }
                // Unterminated: part of the statement, for the server to reject.
                None => i = b.len(),
            },
            b';' if parens == 0 && current.begin_depth == 0 => {
                if current.start.is_some() {
                    current.end = i + 1;
                }
                current.finish(&mut out);
                i += 1;
                continue;
            }
            b'\'' => i = skip_string(b, i, false),
            b'"' => i = skip_quoted_name(b, i),
            b'$' => match dollar_tag(b, i) {
                Some(tag) => i = skip_dollar_quote(b, i + tag.len(), tag),
                None => i += 1,
            },
            b'(' => {
                parens += 1;
                i += 1;
            }
            b')' => {
                parens = parens.saturating_sub(1);
                i += 1;
            }
            _ if starts_word(c) => {
                while i < b.len() && in_word(b[i]) {
                    i += 1;
                }
                let word = &sql[start..i];
                match (word, b.get(i), b.get(i + 1)) {
                    ("e" | "E", Some(b'\''), _) => i = skip_string(b, i, true),
                    ("b" | "B" | "x" | "X" | "n" | "N", Some(b'\''), _) => i = skip_string(b, i, false),
                    ("u" | "U", Some(b'&'), Some(b'\'')) => i = skip_string(b, i + 1, false),
                    ("u" | "U", Some(b'&'), Some(b'"')) => i = skip_quoted_name(b, i + 1),
                    _ => current.word(word, parens),
                }
            }
            _ if c.is_ascii_digit() => {
                while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'.') {
                    i += 1;
                }
            }
            _ => i += 1,
        }
        current.token(start, i);
    }
    current.finish(&mut out);
    out
}

/// Which part of a script a Run covers, in bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    All,
    Selection { from: usize, to: usize },
    Cursor { pos: usize },
}

/// The statements `scope` covers, with ranges into `sql`.
pub fn select(sql: &str, scope: Scope) -> Vec<Statement> {
    match scope {
        Scope::All => split(sql),
        Scope::Selection { from, to } => {
            let mut statements = split(&sql[from..to]);
            for statement in &mut statements {
                statement.range = statement.range.start + from..statement.range.end + from;
            }
            statements
        }
        Scope::Cursor { pos } => {
            let mut statements = split(sql);
            let at = statements.iter().rposition(|s| s.range.start <= pos).unwrap_or(0);
            if statements.is_empty() { statements } else { vec![statements.swap_remove(at)] }
        }
    }
}

/// Converts between Rust's byte offsets and CodeMirror's UTF-16 offsets.
pub struct Offsets {
    /// (byte, UTF-16) just after each non-ASCII character. Between these marks
    /// the two advance together.
    marks: Vec<(usize, usize)>,
    len: usize,
}

impl Offsets {
    pub fn new(text: &str) -> Self {
        let mut marks = Vec::new();
        let mut utf16 = 0;
        for (byte, c) in text.char_indices() {
            utf16 += c.len_utf16();
            if !c.is_ascii() {
                marks.push((byte + c.len_utf8(), utf16));
            }
        }
        Self { marks, len: text.len() }
    }

    pub fn to_utf16(&self, byte: usize) -> usize {
        let at = self.marks.partition_point(|m| m.0 <= byte);
        at.checked_sub(1).map_or(byte, |at| {
            let (b, u) = self.marks[at];
            u + byte - b
        })
    }

    /// Clamped to the text. A position inside a character moves to its start.
    pub fn to_byte(&self, utf16: usize, text: &str) -> usize {
        let at = self.marks.partition_point(|m| m.1 <= utf16);
        let byte = at.checked_sub(1).map_or(utf16, |at| {
            let (b, u) = self.marks[at];
            b + utf16 - u
        });
        let mut byte = byte.min(self.len);
        while !text.is_char_boundary(byte) {
            byte -= 1;
        }
        byte
    }
}

/// The byte offset of the server's error position: 1-based, in characters, within `statement`.
pub fn position_to_byte(statement: &str, position: usize) -> usize {
    statement.char_indices().nth(position.saturating_sub(1)).map_or(statement.len(), |(byte, _)| byte)
}

/// A tab's transaction, as far as its statements show: sqlx keeps the server's
/// own status private, and doesn't count a typed `BEGIN`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TxState {
    Idle,
    Open,
    /// Failed: only a rollback gets out of it.
    Aborted,
}

/// How a statement the server received ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome<'a> {
    Success,
    Failed { code: Option<&'a str> },
}

/// The transaction state after a statement.
pub fn next_state(state: TxState, effect: TxEffect, outcome: Outcome) -> TxState {
    use TxState::*;
    match outcome {
        Outcome::Success => match effect {
            TxEffect::Begin => Open,
            TxEffect::Commit { chain: true } | TxEffect::Rollback { chain: true } => Open,
            TxEffect::Commit { chain: false } | TxEffect::Rollback { chain: false } | TxEffect::PrepareTransaction => Idle,
            TxEffect::RollbackTo if state == Aborted => Open,
            TxEffect::RollbackTo | TxEffect::None => state,
        },
        // A COMMIT or PREPARE TRANSACTION that fails ends the transaction.
        Outcome::Failed { .. } if matches!(effect, TxEffect::Commit { .. } | TxEffect::PrepareTransaction) => Idle,
        // 25P02: the server says a transaction failed, whatever we thought.
        Outcome::Failed { code: Some("25P02") } => Aborted,
        Outcome::Failed { .. } if state == Open => Aborted,
        Outcome::Failed { .. } => state,
    }
}

/// A COMMIT of a failed transaction succeeds, but rolls back.
pub fn rolled_back_instead(state: TxState, effect: TxEffect, outcome: Outcome) -> bool {
    state == TxState::Aborted && outcome == Outcome::Success && matches!(effect, TxEffect::Commit { .. } | TxEffect::PrepareTransaction)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(sql: &str) -> Vec<&str> {
        split(sql).into_iter().map(|s| &sql[s.range]).collect()
    }

    #[test]
    fn splits_on_semicolons_and_keeps_them() {
        assert_eq!(texts("select 1; select 2;\n  select 3"), ["select 1;", "select 2;", "select 3"]);
    }

    #[test]
    fn empty_statements_and_comments_are_not_statements() {
        assert_eq!(texts(""), Vec::<&str>::new());
        assert_eq!(texts(" ;; \n-- nothing\n/* here */ ;"), Vec::<&str>::new());
        assert_eq!(texts("-- lead\nselect 1 -- trail\n; -- after"), ["select 1 -- trail\n;"]);
    }

    #[test]
    fn begin_atomic_body_is_one_statement() {
        let f = "CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC select 1; select case when true then 2 else 3 end; END;";
        assert_eq!(texts(&format!("{f} select 9;")), [f, "select 9;"]);
        let p = "create or replace procedure p() begin atomic insert into t values (1); end;";
        assert_eq!(texts(p), [p]);
        // A parameter named begin doesn't open a body.
        assert_eq!(texts("create function f(begin int) returns int return 1; select 2").len(), 2);
    }

    #[test]
    fn plain_begin_is_its_own_statement() {
        assert_eq!(texts("BEGIN; select 1; COMMIT;"), ["BEGIN;", "select 1;", "COMMIT;"]);
    }

    #[test]
    fn parentheses_hide_semicolons() {
        let rule = "CREATE RULE r AS ON INSERT TO t DO ALSO (insert into a values (1); insert into b values (2));";
        assert_eq!(texts(&format!("{rule} select 1;")), [rule, "select 1;"]);
        // A stray ) doesn't go negative.
        assert_eq!(texts(") ; select 1;").len(), 2);
    }

    #[test]
    fn dollars_inside_identifiers_are_not_quotes() {
        assert_eq!(texts("select a$b$c; select 1 from d$e$;"), ["select a$b$c;", "select 1 from d$e$;"]);
        assert_eq!(texts("prepare p as select $1; select $2;"), ["prepare p as select $1;", "select $2;"]);
    }

    #[test]
    fn dollar_quotes_hide_semicolons_and_other_tags() {
        let q = "do $tag$ begin perform 1; perform $$x;y$$; end $tag$;";
        assert_eq!(texts(&format!("{q} select 1;")), [q, "select 1;"]);
        assert_eq!(texts("select $é$;$é$; select 2"), ["select $é$;$é$;", "select 2"]);
    }

    #[test]
    fn strings_and_names_hide_semicolons() {
        assert_eq!(texts(r"select E'it\'s; x'; select 2"), [r"select E'it\'s; x';", "select 2"]);
        assert_eq!(texts(r"select e'\\'; select 2"), [r"select e'\\';", "select 2"]);
        // Without E, a backslash is an ordinary character.
        assert_eq!(texts(r"select 'a\'; select 2"), [r"select 'a\';", "select 2"]);
        assert_eq!(texts("select 'it''s; x'; select 2").len(), 2);
        assert_eq!(texts("select U&'a;b', U&\"c;d\"; select 2").len(), 2);
        assert_eq!(texts("select \"a;\"\"b\"; select 2").len(), 2);
        assert_eq!(texts("select B'01', X'1f', N'a;b'; select 2").len(), 2);
    }

    #[test]
    fn e_inside_a_word_is_not_a_prefix() {
        assert_eq!(texts(r"select type'\'; select 2").len(), 2);
    }

    #[test]
    fn comments_nest_and_hide_semicolons() {
        assert_eq!(texts("select /* a; /* b; */ c; */ 1; select 2"), ["select /* a; /* b; */ c; */ 1;", "select 2"]);
        assert_eq!(texts("select 1 -- a; b\n; select 2").len(), 2);
    }

    #[test]
    fn unterminated_text_runs_to_the_end() {
        assert_eq!(texts("select 1; select 'a; b"), ["select 1;", "select 'a; b"]);
        assert_eq!(texts("select E'a\\"), ["select E'a\\"]);
        assert_eq!(texts("select /* a; b"), ["select /* a; b"]);
        assert_eq!(texts("select $$ a; b"), ["select $$ a; b"]);
        assert_eq!(texts("select \"a; b"), ["select \"a; b"]);
        assert_eq!(texts("select (1; select 2"), ["select (1; select 2"]);
    }

    #[test]
    fn multibyte_text_splits_on_boundaries() {
        assert_eq!(texts("select 'é😀;'; select é; select 😀"), ["select 'é😀;';", "select é;", "select 😀"]);
    }

    fn tx(sql: &str) -> TxEffect {
        split(sql)[0].info.tx
    }

    #[test]
    fn classifies_transaction_control() {
        for begin in ["BEGIN", "begin work", "BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE", "START TRANSACTION READ ONLY"] {
            assert_eq!(tx(begin), TxEffect::Begin, "{begin}");
        }
        for commit in ["COMMIT", "END", "commit work", "END TRANSACTION", "COMMIT AND NO CHAIN"] {
            assert_eq!(tx(commit), TxEffect::Commit { chain: false }, "{commit}");
        }
        assert_eq!(tx("COMMIT AND CHAIN"), TxEffect::Commit { chain: true });
        for rollback in ["ROLLBACK", "ABORT", "rollback transaction", "ROLLBACK AND NO CHAIN"] {
            assert_eq!(tx(rollback), TxEffect::Rollback { chain: false }, "{rollback}");
        }
        assert_eq!(tx("ROLLBACK WORK AND CHAIN"), TxEffect::Rollback { chain: true });
        for to in ["ROLLBACK TO s", "ROLLBACK TO SAVEPOINT s", "ROLLBACK WORK TO s", "ROLLBACK TRANSACTION TO SAVEPOINT s"] {
            assert_eq!(tx(to), TxEffect::RollbackTo, "{to}");
        }
        assert_eq!(tx("PREPARE TRANSACTION 'x'"), TxEffect::PrepareTransaction);
        for none in ["COMMIT PREPARED 'x'", "ROLLBACK PREPARED 'x'", "PREPARE p AS select 1", "START something", "DO $$ begin commit; end $$"] {
            assert_eq!(tx(none), TxEffect::None, "{none}");
        }
    }

    fn info(sql: &str) -> Info {
        split(sql)[0].info
    }

    #[test]
    fn classifies_what_changes_the_catalog() {
        for ddl in ["create table t (a int)", "CREATE INDEX ON t (a)", "alter table t add b int", "drop view v", "import foreign schema s from server f into public", "/* c */ create view v as select 1"] {
            assert!(info(ddl).changes_catalog, "{ddl}");
        }
        for other in ["select 1", "insert into t values (1)", "truncate t", "comment on table t is 'x'", "set search_path = a"] {
            assert!(!info(other).changes_catalog, "{other}");
        }
    }

    #[test]
    fn classifies_reads_and_results() {
        for read in ["select 1", "(select 1)", "VALUES (1)", "TABLE t", "SHOW work_mem", "with q as (select 1) select * from q"] {
            assert!(info(read).plain_read, "{read}");
            assert!(info(read).may_return_rows, "{read}");
        }
        for write in ["with q as (delete from t returning *) select * from q", "update t set a = 1 returning a", "explain analyze delete from t"] {
            assert!(!info(write).plain_read, "{write}");
            assert!(info(write).may_return_rows, "{write}");
        }
        assert!(!info("update t set a = 1").may_return_rows);
        assert!(!info("create table t (a int)").may_return_rows);
        // A word in a string isn't a write.
        assert!(info("with q as (select 'delete') select * from q").plain_read);
    }

    #[test]
    fn refuses_what_the_driver_cannot_carry() {
        assert!(info("COPY t FROM STDIN").refused.is_some());
        assert!(info("copy (select 1) to stdout with csv").refused.is_some());
        assert!(info("LISTEN ch").refused.is_some());
        assert!(info("COPY t FROM '/tmp/x'").refused.is_none());
        assert!(info("COPY (select stdin from t) TO '/tmp/x'").refused.is_none());
        assert!(info("select 'stdin'").refused.is_none());
        assert!(info("UNLISTEN ch").refused.is_none());
    }

    fn ranges(sql: &str, scope: Scope) -> Vec<&str> {
        select(sql, scope).into_iter().map(|s| &sql[s.range]).collect()
    }

    #[test]
    fn selects_by_scope() {
        let sql = "select 1;\n\nselect 2;\n\nselect 3;";
        assert_eq!(ranges(sql, Scope::All).len(), 3);
        // Inside, on a statement's first character, in the gap after, and before the first.
        assert_eq!(ranges(sql, Scope::Cursor { pos: 12 }), ["select 2;"]);
        assert_eq!(ranges(sql, Scope::Cursor { pos: 11 }), ["select 2;"]);
        assert_eq!(ranges(sql, Scope::Cursor { pos: 10 }), ["select 1;"]);
        assert_eq!(ranges("\n\nselect 1;", Scope::Cursor { pos: 0 }), ["select 1;"]);
        assert_eq!(ranges("  ", Scope::Cursor { pos: 0 }), Vec::<&str>::new());
        // Only the selected text is scanned, and ranges point into the script.
        assert_eq!(ranges(sql, Scope::Selection { from: 7, to: 20 }), ["1;", "select 2;"]);
    }

    #[test]
    fn offsets_convert_through_emoji() {
        let text = "aé😀b";
        let offsets = Offsets::new(text);
        // a=1 byte/1 unit, é=2/1, 😀=4/2, b=1/1.
        for (byte, utf16) in [(0, 0), (1, 1), (3, 2), (7, 4), (8, 5)] {
            assert_eq!(offsets.to_utf16(byte), utf16);
            assert_eq!(offsets.to_byte(utf16, text), byte);
        }
        // Between the surrogates of 😀.
        assert_eq!(offsets.to_byte(3, text), 3);
        assert_eq!(offsets.to_byte(99, text), text.len());
    }

    #[test]
    fn server_positions_count_characters() {
        let text = "select 'é😀', nope";
        assert_eq!(&text[position_to_byte(text, 14)..], "nope");
        assert_eq!(position_to_byte(text, 999), text.len());
        assert_eq!(position_to_byte(text, 0), 0);
    }

    #[test]
    fn transaction_states() {
        use TxState::*;
        let ok = Outcome::Success;
        let failed = Outcome::Failed { code: Some("22012") };
        let none = TxEffect::None;
        let commit = TxEffect::Commit { chain: false };
        let rollback = TxEffect::Rollback { chain: false };

        assert_eq!(next_state(Idle, TxEffect::Begin, ok), Open);
        assert_eq!(next_state(Idle, none, failed), Idle);
        assert_eq!(next_state(Open, none, ok), Open);
        assert_eq!(next_state(Open, none, failed), Aborted);
        assert_eq!(next_state(Open, none, Outcome::Failed { code: Some("57014") }), Aborted);
        assert_eq!(next_state(Aborted, none, Outcome::Failed { code: Some("25P02") }), Aborted);
        assert_eq!(next_state(Idle, none, Outcome::Failed { code: Some("25P02") }), Aborted);
        assert_eq!(next_state(Aborted, rollback, ok), Idle);
        assert_eq!(next_state(Aborted, commit, ok), Idle);
        assert_eq!(next_state(Open, commit, ok), Idle);
        // A deferred constraint fails the COMMIT, which ends the transaction.
        assert_eq!(next_state(Open, commit, failed), Idle);
        assert_eq!(next_state(Open, TxEffect::PrepareTransaction, Outcome::Failed { code: Some("55000") }), Idle);
        assert_eq!(next_state(Open, TxEffect::PrepareTransaction, ok), Idle);
        assert_eq!(next_state(Aborted, TxEffect::Commit { chain: true }, ok), Open);
        assert_eq!(next_state(Open, TxEffect::Rollback { chain: true }, ok), Open);
        assert_eq!(next_state(Aborted, TxEffect::RollbackTo, ok), Open);
        assert_eq!(next_state(Aborted, TxEffect::RollbackTo, failed), Aborted);
        assert_eq!(next_state(Open, TxEffect::RollbackTo, ok), Open);
        assert_eq!(next_state(Open, TxEffect::RollbackTo, failed), Aborted);

        assert!(rolled_back_instead(Aborted, commit, ok));
        assert!(rolled_back_instead(Aborted, TxEffect::PrepareTransaction, ok));
        assert!(!rolled_back_instead(Open, commit, ok));
        assert!(!rolled_back_instead(Aborted, rollback, ok));
    }
}
