//! Native, data-only representation of a server-authorized visualization.
//! A view may draw these values with GPUI primitives; it must never load markup or scripts.

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisualizationDocument {
    pub version: u8,
    pub id: String,
    pub account_id: String,
    pub thread_id: String,
    pub source_message_id: String,
    pub source_revision: String,
    pub created_at: u64,
    pub content: VisualizationContent,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum VisualizationContent {
    Bar {
        title: String,
        #[serde(rename = "xLabel")]
        x_label: String,
        #[serde(rename = "yLabel")]
        y_label: String,
        points: Vec<Point>,
    },
    Line {
        title: String,
        #[serde(rename = "xLabel")]
        x_label: String,
        #[serde(rename = "yLabel")]
        y_label: String,
        points: Vec<Point>,
    },
    Table {
        title: String,
        columns: Vec<String>,
        rows: Vec<Vec<String>>,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Point {
    pub label: String,
    pub value: f64,
}

fn label_ok(value: &str, limit: usize) -> bool {
    !value.trim().is_empty()
        && value.chars().count() <= limit
        && !value.chars().any(char::is_control)
}

impl VisualizationDocument {
    /// Client context check is defense in depth. The server must authorize every read.
    pub fn parse_for_thread(bytes: &[u8], account_id: &str, thread_id: &str) -> Option<Self> {
        if bytes.len() > 32_768 {
            return None;
        }
        let doc: Self = serde_json::from_slice(bytes).ok()?;
        if doc.version != 1
            || doc.account_id != account_id
            || doc.thread_id != thread_id
            || doc.created_at == 0
            || doc.created_at > 9_007_199_254_740_991
            || ![
                &doc.id,
                &doc.account_id,
                &doc.thread_id,
                &doc.source_message_id,
                &doc.source_revision,
            ]
            .iter()
            .all(|s| label_ok(s, 128))
        {
            return None;
        }
        let valid = match &doc.content {
            VisualizationContent::Bar {
                title,
                x_label,
                y_label,
                points,
            }
            | VisualizationContent::Line {
                title,
                x_label,
                y_label,
                points,
            } => {
                label_ok(title, 120)
                    && label_ok(x_label, 80)
                    && label_ok(y_label, 80)
                    && (1..=128).contains(&points.len())
                    && points
                        .iter()
                        .all(|p| label_ok(&p.label, 80) && p.value.is_finite())
            }
            VisualizationContent::Table {
                title,
                columns,
                rows,
            } => {
                label_ok(title, 120)
                    && (1..=12).contains(&columns.len())
                    && columns.iter().all(|s| label_ok(s, 80))
                    && rows.len() <= 128
                    && rows.iter().all(|row| {
                        row.len() == columns.len() && row.iter().all(|cell| label_ok(cell, 256))
                    })
            }
        };
        valid.then_some(doc)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = r#"{"version":1,"id":"viz-1","accountId":"a","threadId":"t","sourceMessageId":"m","sourceRevision":"r","createdAt":1,"content":{"kind":"bar","title":"Checks","xLabel":"Run","yLabel":"Passed","points":[{"label":"one","value":3}]}}"#;

    #[test]
    fn accepts_only_current_context_and_data_only_content() {
        assert!(VisualizationDocument::parse_for_thread(GOOD.as_bytes(), "a", "t").is_some());
        assert!(VisualizationDocument::parse_for_thread(GOOD.as_bytes(), "other", "t").is_none());
        assert!(VisualizationDocument::parse_for_thread(GOOD.as_bytes(), "a", "other").is_none());
        let with_script = GOOD.replace(
            "\"title\":\"Checks\"",
            "\"script\":\"alert(1)\",\"title\":\"Checks\"",
        );
        assert!(
            VisualizationDocument::parse_for_thread(with_script.as_bytes(), "a", "t").is_none()
        );
    }

    #[test]
    fn rejects_unsupported_kind_and_excessive_size() {
        let html = GOOD.replace("\"kind\":\"bar\"", "\"kind\":\"html\"");
        assert!(VisualizationDocument::parse_for_thread(html.as_bytes(), "a", "t").is_none());
        assert!(VisualizationDocument::parse_for_thread(&vec![b'x'; 32_769], "a", "t").is_none());
    }
}
