//! The table designer's edit state. The frontend keeps two copies, the design as
//! loaded and the design as edited, and the DDL generator diffs them.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Identity {
    Always,
    ByDefault,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDesign {
    /// The column's name when it was loaded, or `None` for a column added in the
    /// designer. Diffing matches columns on this, so a name edit becomes a rename.
    pub original_name: Option<String>,
    pub name: String,
    /// Type without modifiers, as `format_type(oid, NULL)` writes it, e.g.
    /// `character varying`, `timestamp with time zone`, `integer[]`.
    pub data_type: String,
    /// Length or precision, e.g. 50 in `varchar(50)` or 10 in `numeric(10,2)`.
    pub length: Option<i32>,
    /// Scale, e.g. 2 in `numeric(10,2)`.
    pub scale: Option<i32>,
    pub not_null: bool,
    /// A raw SQL expression, as Navicat takes it: text defaults need their quotes.
    pub default: Option<String>,
    pub identity: Option<Identity>,
    /// Expression of a generated column. Read-only in the designer for now.
    pub generated: Option<String>,
    pub comment: Option<String>,
    /// 1-based position in the primary key, or `None` if the column isn't in it.
    pub key_order: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TableDesign {
    pub schema: String,
    pub name: String,
    pub comment: Option<String>,
    /// Name of the existing primary key constraint; `None` lets PostgreSQL pick one.
    pub primary_key_name: Option<String>,
    pub columns: Vec<ColumnDesign>,
    #[serde(default)]
    pub indexes: Vec<IndexDesign>,
    #[serde(default)]
    pub foreign_keys: Vec<ForeignKeyDesign>,
    #[serde(default)]
    pub uniques: Vec<UniqueDesign>,
    #[serde(default)]
    pub checks: Vec<CheckDesign>,
    #[serde(default)]
    pub excludes: Vec<ExcludeDesign>,
    #[serde(default)]
    pub triggers: Vec<TriggerDesign>,
    #[serde(default)]
    pub options: TableOptions,
}

/// One element of an exclusion constraint: a column (or an expression when it
/// names no column) compared with an operator, e.g. `during WITH &&`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExcludeElement {
    pub column: String,
    pub operator: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExcludeDesign {
    pub original_name: Option<String>,
    pub name: String,
    /// Index access method, usually gist.
    pub method: String,
    pub elements: Vec<ExcludeElement>,
    pub predicate: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TriggerTiming {
    #[default]
    Before,
    After,
}

/// When a trigger fires, by `session_replication_role` (`pg_trigger.tgenabled`).
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TriggerEnabled {
    /// Enabled (fires in origin and local modes).
    #[default]
    Origin,
    Disabled,
    Replica,
    Always,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TriggerDesign {
    pub original_name: Option<String>,
    pub name: String,
    pub timing: TriggerTiming,
    /// FOR EACH ROW; otherwise FOR EACH STATEMENT.
    pub for_each_row: bool,
    pub on_insert: bool,
    pub on_update: bool,
    pub on_delete: bool,
    pub on_truncate: bool,
    /// UPDATE OF these columns only; empty means any column.
    pub update_columns: Vec<String>,
    /// WHEN condition, without the parentheses.
    pub when: Option<String>,
    pub function_schema: String,
    pub function_name: String,
    /// Arguments as SQL literals, e.g. `'audit', 42`.
    pub arguments: String,
    pub enabled: TriggerEnabled,
    pub comment: Option<String>,
    /// Full definition of a trigger the designer can't edit (constraint
    /// triggers, transition tables). Such a trigger is only kept, renamed,
    /// enabled or disabled, commented or dropped.
    pub definition: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QualifiedName {
    pub schema: String,
    pub name: String,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PartitionStrategy {
    #[default]
    Range,
    List,
    Hash,
}

/// PARTITION BY for a new table; keys are columns or expressions.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PartitionDesign {
    pub strategy: PartitionStrategy,
    pub keys: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TableOptions {
    /// `None` on a new table means the current user.
    pub owner: Option<String>,
    /// `None` means the database's default tablespace.
    pub tablespace: Option<String>,
    pub unlogged: bool,
    pub fill_factor: Option<i32>,
    /// Parent tables, in inheritance order.
    pub inherits: Vec<QualifiedName>,
    /// Only used when creating a table: the key can't change afterwards.
    pub partition_by: Option<PartitionDesign>,
    /// Read-only: an existing partitioned table's key, e.g. `RANGE (created)`.
    pub partition_key: Option<String>,
    /// Read-only: for a partition, its parent and bounds.
    pub partition_of: Option<String>,
}

/// One key of an index: a column name, or an expression when it names no column.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IndexColumn {
    pub column: String,
    pub descending: bool,
}

/// An index that doesn't back a constraint (those show on the constraint tabs).
/// Operator classes, collations, NULLS ordering and INCLUDE columns aren't
/// modeled; an edited index is re-created without them.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IndexDesign {
    /// Name when loaded, or `None` for an index added in the designer.
    pub original_name: Option<String>,
    /// Blank lets PostgreSQL pick a name.
    pub name: String,
    pub columns: Vec<IndexColumn>,
    /// Access method: btree, hash, gist, spgist, gin, brin.
    pub method: String,
    pub unique: bool,
    /// Partial index condition (the WHERE clause).
    pub predicate: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ForeignKeyAction {
    #[default]
    NoAction,
    Restrict,
    Cascade,
    SetNull,
    SetDefault,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyDesign {
    pub original_name: Option<String>,
    pub name: String,
    pub columns: Vec<String>,
    pub ref_schema: String,
    pub ref_table: String,
    /// Referenced columns, paired by position with `columns`.
    pub ref_columns: Vec<String>,
    pub on_update: ForeignKeyAction,
    pub on_delete: ForeignKeyAction,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UniqueDesign {
    pub original_name: Option<String>,
    pub name: String,
    pub columns: Vec<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckDesign {
    pub original_name: Option<String>,
    pub name: String,
    /// Boolean SQL expression, without the CHECK keyword.
    pub expression: String,
    pub no_inherit: bool,
    pub comment: Option<String>,
}

/// Trims text and turns blank optional text into `None`.
fn clean(value: &Option<String>) -> Option<String> {
    value.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

impl ColumnDesign {
    fn normalized(&self) -> Self {
        let identity = self.identity;
        Self {
            name: self.name.trim().to_string(),
            data_type: self.data_type.trim().to_string(),
            // PostgreSQL makes identity and primary key columns NOT NULL anyway.
            not_null: self.not_null || identity.is_some() || self.key_order.is_some(),
            default: clean(&self.default),
            generated: clean(&self.generated),
            comment: clean(&self.comment),
            ..self.clone()
        }
    }
}

/// Trims each name and drops blank ones.
fn clean_list(names: &[String]) -> Vec<String> {
    names.iter().map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).collect()
}

impl IndexDesign {
    fn normalized(&self) -> Self {
        Self {
            name: self.name.trim().to_string(),
            columns: self
                .columns
                .iter()
                .map(|c| IndexColumn { column: c.column.trim().to_string(), ..c.clone() })
                .filter(|c| !c.column.is_empty())
                .collect(),
            method: match self.method.trim() {
                "" => "btree".to_string(),
                m => m.to_lowercase(),
            },
            predicate: clean(&self.predicate),
            comment: clean(&self.comment),
            ..self.clone()
        }
    }
}

impl ForeignKeyDesign {
    fn normalized(&self) -> Self {
        Self {
            name: self.name.trim().to_string(),
            columns: clean_list(&self.columns),
            ref_schema: self.ref_schema.trim().to_string(),
            ref_table: self.ref_table.trim().to_string(),
            ref_columns: clean_list(&self.ref_columns),
            comment: clean(&self.comment),
            ..self.clone()
        }
    }
}

impl UniqueDesign {
    fn normalized(&self) -> Self {
        Self {
            name: self.name.trim().to_string(),
            columns: clean_list(&self.columns),
            comment: clean(&self.comment),
            ..self.clone()
        }
    }
}

impl ExcludeDesign {
    fn normalized(&self) -> Self {
        Self {
            name: self.name.trim().to_string(),
            method: match self.method.trim() {
                "" => "gist".to_string(),
                m => m.to_lowercase(),
            },
            elements: self
                .elements
                .iter()
                .map(|e| ExcludeElement { column: e.column.trim().to_string(), operator: e.operator.trim().to_string() })
                .filter(|e| !e.column.is_empty())
                .collect(),
            predicate: clean(&self.predicate),
            comment: clean(&self.comment),
            ..self.clone()
        }
    }
}

impl TriggerDesign {
    fn normalized(&self) -> Self {
        Self {
            name: self.name.trim().to_string(),
            // UPDATE OF only means something with the Update event.
            update_columns: if self.on_update { clean_list(&self.update_columns) } else { Vec::new() },
            when: clean(&self.when),
            function_schema: self.function_schema.trim().to_string(),
            function_name: self.function_name.trim().to_string(),
            arguments: self.arguments.trim().to_string(),
            comment: clean(&self.comment),
            ..self.clone()
        }
    }
}

impl TableOptions {
    fn normalized(&self) -> Self {
        Self {
            owner: clean(&self.owner),
            tablespace: clean(&self.tablespace),
            inherits: self
                .inherits
                .iter()
                .map(|q| QualifiedName { schema: q.schema.trim().to_string(), name: q.name.trim().to_string() })
                .filter(|q| !q.name.is_empty())
                .collect(),
            partition_by: self.partition_by.as_ref().map(|p| PartitionDesign { keys: clean_list(&p.keys), ..p.clone() }),
            ..self.clone()
        }
    }
}

impl CheckDesign {
    fn normalized(&self) -> Self {
        Self {
            name: self.name.trim().to_string(),
            expression: self.expression.trim().to_string(),
            comment: clean(&self.comment),
            ..self.clone()
        }
    }
}

/// How validation names the n-th item of a tab: `Index "name"` or `Index 2`.
fn label(kind: &str, index: usize, name: &str) -> String {
    if name.is_empty() { format!("{kind} {}", index + 1) } else { format!("{kind} \"{name}\"") }
}

/// A named object's shared rules: an existing object keeps a name, and a
/// comment needs one (COMMENT ON addresses objects by name).
fn check_name(label: &str, original_name: &Option<String>, name: &str, comment: &Option<String>) -> Result<(), String> {
    if name.is_empty() && original_name.is_some() {
        return Err(format!("{label}: an existing object needs a name."));
    }
    if name.is_empty() && comment.is_some() {
        return Err(format!("{label}: a name is required to add a comment."));
    }
    Ok(())
}

impl TableDesign {
    /// Trims names and types, and blanks out empty defaults and comments.
    pub fn normalized(&self) -> Self {
        Self {
            schema: self.schema.clone(),
            name: self.name.trim().to_string(),
            comment: clean(&self.comment),
            primary_key_name: clean(&self.primary_key_name),
            columns: self.columns.iter().map(ColumnDesign::normalized).collect(),
            indexes: self.indexes.iter().map(IndexDesign::normalized).collect(),
            foreign_keys: self.foreign_keys.iter().map(ForeignKeyDesign::normalized).collect(),
            uniques: self.uniques.iter().map(UniqueDesign::normalized).collect(),
            checks: self.checks.iter().map(CheckDesign::normalized).collect(),
            excludes: self.excludes.iter().map(ExcludeDesign::normalized).collect(),
            triggers: self.triggers.iter().map(TriggerDesign::normalized).collect(),
            options: self.options.normalized(),
        }
    }

    /// Checks a normalized design. `ConnectionDialog`-style, the designer UI
    /// repeats these checks to show them per field, but this has the final say.
    pub fn validate(&self) -> Result<(), String> {
        if self.name.is_empty() {
            return Err("Table name is required.".into());
        }
        if self.columns.is_empty() {
            return Err("A table needs at least one field.".into());
        }
        let mut names = HashSet::new();
        for (i, c) in self.columns.iter().enumerate() {
            let label = if c.name.is_empty() { format!("Field {}", i + 1) } else { format!("Field \"{}\"", c.name) };
            if c.name.is_empty() {
                return Err(format!("{label}: name is required."));
            }
            if !names.insert(c.name.as_str()) {
                return Err(format!("{label}: the name is used more than once."));
            }
            if c.data_type.is_empty() {
                return Err(format!("{label}: type is required."));
            }
            if c.length.is_some_and(|n| n <= 0) {
                return Err(format!("{label}: length must be greater than 0."));
            }
            if c.scale.is_some_and(|n| n < 0) {
                return Err(format!("{label}: scale can't be negative."));
            }
            if c.scale.is_some() && c.length.is_none() {
                return Err(format!("{label}: scale needs a length."));
            }
            let kinds = [c.default.is_some(), c.identity.is_some(), c.generated.is_some()];
            if kinds.iter().filter(|&&k| k).count() > 1 {
                return Err(format!("{label}: a field can have only one of a default, an identity or a generated expression."));
            }
        }
        self.validate_constraints(&names)
    }

    fn validate_constraints(&self, columns: &HashSet<&str>) -> Result<(), String> {
        let missing = |label: &str, list: &[String]| -> Result<(), String> {
            match list.iter().find(|c| !columns.contains(c.as_str())) {
                Some(c) => Err(format!("{label}: there is no field \"{c}\".")),
                None => Ok(()),
            }
        };
        for (i, x) in self.indexes.iter().enumerate() {
            let label = label("Index", i, &x.name);
            check_name(&label, &x.original_name, &x.name, &x.comment)?;
            if x.columns.is_empty() {
                return Err(format!("{label}: choose at least one field."));
            }
        }
        for (i, x) in self.foreign_keys.iter().enumerate() {
            let label = label("Foreign key", i, &x.name);
            check_name(&label, &x.original_name, &x.name, &x.comment)?;
            if x.columns.is_empty() {
                return Err(format!("{label}: choose at least one field."));
            }
            missing(&label, &x.columns)?;
            if x.ref_schema.is_empty() || x.ref_table.is_empty() {
                return Err(format!("{label}: choose the referenced table."));
            }
            if x.ref_columns.len() != x.columns.len() {
                return Err(format!("{label}: choose one referenced field for each field."));
            }
        }
        for (i, x) in self.uniques.iter().enumerate() {
            let label = label("Unique", i, &x.name);
            check_name(&label, &x.original_name, &x.name, &x.comment)?;
            if x.columns.is_empty() {
                return Err(format!("{label}: choose at least one field."));
            }
            missing(&label, &x.columns)?;
        }
        for (i, x) in self.checks.iter().enumerate() {
            let label = label("Check", i, &x.name);
            check_name(&label, &x.original_name, &x.name, &x.comment)?;
            if x.expression.is_empty() {
                return Err(format!("{label}: the expression is required."));
            }
        }

        for (i, x) in self.excludes.iter().enumerate() {
            let label = label("Exclude", i, &x.name);
            check_name(&label, &x.original_name, &x.name, &x.comment)?;
            if x.elements.is_empty() {
                return Err(format!("{label}: choose at least one element."));
            }
            if let Some(e) = x.elements.iter().find(|e| e.operator.is_empty()) {
                return Err(format!("{label}: element \"{}\" needs an operator.", e.column));
            }
        }
        self.validate_triggers(columns)?;
        self.validate_options()?;

        let named = self
            .indexes
            .iter()
            .map(|x| ("Index", &x.name))
            .chain(self.foreign_keys.iter().map(|x| ("Foreign key", &x.name)))
            .chain(self.uniques.iter().map(|x| ("Unique", &x.name)))
            .chain(self.checks.iter().map(|x| ("Check", &x.name)))
            .chain(self.excludes.iter().map(|x| ("Exclude", &x.name)));
        // Constraint and index names must be distinct: unique constraints and
        // indexes even share the schema's relation namespace.
        let mut taken: HashSet<&str> = self.primary_key_name.iter().map(String::as_str).collect();
        for (kind, name) in named {
            if !name.is_empty() && !taken.insert(name) {
                return Err(format!("{kind} \"{name}\": the name is used by another index or constraint."));
            }
        }
        Ok(())
    }

    fn validate_triggers(&self, columns: &HashSet<&str>) -> Result<(), String> {
        let mut names = HashSet::new();
        for (i, t) in self.triggers.iter().enumerate() {
            let label = label("Trigger", i, &t.name);
            if t.name.is_empty() {
                return Err(format!("{label}: name is required."));
            }
            if !names.insert(t.name.as_str()) {
                return Err(format!("{label}: the name is used by another trigger."));
            }
            if t.definition.is_some() {
                continue; // read-only: its definition isn't edited
            }
            if !(t.on_insert || t.on_update || t.on_delete || t.on_truncate) {
                return Err(format!("{label}: choose at least one event."));
            }
            if t.on_truncate && t.for_each_row {
                return Err(format!("{label}: TRUNCATE triggers must fire for each statement."));
            }
            if let Some(c) = t.update_columns.iter().find(|c| !columns.contains(c.as_str())) {
                return Err(format!("{label}: there is no field \"{c}\"."));
            }
            if t.function_schema.is_empty() || t.function_name.is_empty() {
                return Err(format!("{label}: choose the trigger function."));
            }
        }
        Ok(())
    }

    fn validate_options(&self) -> Result<(), String> {
        let o = &self.options;
        if o.fill_factor.is_some_and(|f| !(10..=100).contains(&f)) {
            return Err("Options: fill factor must be between 10 and 100.".into());
        }
        if let Some(p) = &o.partition_by {
            if p.keys.is_empty() {
                return Err("Options: choose at least one partition key.".into());
            }
            if !o.inherits.is_empty() {
                return Err("Options: a partitioned table can't inherit from other tables.".into());
            }
        }
        if o.inherits.iter().any(|q| q.schema.is_empty()) {
            return Err("Options: choose a schema for each inherited table.".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn column(name: &str) -> ColumnDesign {
        ColumnDesign { name: name.into(), data_type: "integer".into(), ..Default::default() }
    }

    fn table(columns: Vec<ColumnDesign>) -> TableDesign {
        TableDesign { schema: "public".into(), name: "t".into(), columns, ..Default::default() }
    }

    #[test]
    fn normalizing_trims_and_forces_not_null_on_keys_and_identities() {
        let design = table(vec![
            ColumnDesign { name: " id ".into(), key_order: Some(1), ..column("") },
            ColumnDesign { identity: Some(Identity::Always), default: Some("  ".into()), ..column("n") },
            ColumnDesign { comment: Some("".into()), ..column("c") },
        ])
        .normalized();
        assert_eq!(design.columns[0].name, "id");
        assert!(design.columns[0].not_null);
        assert!(design.columns[1].not_null);
        assert_eq!(design.columns[1].default, None);
        assert!(!design.columns[2].not_null);
        assert_eq!(design.columns[2].comment, None);
    }

    #[test]
    fn validation_rejects_bad_designs() {
        let ok = table(vec![column("a")]);
        assert_eq!(ok.validate(), Ok(()));

        let cases = [
            TableDesign { name: "".into(), ..ok.clone() },
            table(vec![]),
            table(vec![column("")]),
            table(vec![column("a"), column("a")]),
            table(vec![ColumnDesign { data_type: "".into(), ..column("a") }]),
            table(vec![ColumnDesign { length: Some(0), ..column("a") }]),
            table(vec![ColumnDesign { scale: Some(2), ..column("a") }]),
            table(vec![ColumnDesign { default: Some("1".into()), identity: Some(Identity::Always), ..column("a") }]),
        ];
        for case in cases {
            assert!(case.validate().is_err(), "{case:?}");
        }
    }
}
