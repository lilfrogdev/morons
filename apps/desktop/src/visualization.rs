


use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Deserialize, Serialize)]
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

#[derive(Debug, Clone, Deserialize, Serialize)]
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
    Document {
        title: String,
        summary: String,
        nodes: Vec<DocumentNode>,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum DocumentNode {
    Text(DocumentText),
    Element(DocumentElement),
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DocumentText {
    pub text: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DocumentElement {
    pub tag: String,
    #[serde(default)]
    pub children: Option<Vec<DocumentNode>>,
}

fn valid_nodes(nodes: &[DocumentNode], depth: usize, count: &mut usize) -> bool {
    if depth > 12 {
        return false;
    }
    for node in nodes {
        *count += 1;
        if *count > 512 {
            return false;
        }
        match node {
            DocumentNode::Text(value) => {
                if value.text.len() > 4096
                    || value.text.chars().any(|c| {
                        c == '\0' || (c.is_control() && c != '\n' && c != '\t' && c != '\r')
                    })
                {
                    return false;
                }
            }
            DocumentNode::Element(element) => {
                if !matches!(
                    element.tag.as_str(),
                    "section"
                        | "p"
                        | "span"
                        | "h2"
                        | "h3"
                        | "strong"
                        | "em"
                        | "small"
                        | "code"
                        | "pre"
                        | "ul"
                        | "ol"
                        | "li"
                        | "br"
                        | "hr"
                ) || (matches!(element.tag.as_str(), "br" | "hr") && element.children.is_some())
                    || !valid_nodes(element.children.as_deref().unwrap_or(&[]), depth + 1, count)
                {
                    return false;
                }
            }
        }
    }
    true
}

#[derive(Debug, Clone, Deserialize, Serialize)]
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
            VisualizationContent::Document {
                title,
                summary,
                nodes,
            } => {
                let mut count = 0;
                label_ok(title, 120)
                    && label_ok(summary, 2000)
                    && !nodes.is_empty()
                    && valid_nodes(nodes, 1, &mut count)
            }
        };
        valid.then_some(doc)
    }
}


pub struct VisualizationLease {
    account_id: String,
    thread_id: String,
    access_epoch: String,
    expires_at: Instant,
    documents: Vec<VisualizationDocument>,
}

impl VisualizationLease {
    pub fn expires_at(&self) -> Instant { self.expires_at }
    pub fn parse(bytes: &[u8], account_id: &str, thread_id: &str, now: Instant) -> Option<Self> {
        if bytes.len() > 524_288 {
            return None;
        }
        let envelope: VisualizationEnvelope = serde_json::from_slice(bytes).ok()?;
        if envelope.account_id != account_id
            || envelope.thread_id != thread_id
            || !label_ok(&envelope.access_epoch, 128)
            || !(1..=5000).contains(&envelope.lease_ms)
            || envelope.documents.len() > 10
            || envelope
                .documents
                .iter()
                .map(|document| &document.id)
                .collect::<std::collections::HashSet<_>>()
                .len()
                != envelope.documents.len()
            || envelope.documents.iter().any(|document| {
                document.account_id != account_id
                    || document.thread_id != thread_id
                    || VisualizationDocument::parse_for_thread(
                        &serde_json::to_vec(document).unwrap_or_default(),
                        account_id,
                        thread_id,
                    )
                    .is_none()
            })
        {
            return None;
        }
        Some(Self {
            account_id: account_id.into(),
            thread_id: thread_id.into(),
            access_epoch: envelope.access_epoch,
            expires_at: now + Duration::from_millis(envelope.lease_ms),
            documents: envelope.documents,
        })
    }
    pub fn documents(
        &self,
        account_id: &str,
        thread_id: &str,
        access_epoch: &str,
        now: Instant,
    ) -> Option<&[VisualizationDocument]> {
        (self.account_id == account_id
            && self.thread_id == thread_id
            && self.access_epoch == access_epoch
            && now < self.expires_at)
            .then_some(&self.documents)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VisualizationEnvelope {
    account_id: String,
    thread_id: String,
    access_epoch: String,
    lease_ms: u64,
    documents: Vec<VisualizationDocument>,
}

#[cfg(feature = "native")]
fn document_text(nodes: &[DocumentNode], lines: &mut Vec<String>, current: &mut String) {
    for node in nodes {
        match node {
            DocumentNode::Text(text) => current.push_str(&text.text),
            DocumentNode::Element(element) => {
                let block = matches!(
                    element.tag.as_str(),
                    "section" | "p" | "h2" | "h3" | "pre" | "li"
                );
                if block && !current.is_empty() {
                    lines.push(std::mem::take(current));
                }
                if let Some(children) = &element.children {
                    document_text(children, lines, current);
                }
                if block && !current.is_empty() {
                    lines.push(std::mem::take(current));
                }
            }
        }
    }
}


#[cfg(feature = "native")]
pub fn render_native(document: &VisualizationDocument) -> gpui::Div {
    use gpui::{prelude::*, *};
    let mut body = div().flex().flex_col().gap_2();
    match &document.content {
        VisualizationContent::Bar { title, points, .. }
        | VisualizationContent::Line { title, points, .. } => {
            body = body.child(div().font_weight(FontWeight::BOLD).child(title.clone()));
            let max = points.iter().map(|p| p.value.abs()).fold(0.0_f64, f64::max);
            for point in points {
                let fraction = if max == 0.0 {
                    0.0
                } else {
                    (point.value.abs() / max).clamp(0.0, 1.0)
                };
                body = body.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .child(format!("{}: {}", point.label, point.value))
                        .child(
                            div()
                                .h(px(6.))
                                .w(px(300. * fraction as f32))
                                .bg(rgb(0x557080)),
                        ),
                );
            }
        }
        VisualizationContent::Table {
            title,
            columns,
            rows,
        } => {
            body = body
                .child(div().font_weight(FontWeight::BOLD).child(title.clone()))
                .child(div().child(columns.join("  |  ")));
            for row in rows {
                body = body.child(div().child(row.join("  |  ")));
            }
        }
        VisualizationContent::Document {
            title,
            summary,
            nodes,
        } => {
            body = body
                .child(div().font_weight(FontWeight::BOLD).child(title.clone()))
                .child(div().child(summary.clone()));
            let mut lines = Vec::new();
            let mut current = String::new();
            document_text(nodes, &mut lines, &mut current);
            if !current.is_empty() {
                lines.push(current);
            }
            for line in lines {
                body = body.child(div().child(line));
            }
        }
    }
    body.p_3().rounded_sm().bg(rgb(0xffffff))
}
