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

impl TableDesign {
    /// Trims names and types, and blanks out empty defaults and comments.
    pub fn normalized(&self) -> Self {
        Self {
            schema: self.schema.clone(),
            name: self.name.trim().to_string(),
            comment: clean(&self.comment),
            primary_key_name: clean(&self.primary_key_name),
            columns: self.columns.iter().map(ColumnDesign::normalized).collect(),
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
