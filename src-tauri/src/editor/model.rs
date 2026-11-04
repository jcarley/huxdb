//! The data editor's IPC models: a table's editable shape, one page of rows,
//! and the batch of pending edits the grid sends on Commit.

use serde::{Deserialize, Serialize};

/// One column of the table being edited.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DataColumn {
    pub name: String,
    /// `format_type()` output, e.g. `numeric(10,2)`; values are cast to it.
    pub type_name: String,
    pub nullable: bool,
    /// Has a DEFAULT (or is an identity column), so a new row can leave it out.
    pub has_default: bool,
    /// Why the column can't be edited (binary, generated, identity ALWAYS), if so.
    pub read_only: Option<String>,
    /// Its type has default ordering and equality operators (json doesn't).
    pub comparable: bool,
    /// The base type without its modifier, e.g. `numeric`, which filter values
    /// are cast to: `numeric(10,2)` would round them, `varchar(3)` cut them
    /// and a domain's CHECK reject them.
    pub filter_type: String,
    /// Its base type is a string type, so a value can be the empty string.
    pub text_like: bool,
}

/// The table's columns and primary key, reloaded with every page.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DataSource {
    pub columns: Vec<DataColumn>,
    /// Primary key column names in key order; empty when there is none.
    pub primary_key: Vec<String>,
    /// Why the whole table is read-only (no primary key), if so.
    pub read_only: Option<String>,
}

/// A page of rows, every value as text (`None` for NULL), in column order.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DataPage {
    pub source: DataSource,
    pub rows: Vec<Vec<Option<String>>>,
}

/// How a [`FilterNode::Group`] joins its children.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum GroupOp {
    And,
    Or,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum FilterOp {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    Contains,
    BeginsWith,
    EndsWith,
    IsNull,
    IsNotNull,
    IsEmpty,
    Between,
    In,
}

/// A structured filter: conditions on columns, joined in groups. Any node can
/// be negated (SQL `NOT`) or disabled, which leaves it out of the query.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum FilterNode {
    Group {
        op: GroupOp,
        children: Vec<FilterNode>,
        #[serde(default)]
        negated: bool,
        #[serde(default)]
        disabled: bool,
    },
    /// `value` is the comparison's or text match's value, `values` the two
    /// ends of a between or the items of an in-list. All are bound.
    Condition {
        column: String,
        op: FilterOp,
        value: Option<String>,
        #[serde(default)]
        values: Vec<String>,
        #[serde(default)]
        negated: bool,
        #[serde(default)]
        disabled: bool,
    },
    /// The user's SQL expression, treated like the typed WHERE.
    Custom {
        sql: String,
        #[serde(default)]
        negated: bool,
        #[serde(default)]
        disabled: bool,
    },
}

/// One level of a sort.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SortKey {
    pub column: String,
    pub descending: bool,
}

/// Which rows a data tab shows, and in what order. The typed parts are the
/// user's SQL, run only in a read-only scope.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DataSpec {
    pub filter: Option<FilterNode>,
    pub sort: Vec<SortKey>,
    /// ANDed with `filter`.
    pub where_sql: Option<String>,
    /// Sorts after `sort`; the UI only ever sets one of the two.
    pub order_sql: Option<String>,
}

/// A column's new value (`None` = NULL).
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CellValue {
    pub column: String,
    pub value: Option<String>,
}

/// Changed cells of an existing row, found by its original primary key values.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RowUpdate {
    pub key: Vec<String>,
    pub values: Vec<CellValue>,
}

/// The grid's pending edits. Rows are found by their original primary key
/// values (in `DataSource::primary_key` order); a new row lists only the
/// columns that were edited, so the others get their defaults.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EditBatch {
    pub deletes: Vec<Vec<String>>,
    pub updates: Vec<RowUpdate>,
    pub inserts: Vec<Vec<CellValue>>,
}
