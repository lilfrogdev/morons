use gpui::{prelude::*, *};
use morons_desktop::{permissions::{PermissionState, MODES, mode_label}, transport::Command};
use super::{Chat, activation_key, button};

const LOCK: &[u8] = include_bytes!("assets/tabler/lock.svg");
const CHEVRON: &[u8] = include_bytes!("assets/tabler/chevron-down.svg");
pub(super) fn trigger(chat: &Chat, permissions: PermissionState, compact: bool, cx: &mut Context<Chat>) -> Stateful<Div> {
    div().id("permission-selector").role(gpui::Role::Button)
        .aria_label(SharedString::from(format!("Permissions: {}", mode_label(&permissions.mode))))
        .aria_expanded(chat.show_permissions).focusable().tab_stop(true).cursor_pointer()
        .max_w(px(if compact { 100. } else { 155. })).min_w_0().h(px(28.)).px(px(5.)).rounded(px(6.)).hover(|d| d.bg(rgb(0xECEEF1)))
        .flex().items_center().gap(px(4.)).text_size(px(12.))
        .child(svg().data(LOCK).w(px(14.)).h(px(14.)).text_color(rgb(0x626772)))
        .child(div().min_w_0().truncate().child(mode_label(&permissions.mode)))
        .child(svg().data(CHEVRON).w(px(12.)).h(px(12.)).text_color(rgb(0x80858D)))
        .on_click(cx.listener(|view, _, _, cx| {
            view.show_permissions = !view.show_permissions;
            view.show_model = false; view.show_effort = false;
            cx.stop_propagation(); cx.notify();
        }))
        .on_key_down(cx.listener(|view, event: &KeyDownEvent, _, cx| {
            if activation_key(event) {
                view.show_permissions = !view.show_permissions;
                view.show_model = false; view.show_effort = false;
                cx.stop_propagation(); cx.notify();
            }
        }))
}
pub(super) fn menu(chat: &Chat, narrow: bool, cx: &mut Context<Chat>) -> Stateful<Div> {
    let permissions = chat.state.permissions.clone();
    div().id("permission-menu").role(gpui::Role::Dialog).aria_label("Thread permissions")
        .absolute().bottom(px(72.)).left(px(if narrow { 26. } else { 190. })).w(px(320.)).max_w_full().p(px(5.))
        .rounded(px(8.)).border_1().border_color(rgb(0xE3E5E8)).bg(rgb(0xFFFFFF))
        .shadow(vec![BoxShadow::new(px(0.), px(8.), hsla(0.,0.,0.,0.12)).blur_radius(px(18.))])
        .flex().flex_col().on_click(cx.listener(|_, _, _, cx| cx.stop_propagation()))
        .children(MODES.into_iter().filter_map(|(mode, label, description)| {
            let state = permissions.as_ref()?;
            let selected = state.mode == mode;
            let session = state.session_id.clone(); let key_session = session.clone(); let revision = state.revision;
            Some(div().id(SharedString::from(format!("permission-{mode}")))
                .role(gpui::Role::Button).aria_label(SharedString::from(format!("{label}. {description}")))
                .aria_selected(selected).focusable().tab_stop(true).cursor_pointer()
                .px(px(10.)).py(px(7.)).rounded(px(5.)).bg(if selected { rgb(0xECEEF1) } else { rgb(0xFFFFFF) })
                .hover(|d| d.bg(rgb(0xF3F4F6)))
                .flex().items_start().gap(px(8.))
                .child(div().w(px(14.)).text_size(px(12.)).child(if selected { "✓" } else { "" }))
                .child(div().flex_1().min_w_0().flex().flex_col().gap(px(3.))
                    .child(div().text_size(px(12.)).font_weight(FontWeight::MEDIUM).child(label))
                    .child(div().text_size(px(11.)).text_color(rgb(0x626772)).child(description)))
                .on_click(cx.listener(move |view, _, _, cx| {
                    view.command(Command::SelectPermission { session_id: session.clone(), mode: mode.into(), revision }, cx);
                    view.show_permissions = false; cx.stop_propagation(); cx.notify();
                }))
                .on_key_down(cx.listener(move |view, event: &KeyDownEvent, _, cx| {
                    if activation_key(event) {
                        view.command(Command::SelectPermission { session_id: key_session.clone(), mode: mode.into(), revision }, cx);
                        view.show_permissions = false; cx.stop_propagation(); cx.notify();
                    }
                })))
        }))
        .when(permissions.as_ref().is_some_and(|state| state.mode == "auto" && !state.auto_review_supported), |d|
            d.child(div().px(px(10.)).py(px(7.)).text_size(px(11.)).text_color(rgb(0x626772))
                .child("Automatic review is unavailable for Pi. Commands and file changes ask for approval.")))
}
pub(super) fn pending(chat: &Chat, cx: &mut Context<Chat>) -> Div {
    div().flex().flex_col().children(chat.state.permissions.iter().flat_map(|state| state.pending.iter()).map(|request| {
        let approve = request.clone(); let reject = request.clone();
        let approve_key = request.clone(); let reject_key = request.clone();
        let title = match request.kind.as_str() {
            "source-apply" => "Approve applying reviewed changes to source",
            "external-request" => "Approve separately billed API request",
            "edit" => "Approve file change", _ => "Approve command",
        };
        div().id(SharedString::from(format!("permission-request-{}", request.id)))
            .role(gpui::Role::Region).aria_label(title)
            .mx_6().mb_3().p_3().rounded_sm().border_1().border_color(rgb(0xBAC8D3)).bg(rgb(0xFFFFFF))
            .flex().flex_col().gap_2()
            .child(div().font_weight(FontWeight::BOLD).child(title))
            .when(request.kind == "source-apply", |d| d.child(div().text_xs()
                .child("Applies and stages this reviewed patch in source. No commit is created.")))
            .child(div().id("permission-exact-action").max_h(px(180.)).overflow_y_scroll()
                .p_2().bg(rgb(0xF3F6F8)).font_family("Menlo").text_size(px(11.)).child(request.preview()))
            .child(div().text_size(px(10.)).font_family("Menlo").child(format!("SHA-256: {}", request.fingerprint)))
            .child(div().flex().gap_2()
                .child(button("permission-approve", "Approve once")
                    .on_click(cx.listener(move |view, _, _, cx| view.command(Command::PermissionDecision {
                        session_id: approve.session_id.clone(), id: approve.id.clone(), fingerprint: approve.fingerprint.clone(), approve: true,
                    }, cx)))
                    .on_key_down(cx.listener(move |view, event: &KeyDownEvent, _, cx| {
                        if activation_key(event) { view.command(Command::PermissionDecision {
                            session_id: approve_key.session_id.clone(), id: approve_key.id.clone(), fingerprint: approve_key.fingerprint.clone(), approve: true,
                        }, cx); cx.stop_propagation(); }
                    })))
                .child(button("permission-reject", "Reject")
                    .on_click(cx.listener(move |view, _, _, cx| view.command(Command::PermissionDecision {
                        session_id: reject.session_id.clone(), id: reject.id.clone(), fingerprint: reject.fingerprint.clone(), approve: false,
                    }, cx)))
                    .on_key_down(cx.listener(move |view, event: &KeyDownEvent, _, cx| {
                        if activation_key(event) { view.command(Command::PermissionDecision {
                            session_id: reject_key.session_id.clone(), id: reject_key.id.clone(), fingerprint: reject_key.fingerprint.clone(), approve: false,
                        }, cx); cx.stop_propagation(); }
                    }))))
    }))
}
