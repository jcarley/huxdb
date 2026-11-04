//! The view designer's edit state. Like tables, the frontend keeps the design
//! as loaded and as edited, and the DDL generator diffs them.

use serde::{Deserialize, Serialize};

/// `WITH [LOCAL | CASCADED] CHECK OPTION` for auto-updatable views.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CheckOption {
    Local,
    Cascaded,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ViewDesign {
    pub schema: String,
    pub name: String,
    /// The SELECT, as PostgreSQL normalized it (`pg_get_viewdef`) or as typed.
    pub definition: String,
    /// `None` on a new view means the current user.
    pub owner: Option<String>,
    pub comment: Option<String>,
    pub check_option: Option<CheckOption>,
    pub security_barrier: bool,
    /// PostgreSQL 15+.
    pub security_invoker: bool,
    /// Read-only: whether the server has `security_invoker` (15+). Not diffed.
    #[serde(default)]
    pub supports_security_invoker: bool,
}

fn clean(value: &Option<String>) -> Option<String> {
    value.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

impl ViewDesign {
    /// Trims text and drops the definition's trailing semicolon.
    pub fn normalized(&self) -> Self {
        let definition = self.definition.trim();
        Self {
            name: self.name.trim().to_string(),
            definition: definition.strip_suffix(';').unwrap_or(definition).trim_end().to_string(),
            owner: clean(&self.owner),
            comment: clean(&self.comment),
            ..self.clone()
        }
    }

    /// Checks a normalized design; PostgreSQL validates the SELECT itself.
    pub fn validate(&self) -> Result<(), String> {
        if self.name.is_empty() {
            return Err("View name is required.".into());
        }
        if self.definition.is_empty() {
            return Err("The view definition is required.".into());
        }
        Ok(())
    }
}
