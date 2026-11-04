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
