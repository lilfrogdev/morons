use crate::model::{Approval, ApprovalDecision, ApprovalState};
use gpui::{prelude::*, *};

// Backend snapshots own decisions. Closing or reconstructing this entity does not decide or cancel.
pub struct ApprovalView {
    records: Vec<Approval>,
    submitted: Option<String>,
}
impl EventEmitter<ApprovalDecision> for ApprovalView {}
impl ApprovalView {
    pub fn new() -> Self {
        Self {
            records: vec![],
            submitted: None,
        }
    }
    pub fn set_records(&mut self, records: Vec<Approval>, cx: &mut Context<Self>) {
        if self.submitted.as_ref().is_some_and(|id| {
            !records
                .iter()
                .any(|record| &record.id == id && record.state == ApprovalState::Pending)
        }) {
            self.submitted = None;
        }
        self.records = records;
        cx.notify();
    }
    // Call on an explicit transport failure to let the owner retry manually.
    pub fn reset_submission(&mut self, cx: &mut Context<Self>) {
        self.submitted = None;
        cx.notify();
    }
    fn decide(&mut self, decision: ApprovalDecision, cx: &mut Context<Self>) {
        if self.submitted.is_some() || !self.records.iter().any(|record| decision.matches(record)) {
            return;
        }
        self.submitted = Some(decision.id.clone());
        cx.emit(decision);
        cx.notify();
    }
}
impl Default for ApprovalView {
    fn default() -> Self {
        Self::new()
    }
}
impl Render for ApprovalView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let record = self
            .records
            .iter()
            .find(|record| {
                record.state == ApprovalState::Pending
                    && record.tool_name == "request_user_confirmation"
                    && record.valid()
            })
            .cloned();
        let submitted = self.submitted.is_some();
        div().id("approval-panel").flex().flex_col().when_some(record, |view, record| {
            let approve = record.decision(true); let deny = record.decision(false);
            let message = record.args.get("message").and_then(|value| value.as_str()).unwrap_or("Review exact tool arguments below").to_owned();
            view.p_4().gap_2().rounded_lg().bg(rgb(0xFFF3D6))
                .child(div().font_weight(FontWeight::BOLD).child("Waiting for your confirmation"))
                .child(message)
                .child(format!("Tool: {} · Task: {}", record.tool_name, record.task_id))
                .child(record.args.to_string())
                .child(format!("Intent: {} · Expires at UTC epoch ms: {}", record.digest, record.expires_at))
                .child("This confirmation performs no external action and does not authorize other tools or future actions.")
                .child(div().flex().gap_2()
                    .child(div().id("approve-tool").role(gpui::Role::Button).aria_label("Approve this confirmation").p_2().rounded_md().bg(rgb(0xD8EFE1)).child(if submitted { "Submitting…" } else { "Approve" }).when(!submitted, |button| button.cursor_pointer().on_click(cx.listener(move |view, _, _, cx| view.decide(approve.clone(), cx)))))
                    .child(div().id("deny-tool").role(gpui::Role::Button).aria_label("Deny this confirmation").p_2().rounded_md().bg(rgb(0xF4DCDD)).child("Deny").when(!submitted, |button| button.cursor_pointer().on_click(cx.listener(move |view, _, _, cx| view.decide(deny.clone(), cx))))))
        })
    }
}
