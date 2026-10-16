#[cfg(not(any(
    all(target_os = "macos", target_arch = "aarch64"),
    target_os = "windows"
)))]
compile_error!("Morons desktop currently targets macOS Apple Silicon and Windows");

mod input;
mod drafts;
use gpui::{prelude::*, *};
use morons_desktop::{
    model::{Role, TaskStatus},
    transport::{Command, Config, State, Worker},
};

const ICON_PLUS: &[u8] = include_bytes!("assets/tabler/plus.svg");
const ICON_SEND: &[u8] = include_bytes!("assets/tabler/arrow-up.svg");
const ICON_MIC: &[u8] = include_bytes!("assets/tabler/microphone.svg");
const ICON_HOME: &[u8] = include_bytes!("assets/tabler/home.svg");
const ICON_FOLDER: &[u8] = include_bytes!("assets/tabler/folder.svg");
const ICON_AGENT: &[u8] = include_bytes!("assets/tabler/robot.svg");
const ICON_CPU: &[u8] = include_bytes!("assets/tabler/cpu.svg");
const ICON_OPENAI: &[u8] = include_bytes!("assets/tabler/brand-openai.svg");
const ICON_SEARCH: &[u8] = include_bytes!("assets/tabler/search.svg");
const ICON_STAR: &[u8] = include_bytes!("assets/tabler/star.svg");
const ICON_STAR_FILLED: &[u8] = include_bytes!("assets/tabler/star-filled.svg");
const ICON_CHEVRON: &[u8] = include_bytes!("assets/tabler/chevron-down.svg");
const ICON_BOLT: &[u8] = include_bytes!("assets/tabler/bolt.svg");
fn provider_icon(provider: &str) -> &'static [u8] { if provider == "openai" { ICON_OPENAI } else { ICON_CPU } }
fn model_icon(model_id: &str) -> &'static [u8] {
    let id = model_id.to_ascii_lowercase();
    if id.starts_with("gpt-") || id.starts_with("chatgpt-") ||
        id.starts_with("o1") || id.starts_with("o3") || id.starts_with("o4") {
        ICON_OPENAI
    } else { ICON_CPU }
}
fn provider_name(provider: &str) -> &str { if provider == "morons-fixture" { "Demo · synthetic replies" } else if provider == "openai" { "OpenAI" } else { provider } }
fn model_label(provider: &str, label: &str) -> String {
    if provider == "morons-fixture" { label.replace("Offline fixture", "Demo").replace("Offline alternate", "Demo alternate") } else { label.to_owned() }
}
fn model_version(id: &str) -> (u16, u16) {
    let version = id.strip_prefix("gpt-").or_else(|| id.strip_prefix('o')).unwrap_or("");
    let mut parts = version.split(|c: char| !c.is_ascii_digit() && c != '.').next().unwrap_or("").split('.');
    (parts.next().and_then(|v| v.parse().ok()).unwrap_or(0),
        parts.next().and_then(|v| v.parse().ok()).unwrap_or(0))
}

actions!(morons, [SendMessage, Quit, FocusNext, FocusPrevious]);
struct Chat {
    input: Entity<input::TextInput>,
    model_search: Entity<input::TextInput>,
    login_name: Entity<input::TextInput>,
    login_password: Entity<input::TextInput>,
    workspace_input: Entity<input::TextInput>,
    moron_input: Entity<input::TextInput>,
    bootstrap_token: Entity<input::TextInput>,
    provider_callback: Entity<input::TextInput>,
    worker: Worker,
    state: State,

    _updates: Task<()>,
    local_error: Option<&'static str>,
    last_ack: Option<String>,
    scroll: ScrollHandle,
    show_model: bool,
    show_effort: bool,
    model_section: String,
    model_cursor: usize,
    auth_signup: bool,
    show_workspaces: bool,
    show_create_moron: bool,
    show_pinned: bool,
    show_morons: bool,
    show_repositories: bool,
    show_profile: bool,
    drafts: drafts::Drafts,
    _input_subscription: Subscription,
}
impl Chat {
    fn new(config: Config, cx: &mut Context<Self>) -> Self {
        let input = cx.new(input::TextInput::new);
        let model_search = cx.new(|cx| { let mut field = input::TextInput::new(cx); field.set_id("model-search"); field.set_placeholder("Search models…"); field });
        let input_subscription = cx.observe(&input, |_, _, cx| cx.notify());
        cx.observe(&model_search, |_, _, cx| cx.notify()).detach();
        let login_name = cx.new(|cx| { let mut field = input::TextInput::new(cx); field.set_id("account-name"); field.set_placeholder("Username"); field });
        let login_password = cx.new(|cx| { let mut field = input::TextInput::new_secret(cx); field.set_id("account-password"); field });
        let workspace_input = cx.new(|cx| { let mut field = input::TextInput::new(cx); field.set_id("workspace-name"); field.set_placeholder("Workspace name"); field });
        let moron_input = cx.new(|cx| { let mut field = input::TextInput::new(cx); field.set_id("new-moron-name"); field.set_placeholder("Moron name"); field });
        let bootstrap_token = cx.new(|cx| { let mut field = input::TextInput::new_secret(cx); field.set_id("bootstrap-token"); field.set_placeholder("Setup code"); field });
        let provider_callback = cx.new(|cx| { let mut field = input::TextInput::new_secret(cx); field.set_id("provider-callback"); field.set_placeholder("Paste final callback URL if needed"); field });
        let (worker, updates) = Worker::start(config);
        let task = cx.spawn(async move |view, cx| {
            while let Ok(state) = updates.recv().await {
                if view
                    .update(cx, |view, cx| {
                        if let Some((id, text)) = &state.accepted
                            && view.state.selected_moron == state.selected_moron
                            && view.last_ack.as_ref() != Some(id)
                        {
                            view.last_ack = Some(id.clone());
                            view.input.update(cx, |input, cx| {
                                if input.text() == text {
                                    input.reset();
                                    cx.notify();
                                }
                            });
                        }
                        let follow = view.scroll.max_offset().y + view.scroll.offset().y < px(60.);
                        if view.state.account_login && !state.account_login {
                            view.auth_signup = false;
                            view.login_password.update(cx, |field, cx| { field.reset(); cx.notify(); });
                            view.bootstrap_token.update(cx, |field, cx| { field.reset(); cx.notify(); });
                        }
                        if !view.state.account_login && state.account_login {
                            for field in [&view.input, &view.login_name, &view.login_password,
                                &view.bootstrap_token, &view.provider_callback] {
                                field.update(cx, |field, cx| { field.reset(); cx.notify(); });
                            }
                            view.last_ack = None;
                            view.local_error = None;
                            view.drafts.clear();
                            view.show_model = false;
                            view.show_effort = false;
                            view.show_workspaces = false;
                            view.show_create_moron = false;
                            view.show_profile = false;
                            view.workspace_input.update(cx, |field, cx| { field.reset(); cx.notify(); });
                            view.moron_input.update(cx, |field, cx| { field.reset(); cx.notify(); });
                            view.model_section.clear();
                            view.model_cursor = 0;
                            view.model_search.update(cx, |field, cx| { field.reset(); cx.notify(); });
                        } else if view.state.selected_moron != state.selected_moron {
                            let current = view.input.read(cx).text().to_owned();
                            let restored = view.drafts.switch(state.selected_moron.as_deref(), &current);
                            view.input.update(cx, |input, cx| { input.set_text(restored); cx.notify(); });
                            view.last_ack = None;
                            view.show_model = false;
                            view.show_effort = false;
                            view.model_search.update(cx, |field, cx| { field.reset(); cx.notify(); });
                        }
                        if view.state.selected_workspace != state.selected_workspace {
                            view.show_workspaces = false;
                            view.show_profile = false;
                            view.workspace_input.update(cx, |field, cx| { field.reset(); cx.notify(); });
                        }
                        if view.state.selected_moron != state.selected_moron {
                            view.show_create_moron = false;
                            view.moron_input.update(cx, |field, cx| { field.reset(); cx.notify(); });
                        }
                        view.state = state;
                        if follow {
                            view.scroll.scroll_to_bottom();
                        }
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        });
        Self {
            input,
            model_search,
            login_name,
            login_password,
            workspace_input,
            moron_input,
            bootstrap_token,
            provider_callback,
            worker,
            state: State::default(),
            _updates: task,
            local_error: None,
            last_ack: None,
            scroll: ScrollHandle::new(),
            show_model: false,
            show_effort: false,
            model_section: String::new(),
            model_cursor: 0,
            auth_signup: false,
            show_workspaces: false,
            show_create_moron: false,
            show_pinned: true,
            show_morons: true,
            show_repositories: true,
            show_profile: false,
            drafts: drafts::Drafts::default(),
            _input_subscription: input_subscription,
        }
    }
    fn visible_models(&self, cx: &Context<Self>) -> Vec<morons_desktop::transport::ModelOption> {
        let query = self.model_search.read(cx).text().to_lowercase();
        let tokens: Vec<_> = query.split_whitespace().collect();
        let mut visible: Vec<_> = self.state.models.iter().filter(|option| {
            if !option.available && !self.state.selected_model.as_ref().is_some_and(|(provider, id)|
                provider == &option.provider && id == &option.id) { return false; }
            if !tokens.is_empty() {
                let haystack = format!("{} {} {}", option.label, option.id, provider_name(&option.provider)).to_lowercase();
                tokens.iter().all(|token| haystack.contains(token))
            } else if self.model_section == "favorites" {
                self.state.model_favorites.contains(&(option.provider.clone(), option.id.clone()))
            } else { option.provider == self.model_section }
        }).cloned().collect();
        visible.sort_by(|a, b| b.release_date.cmp(&a.release_date)
            .then_with(|| model_version(&b.id).cmp(&model_version(&a.id)))
            .then_with(|| b.id.cmp(&a.id)));
        visible
    }
    fn open_model_menu(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.show_model = !self.show_model;
        self.show_effort = false;
        if self.show_model {
            self.model_section = self.state.selected_model.as_ref().map(|item| item.0.clone())
                .or_else(|| self.state.models.first().map(|item| item.provider.clone())).unwrap_or_default();
            self.model_cursor = 0;
            self.model_search.update(cx, |field, cx| { field.reset(); cx.notify(); });
            window.focus(&self.model_search.focus_handle(cx), cx);
        }
        cx.notify();
    }
    fn choose_model(&mut self, provider: String, id: String, cx: &mut Context<Self>) {
        if self.state.models.iter().any(|option| option.provider == provider && option.id == id && option.available) {
            self.show_model = false;
            self.command(Command::SelectModel { provider, id }, cx);
        }
    }
    fn toggle_favorite(&mut self, provider: String, id: String, favorite: bool, cx: &mut Context<Self>) {
        self.command(Command::ToggleModelFavorite { provider: provider.clone(), id: id.clone(), favorite }, cx);
        if self.local_error.is_none() {
            self.state.model_favorites.retain(|item| item != &(provider.clone(), id.clone()));
            if favorite { self.state.model_favorites.push((provider, id)); }
            cx.notify();
        }
    }
    fn send(&mut self, _: &SendMessage, window: &mut Window, cx: &mut Context<Self>) {
        if self.show_model && self.model_search.focus_handle(cx).is_focused(window) {
            let choices: Vec<_> = self.visible_models(cx).into_iter().filter(|option| option.available).collect();
            if let Some(option) = choices.get(self.model_cursor).or_else(|| choices.first()) {
                self.choose_model(option.provider.clone(), option.id.clone(), cx);
                window.focus(&self.input.focus_handle(cx), cx);
            }
            return;
        }
        if self.state.account_login {
            self.account_action(self.auth_signup, cx);
            return;
        }
        if !self.state.ready {
            self.local_error = Some("Backend not ready");
            cx.notify();
            return;
        }
        if self.input.read(cx).composing() || self.state.pending {
            return;
        }
        let text = self.input.read(cx).text().to_owned();
        if text.trim().is_empty() {
            return;
        }
        if text.len() > 8192 {
            self.local_error = Some("Messages are limited to 8192 UTF-8 bytes");
            cx.notify();
            return;
        }
        match self.worker.send(Command::Submit(text)) {
            Ok(()) => {
                self.state.pending = true;
                self.local_error = None;
            }
            Err(error) => self.local_error = Some(error),
        }
        cx.notify();
    }
    fn command(&mut self, command: Command, cx: &mut Context<Self>) {
        self.local_error = self.worker.send(command).err();
        cx.notify();
    }
    fn account_action(&mut self, create: bool, cx: &mut Context<Self>) {
        let name = self.login_name.read(cx).text().trim().to_owned();
        let password = self.login_password.read(cx).text().to_owned();
        let command = if create {
            Command::AccountCreate { name, password, bootstrap: self.bootstrap_token.read(cx).text().to_owned() }
        } else { Command::AccountLogin { name, password } };
        self.command(command, cx);
        self.login_password.update(cx, |field, cx| { field.reset(); cx.notify(); });
        self.bootstrap_token.update(cx, |field, cx| { field.reset(); cx.notify(); });
    }
    fn auth_mode(&mut self, sign_up: bool, cx: &mut Context<Self>) {
        self.auth_signup = sign_up;
        self.local_error = None;
        cx.notify();
    }
    fn workspace_action(&mut self, create: bool, cx: &mut Context<Self>) {
        let name = self.workspace_input.read(cx).text().to_owned();
        let command = if create {
            let id = format!("w-{}", &uuid::Uuid::new_v4().simple().to_string()[..16]);
            Command::CreateWorkspace { id, name }
        } else { Command::RenameWorkspace(name) };
        self.command(command, cx);
        if self.local_error.is_none() {
            self.show_workspaces = false;
            self.workspace_input.update(cx, |field, cx| { field.reset(); cx.notify(); });
        }
    }
    fn create_moron(&mut self, cx: &mut Context<Self>) {
        let name = self.moron_input.read(cx).text().to_owned();
        let id = format!("m-{}", &uuid::Uuid::new_v4().simple().to_string()[..16]);
        self.command(Command::CreateMoron { id, name }, cx);
    }
    fn submit_provider_callback(&mut self, cx: &mut Context<Self>) {
        let url = self.provider_callback.read(cx).text().to_owned();
        self.command(Command::ProviderCallback(url), cx);
        self.provider_callback.update(cx, |field, cx| { field.reset(); cx.notify(); });
    }
    fn sidebar(&self, narrow: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let active = self.state.selected_moron.as_deref();
        div()
            .id("moron-sidebar")
            .role(gpui::Role::Navigation)
            .aria_label("Morons sidebar")
            .h_full()
            .w(px(if narrow { 176. } else { 272. }))
            .flex_shrink_0()
            .flex()
            .bg(rgb(0xF7F7F8))
            .border_r_1()
            .border_color(rgb(0xE3E5E8))
            .when(!narrow, |d| d.child(
                div().w(px(52.)).h_full().flex_shrink_0()
                    .border_r_1().border_color(rgb(0xE3E5E8))
                    .flex().flex_col().items_center().pt_4()
                    .child(div().w(px(38.)).h(px(38.)).rounded(px(6.))
                        .bg(rgb(0xECEEF1)).flex().items_center().justify_center()
                        .child(svg().data(ICON_HOME).w(px(20.)).h(px(20.)).text_color(rgb(0x24262B))))
            ))
            .child(
                div().flex_1().min_w_0().h_full().flex().flex_col()
                    .px_3().pt_5().pb_3()
                    .child(div().px_2().mb_2().text_size(px(17.))
                        .font_weight(FontWeight::BOLD).child("Morons"))
                    .when_some(self.state.workspace_name.clone(), |d, workspace| d
                        .child(div().id("workspace-label").role(gpui::Role::Button)
                            .aria_label("Choose workspace").aria_expanded(self.show_workspaces)
                            .focusable().tab_stop(true).px_2().mb_2().py_1()
                            .rounded(px(6.)).cursor_pointer().hover(|d| d.bg(rgb(0xECEEF1)))
                            .flex().items_center().gap_1().text_size(px(12.))
                            .text_color(rgb(0x626772)).child(workspace)
                            .child(svg().data(ICON_CHEVRON).w(px(12.)).h(px(12.)))
                            .on_click(cx.listener(|view, _, _, cx| {
                                view.show_workspaces = !view.show_workspaces;
                                cx.notify();
                            }))
                            .on_key_down(cx.listener(|view, event: &KeyDownEvent, _, cx| {
                                if !event.keystroke.modifiers.modified() &&
                                    matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                    view.show_workspaces = !view.show_workspaces;
                                    cx.stop_propagation();
                                    cx.notify();
                                }
                            })))
                        .when(self.show_workspaces, |d| d.child(
                            div().id("workspace-menu").role(gpui::Role::Region)
                                .aria_label("Workspaces").mb_4().p_2().rounded(px(6.))
                                .border_1().border_color(rgb(0xE3E5E8))
                                .bg(rgb(0xFFFFFF)).flex().flex_col().gap_1()
                                .children(self.state.workspaces.iter().map(|(id, name)| {
                                    let chosen = id.clone();
                                    let key_choice = id.clone();
                                    div().id(SharedString::from(format!("workspace-{id}")))
                                        .role(gpui::Role::Button).aria_label(SharedString::from(format!("Open workspace {name}")))
                                        .aria_selected(self.state.selected_workspace.as_deref() == Some(id.as_str()))
                                        .focusable().tab_stop(true).px_2().py_1().rounded(px(4.))
                                        .cursor_pointer().hover(|d| d.bg(rgb(0xECEEF1)))
                                        .text_size(px(12.)).child(name.clone())
                                        .on_click(cx.listener(move |view, _, _, cx| view.command(Command::SelectWorkspace(chosen.clone()), cx)))
                                        .on_key_down(cx.listener(move |view, event: &KeyDownEvent, _, cx| {
                                            if !event.keystroke.modifiers.modified() &&
                                                matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                                view.command(Command::SelectWorkspace(key_choice.clone()), cx);
                                                cx.stop_propagation();
                                            }
                                        }))
                                }))
                                .child(div().px_1().py_1().rounded_sm().border_1().border_color(rgb(0xBAC8D3))
                                    .child(self.workspace_input.clone()))
                                .child(div().flex().gap_1()
                                    .child(button("workspace-create", "Create")
                                        .on_click(cx.listener(|view, _, _, cx| view.workspace_action(true, cx))))
                                    .child(button("workspace-rename", "Rename")
                                        .on_click(cx.listener(|view, _, _, cx| view.workspace_action(false, cx))))))))
                    .child(div().id("sidebar-sections").flex_1().min_h_0().overflow_y_scroll().flex().flex_col().gap_2()
                        .child(div().id("pinned-section").role(gpui::Role::Region).aria_label("Pinned")
                            .child(div().id("pinned-heading").role(gpui::Role::Button).aria_label("Pinned")
                                .aria_expanded(self.show_pinned).focusable().tab_stop(true)
                                .px_2().py_2().cursor_pointer().text_size(px(12.))
                                .font_weight(FontWeight::BOLD).text_color(rgb(0x626772)).child("Pinned")
                                .on_click(cx.listener(|view, _, _, cx| { view.show_pinned = !view.show_pinned; cx.notify(); }))
                                .on_key_down(cx.listener(|view, event: &KeyDownEvent, _, cx| {
                                    if !event.keystroke.modifiers.modified() &&
                                        matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                        view.show_pinned = !view.show_pinned; cx.stop_propagation(); cx.notify();
                                    }
                                })))
                            .when(self.show_pinned, |d| d.child(div().id("pinned-list").role(gpui::Role::List)
                                .aria_label("Pinned shortcuts").flex().flex_col().gap_1()
                                .when(self.state.pinned_morons.is_empty(), |d| d.child(
                                    div().px_2().py_1().text_size(px(12.)).text_color(rgb(0x626772))
                                        .child("No pinned Morons")))
                                .children(self.state.named_morons.iter().filter(|(id, _)|
                                    self.state.pinned_morons.contains(id)).map(|(id, name)|
                                    moron_row(id, name, active == Some(id.as_str()), true, true, cx))))))
                        .child(div().id("morons-section").role(gpui::Role::Region).aria_label("Morons")
                            .child(div().id("morons-heading").role(gpui::Role::Button).aria_label("Morons")
                                .aria_expanded(self.show_morons).focusable().tab_stop(true)
                                .px_2().py_2().cursor_pointer().text_size(px(12.))
                                .font_weight(FontWeight::BOLD).text_color(rgb(0x626772)).child("Morons")
                                .on_click(cx.listener(|view, _, _, cx| { view.show_morons = !view.show_morons; cx.notify(); }))
                                .on_key_down(cx.listener(|view, event: &KeyDownEvent, _, cx| {
                                    if !event.keystroke.modifiers.modified() &&
                                        matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                        view.show_morons = !view.show_morons; cx.stop_propagation(); cx.notify();
                                    }
                                })))
                            .when(self.show_morons, |d| d
                                .child(button("new-moron", "New Moron")
                                    .on_click(cx.listener(|view, _, _, cx| {
                                        view.show_create_moron = !view.show_create_moron; cx.notify();
                                    }))
                                    .on_key_down(cx.listener(|view, event: &KeyDownEvent, _, cx| {
                                        if !event.keystroke.modifiers.modified() &&
                                            matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                            view.show_create_moron = !view.show_create_moron;
                                            cx.stop_propagation(); cx.notify();
                                        }
                                    })))
                                .when(self.show_create_moron, |d| d.child(
                                    div().p_2().flex().flex_col().gap_1()
                                        .child(div().px_1().py_1().rounded_sm().border_1().border_color(rgb(0xBAC8D3))
                                            .child(self.moron_input.clone()))
                                        .child(button("create-moron", "Create Moron")
                                            .on_click(cx.listener(|view, _, _, cx| view.create_moron(cx)))
                                            .on_key_down(cx.listener(|view, event: &KeyDownEvent, _, cx| {
                                                if !event.keystroke.modifiers.modified() &&
                                                    matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                                    view.create_moron(cx); cx.stop_propagation();
                                                }
                                            })))))
                                .child(div().id("moron-list").role(gpui::Role::List)
                                    .aria_label("Named Morons").flex().flex_col().gap_1()
                                    .when(self.state.named_morons.is_empty(), |d| d.child(
                                        div().px_2().py_2().text_size(px(12.))
                                            .text_color(rgb(0x626772)).child("No Morons yet")))
                                    .children(self.state.named_morons.iter().map(|(id, name)|
                                        moron_row(id, name, active == Some(id.as_str()),
                                            self.state.pinned_morons.contains(id), false, cx))))))
                        .child(div().id("repositories-section").role(gpui::Role::Region).aria_label("Repositories")
                            .child(div().id("repositories-heading").role(gpui::Role::Button).aria_label("Repositories")
                                .aria_expanded(self.show_repositories).focusable().tab_stop(true)
                                .px_2().py_2().cursor_pointer().text_size(px(12.))
                                .font_weight(FontWeight::BOLD).text_color(rgb(0x626772))
                                .flex().items_center().gap_2()
                                .child(svg().data(ICON_FOLDER).w(px(14.)).h(px(14.)))
                                .child("Repositories")
                                .on_click(cx.listener(|view, _, _, cx| {
                                    view.show_repositories = !view.show_repositories; cx.notify();
                                }))
                                .on_key_down(cx.listener(|view, event: &KeyDownEvent, _, cx| {
                                    if !event.keystroke.modifiers.modified() &&
                                        matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                        view.show_repositories = !view.show_repositories;
                                        cx.stop_propagation(); cx.notify();
                                    }
                                })))
                            .when(self.show_repositories, |d| d
                                .child(div().px_2().py_2().text_size(px(12.))
                                    .text_color(rgb(0x626772)).child("No repositories connected"))))
                    )
                    .child(div().px_2().pt_2().text_size(px(11.))
                        .text_color(rgb(0x626772)).child(self.state.status))
                    .when(self.show_profile && self.state.account_name.is_some(), |d| d.child(
                        div().id("profile-menu").role(gpui::Role::Region).aria_label("Account menu")
                            .p_2().rounded(px(6.)).border_1().border_color(rgb(0xE3E5E8))
                            .bg(rgb(0xFFFFFF))
                            .child(button("profile-sign-out", "Sign out")
                                .on_click(cx.listener(|view, _, _, cx| view.command(Command::AccountLogout, cx)))
                                .on_key_down(cx.listener(|view, event: &KeyDownEvent, _, cx| {
                                    if !event.keystroke.modifiers.modified() &&
                                        matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                        view.command(Command::AccountLogout, cx);
                                        cx.stop_propagation();
                                    }
                                })))))
                    .when_some(self.state.account_name.clone(), |d, name| {
                        let initials = name.split('-').filter_map(|part| part.chars().next())
                            .take(2).collect::<String>().to_uppercase();
                        d.child(div().id("profile-control").role(gpui::Role::Button)
                            .aria_label(SharedString::from(format!("Account {name}")))
                            .aria_expanded(self.show_profile).focusable().tab_stop(true)
                            .w_full().px_2().py_2().rounded(px(6.)).cursor_pointer()
                            .hover(|d| d.bg(rgb(0xECEEF1)))
                            .flex().items_center().gap_2()
                            .child(div().w(px(30.)).h(px(30.)).rounded_full()
                                .bg(rgb(0xDDE5EB)).flex().items_center().justify_center()
                                .text_size(px(11.)).font_weight(FontWeight::BOLD).child(initials))
                            .child(div().flex_1().min_w_0().truncate().text_size(px(13.)).child(name))
                            .child(svg().data(ICON_CHEVRON).w(px(13.)).h(px(13.)))
                            .on_click(cx.listener(|view, _, _, cx| {
                                view.show_profile = !view.show_profile;
                                cx.stop_propagation(); cx.notify();
                            }))
                            .on_key_down(cx.listener(|view, event: &KeyDownEvent, _, cx| {
                                if !event.keystroke.modifiers.modified() &&
                                    matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                    view.show_profile = !view.show_profile;
                                    cx.stop_propagation(); cx.notify();
                                }
                            })))
                    })
            )
    }
}
fn moron_row(id: &str, name: &str, selected: bool, pinned: bool, shortcut: bool,
    cx: &mut Context<Chat>) -> Stateful<Div> {
    let chosen = id.to_owned();
    let key_choice = id.to_owned();
    let pin_choice = id.to_owned();
    let pin_key_choice = id.to_owned();
    div().id(SharedString::from(format!("sidebar-{}-{id}", if shortcut { "pin" } else { "moron" })))
        .w_full().min_w_0().h(px(36.)).rounded(px(6.))
        .flex().items_center()
        .bg(if selected { rgb(0xECEEF1) } else { rgb(0xF7F7F8) })
        .child(div().id(SharedString::from(format!("open-{}-{id}", if shortcut { "pin" } else { "moron" })))
            .role(gpui::Role::Button)
            .aria_label(SharedString::from(format!("Open {name}")))
            .aria_selected(selected).focusable().tab_stop(true)
            .flex_1().min_w_0().h_full().px_2().rounded(px(6.))
            .flex().items_center().gap_2().cursor_pointer().hover(|d| d.bg(rgb(0xECEEF1)))
            .text_size(px(14.))
            .child(div().w(px(20.)).flex_shrink_0()
                .child(svg().data(ICON_AGENT).w(px(18.)).h(px(18.))))
            .child(div().flex_1().min_w_0().truncate().child(name.to_owned()))
            .on_click(cx.listener(move |view, _, _, cx| view.command(Command::SelectMoron(chosen.clone()), cx)))
            .on_key_down(cx.listener(move |view, event: &KeyDownEvent, _, cx| {
                if !event.keystroke.modifiers.modified() &&
                    matches!(event.keystroke.key.as_str(), "enter" | "space") {
                    view.command(Command::SelectMoron(key_choice.clone()), cx);
                    cx.stop_propagation();
                }
            })))
        .when(!shortcut, |d| d.child(div().id(SharedString::from(format!("pin-{id}")))
            .role(gpui::Role::Button)
            .aria_label(SharedString::from(if pinned { format!("Unpin {name}") } else { format!("Pin {name}") }))
            .focusable().tab_stop(true).w(px(28.)).h_full()
            .flex().items_center().justify_center().cursor_pointer()
            .child(svg().data(if pinned { ICON_STAR_FILLED } else { ICON_STAR })
                .w(px(15.)).h(px(15.)))
            .on_click(cx.listener(move |view, _, _, cx| {
                view.command(Command::ToggleMoronPin { id: pin_choice.clone(), pinned: !pinned }, cx);
            }))
            .on_key_down(cx.listener(move |view, event: &KeyDownEvent, _, cx| {
                if !event.keystroke.modifiers.modified() &&
                    matches!(event.keystroke.key.as_str(), "enter" | "space") {
                    view.command(Command::ToggleMoronPin { id: pin_key_choice.clone(), pinned: !pinned }, cx);
                    cx.stop_propagation();
                }
            }))))
}
fn button(id: &'static str, label: &'static str) -> Stateful<Div> {
    div()
        .id(id)
        .role(gpui::Role::Button)
        .aria_label(label)
        .focusable()
        .tab_stop(true)
        .px_3()
        .py_2()
        .rounded_sm()
        .bg(rgb(0xE8ECEF))
        .text_color(rgb(0x233342))
        .text_sm()
        .cursor_pointer()
        .hover(|s| s.bg(rgb(0xD9E2E8)))
        .child(label)
}
fn primary_button(id: &'static str, label: &'static str) -> Stateful<Div> {
    div().id(id).role(gpui::Role::Button).aria_label(label)
        .focusable().tab_stop(true).px_3().py_2().rounded_sm()
        .bg(rgb(0x24313D)).text_color(rgb(0xFFFFFF)).text_sm()
        .cursor_pointer().hover(|s| s.bg(rgb(0x35495A))).child(label)
}
impl Render for Chat {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let narrow = window.bounds().size.width < px(760.);
        let active = self.state.snapshot.active_task_id.clone();
        let error = self
            .local_error
            .or(self.state.request_error)
            .or(self.state.error);
        let status = if active.is_some() {
            "Working…"
        } else {
            self.state.status
        };
        let model = self.state.model.as_deref().unwrap_or("No model connected");
        let needs_provider = self.state.selected_model.as_ref().is_some_and(|(provider, _)|
            provider == "morons-fixture") && self.state.provider_state.as_deref() != Some("connected");
        let model_display = if self.state.selected_model.as_ref().is_some_and(|(provider, _)|
            provider == "morons-fixture") { "Demo · synthetic replies".to_owned() } else {
            model_label(self.state.selected_model.as_ref().map(|item| item.0.as_str()).unwrap_or(""), model)
        };
        let effort_label = match self.state.selected_effort.as_deref() {
            Some("low") => Some("Low"), Some("medium") => Some("Medium"),
            Some("high") => Some("High"), Some("xhigh") => Some("Xhigh"),
            Some("max") => Some("Max"), _ => None,
        };
        let model_options = self.state.models.clone();
        let visible_models = self.visible_models(cx);
        let mut providers = Vec::<String>::new();
        for option in &model_options {
            if !providers.contains(&option.provider) { providers.push(option.provider.clone()); }
        }
        let selected_model = self.state.selected_model.clone();
        let selected_effort = self.state.selected_effort.clone();
        let selected_efforts = selected_model.as_ref().and_then(|(provider, id)|
            model_options.iter().find(|option| &option.provider == provider && &option.id == id))
            .map(|option| option.efforts.clone()).unwrap_or_default();
        let model_favorites = self.state.model_favorites.clone();
        let draft_ready = !self.input.read(cx).text().trim().is_empty();
        let review = self.state.review.clone();
        let provider_url = self.state.provider_url.clone();
        let provider_state = self.state.provider_state.clone();
        let visualizations = if self.state.visualization_expires_at.is_some_and(|until| std::time::Instant::now() < until) {
            self.state.visualizations.clone()
        } else { Vec::new() };
        let messages = self
            .state
            .snapshot
            .messages
            .iter()
            .map(|message| {
                let text = message.text.clone();
                let handoff = message.handoff.clone();
                let role = match message.role {
                    Role::User => "You",
                    Role::Assistant => "Moron",
                };
                let task_status = self
                    .state
                    .snapshot
                    .tasks
                    .iter()
                    .find(|task| task.id == message.task_id)
                    .map(|task| task.status);
                div()
                    .id(SharedString::from(message.id.clone()))
                    .role(gpui::Role::ListItem)
                    .aria_label(SharedString::from(format!("{role}: {}", message.text)))
                    .flex()
                    .flex_col()
                    .gap_2()
                    .p_4()
                    .rounded_sm()
                    .bg(if message.role == Role::User {
                        rgb(0xECF1F5)
                    } else {
                        rgb(0xFFFFFF)
                    })
                    .child(
                        div()
                            .flex()
                            .justify_between()
                            .items_center()
                            .child(div().font_weight(FontWeight::BOLD).text_sm().child(role))
                            .child(
                                div()
                                    .id("copy")
                                    .role(gpui::Role::Button)
                                    .aria_label("Copy message")
                                    .text_xs()
                                    .text_color(rgb(0x557080))
                                    .cursor_pointer()
                                    .child("Copy")
                                    .on_click(move |_, _, cx| {
                                        cx.write_to_clipboard(ClipboardItem::new_string(
                                            text.clone(),
                                        ))
                                    }),
                            ),
                    )
                    .child(div().text_size(px(16.)).line_height(px(25.)).child(
                        if message.text.is_empty() {
                            "…".to_owned()
                        } else {
                            message.text.clone()
                        },
                    ))
                    .when(message.role == Role::User && matches!(task_status,
                        Some(TaskStatus::Accepted | TaskStatus::Running)), |d| {
                        d.child(div().text_xs().text_color(rgb(0x667786)).child(
                            if task_status == Some(TaskStatus::Accepted) { "Queued" } else { "Delivered · working" }))
                    })
                    .when_some(handoff, |d, handoff| {
                        d.child(div()
                            .mt_2()
                            .p_3()
                            .rounded_sm()
                            .border_1()
                            .border_color(rgb(0xCAD9E4))
                            .bg(rgb(0xF7FAFC))
                            .flex()
                            .flex_col()
                            .gap_1()
                            .child(div().text_xs().font_weight(FontWeight::BOLD)
                                .child(format!("↗ @{}", handoff.target_moron_id)))
                            .child(div().text_sm().child(handoff.answer)))
                    })
                    .when(
                        message.role == Role::User
                            && matches!(
                                task_status,
                                Some(TaskStatus::Failed | TaskStatus::Stopped)
                            ),
                        |d| {
                            d.child(div().text_xs().text_color(rgb(0x886044)).child(
                                if task_status == Some(TaskStatus::Stopped) {
                                    "Stopped"
                                } else {
                                    "Task failed"
                                },
                            ))
                        },
                    )
            })
            .collect::<Vec<_>>();
        div()
            .id("morons")
            .role(gpui::Role::Application)
            .aria_label("Morons chat")
            .size_full()
            .flex()
            .bg(rgb(0xFFFFFF))
            .text_color(rgb(0x24262B))
            .font_family(if cfg!(target_os = "windows") {
                "Segoe UI"
            } else {
                ".AppleSystemUIFont"
            })
            .on_action(cx.listener(Self::send))
            .on_action(cx.listener(|_, _: &FocusNext, window, cx| window.focus_next(cx)))
            .on_action(cx.listener(|_, _: &FocusPrevious, window, cx| window.focus_prev(cx)))
            .on_click(cx.listener(|view, _, _, cx| {
                if view.show_model || view.show_effort || view.show_profile || view.show_workspaces {
                    view.show_model = false;
                    view.show_effort = false;
                    view.show_profile = false;
                    view.show_workspaces = false;
                    cx.notify();
                }
            }))
            .on_key_down(cx.listener(|view, event: &KeyDownEvent, window, cx| {
                if (view.show_model || view.show_effort || view.show_profile || view.show_workspaces) && event.keystroke.key == "escape" {
                    view.show_model = false;
                    view.show_effort = false;
                    view.show_profile = false;
                    view.show_workspaces = false;
                    window.focus(&view.input.focus_handle(cx), cx);
                    cx.stop_propagation();
                    cx.notify();
                }
            }))
            .when(!self.state.account_login, |d| d.child(self.sidebar(narrow, cx)))
            .child(div().id("main-pane").flex_1().min_w_0().h_full()
                .flex().flex_col().bg(rgb(0xFFFFFF))
            .when(!self.state.account_login, |d| d.child(
                div()
                    .flex()
                    .justify_between()
                    .items_center()
                    .px_6()
                    .py_4()
                    .border_b_1()
                    .border_color(rgb(0xE0E6EC))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap_1()
                            .child(
                                div()
                                    .text_xl()
                                    .font_weight(FontWeight::BOLD)
                                    .child("Morons"),
                            )
                            .child(div().text_sm().text_color(rgb(0x667786)).child(status)),
                    )
                    .child(div().flex().gap_2()
                        .when(!self.state.account_login, |d| d.child(button("reconnect", "Reconnect").on_click(
                            cx.listener(|view, _, _, cx| view.command(Command::Reconnect, cx)),
                        )))),
            ))
            .when(self.state.account_login, |d| d.child(
                div().id("account-form").role(gpui::Role::Region)
                    .aria_label("Morons sign in and sign up")
                    .w_full().max_w(px(520.)).mx_auto().mt_8().p_6()
                    .rounded_sm().border_1().border_color(rgb(0xBAC8D3))
                    .bg(rgb(0xFFFFFF)).flex().flex_col().gap_3()
                    .child(div().text_sm().font_weight(FontWeight::SEMIBOLD)
                        .text_color(rgb(0x626772)).child("Morons"))
                    .child(div().text_xl().font_weight(FontWeight::BOLD)
                        .child(if self.auth_signup { "Sign up" } else { "Sign in" }))
                    .child(div().text_sm().child(
                        if self.auth_signup && self.state.local_mode {
                            "Your Personal workspace will be ready when you sign up."
                        } else if self.auth_signup {
                            "Choose a username and password to get started."
                        } else if self.state.local_mode {
                            "Welcome back. Sign in to your local workspace."
                        } else if self.state.account_server_reachable {
                            "Welcome back. Sign in to continue."
                        } else {
                            "Start the local Morons account server, then check the connection."
                        }))
                    .when(!self.state.account_server_reachable, |d| d.child(
                        button("account-check-server", "Check server").on_click(cx.listener(|view, _, _, cx| view.command(Command::Reconnect, cx)))))
                    .child(div().flex().flex_col().gap_1()
                        .child(div().text_xs().font_weight(FontWeight::SEMIBOLD).child("Username"))
                        .child(div().px_2().py_1().rounded_sm().border_1().border_color(rgb(0xBAC8D3))
                            .child(self.login_name.clone()))
                        .when(self.auth_signup, |d| d.child(div().text_xs().text_color(rgb(0x626772))
                            .child("3–40 lowercase letters, digits, or hyphens; start with a letter"))))
                    .child(div().flex().flex_col().gap_1()
                        .child(div().text_xs().font_weight(FontWeight::SEMIBOLD)
                            .child(if self.auth_signup { "Password (at least 12 characters)" } else { "Password" }))
                        .child(div().px_2().py_1().rounded_sm().border_1().border_color(rgb(0xBAC8D3))
                            .child(self.login_password.clone()))
                        )
                    .when(self.auth_signup && !self.state.local_mode, |d| d
                        .child(div().text_xs().font_weight(FontWeight::SEMIBOLD).child("Setup code"))
                        .child(div().px_2().py_1().rounded_sm().border_1().border_color(rgb(0xBAC8D3))
                            .child(self.bootstrap_token.clone())))
                    .child(primary_button(if self.auth_signup { "account-sign-up" } else { "account-sign-in" },
                            if self.auth_signup { "Sign up" } else { "Sign in" })
                        .on_click(cx.listener(|view, _, _, cx| view.account_action(view.auth_signup, cx))))
                    .when(self.state.local_mode || self.state.first_account_available, |d| d
                        .child(div().mt_3().text_sm().text_color(rgb(0x626772))
                            .child(if self.auth_signup { "Already have an account?" } else { "New to Morons?" }))
                        .child(button(if self.auth_signup { "auth-switch-sign-in" } else { "auth-switch-sign-up" },
                                if self.auth_signup { "Sign in" } else { "Sign up" })
                            .bg(rgb(0xFFFFFF)).border_1().border_color(rgb(0xBAC8D3))
                            .on_click(cx.listener(|view, _, _, cx| view.auth_mode(!view.auth_signup, cx)))))
            ))
            .when(self.state.local_mode && self.state.selected_moron.is_some() && !self.state.provider_available, |d| d.child(
                div().id("provider-local-setup").role(gpui::Role::Region)
                    .aria_label("Provider setup")
                    .px_6().py_3().border_b_1().border_color(rgb(0xE0E6EC))
                    .flex().flex_col().gap_2().text_sm()
                    .child("To connect ChatGPT, enable private encrypted provider storage on this Mac.")
                    .child(button("provider-unlock", "Enable provider storage").on_click(
                        cx.listener(|view, _, _, cx| view.command(Command::ProviderUnlock, cx))))
            ))
            .when(self.state.selected_moron.is_some() && self.state.provider_available &&
                matches!(provider_state.as_deref(), Some("awaiting_callback" | "open_browser")), |d| d.child(
                div().id("provider-panel").role(gpui::Role::Region)
                    .aria_label("ChatGPT provider connection")
                    .px_6().py_2().border_b_1().border_color(rgb(0xE0E6EC))
                    .flex().flex_col().gap_2().text_sm()
                    .child("Complete ChatGPT sign-in")
                    .when_some(provider_url, |d, url| d.child(
                        button("provider-browser", "Open ChatGPT sign-in in browser").on_click(move |_, _, cx| cx.open_url(&url))
                    ))
                    .when(self.state.provider_available && matches!(provider_state.as_deref(), Some("awaiting_callback" | "open_browser")), |d| d
                        .child(div().text_xs().child("Complete sign-in in the browser. If it cannot return to this Mac, paste its final redirect URL below."))
                        .child(self.provider_callback.clone())
                        .child(button("provider-callback-submit", "Submit callback URL").on_click(cx.listener(|view, _, _, cx| view.submit_provider_callback(cx))))
                        .child(button("provider-cancel", "Cancel sign-in").on_click(cx.listener(|view, _, _, cx| view.command(Command::ProviderCancel, cx))))
                    )
            ))
            .when(!self.state.account_login, |d| d.child(
                div()
                    .id("history")
                    .role(gpui::Role::List)
                    .aria_label("Conversation")
                    .track_scroll(&self.scroll)
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .p_6()
                    .child(
                        div()
                            .w_full()
                            .max_w(px(780.))
                            .mx_auto()
                            .flex()
                            .flex_col()
                            .gap_4()
                            .when(messages.is_empty(), |d| {
                                d.child(
                                    div()
                                        .py_8()
                                        .text_color(rgb(0x667786))
                                        .child("One Moron. A conversation that stays with you."),
                                )
                            })
                            .children(messages)
            .when_some(review, |d, review| {
                let approve_id = review.id.clone();
                let reject_id = review.id.clone();
                let check = if review.checks.iter().all(|item| item.ok) {
                    "Checks passed"
                } else { "Checks failed" };
                d.child(
                    div().id("review-panel").role(gpui::Role::Region)
                        .aria_label("Repository change for human review")
                        .mx_6().mb_3().p_3().rounded_sm().border_1()
                        .border_color(rgb(0xBAC8D3)).bg(rgb(0xFFFFFF))
                        .flex().flex_col().gap_2()
                        .child(div().font_weight(FontWeight::BOLD).child("Review proposed change"))
                        .child(div().text_xs().child(format!("{} · {} · base {}", review.branch, check, &review.base_revision[..8])))
                        .child(div().text_xs().child(format!("Decision: {}", review.decision)))
                        .child(div().id("review-diff").role(gpui::Role::Document)
                            .aria_label("Proposed diff")
                            .max_h(px(180.)).overflow_y_scroll().p_2()
                            .bg(rgb(0xF3F6F8)).font_family("Menlo")
                            .text_sm().child(review.diff))
                        .when(review.decision == "pending", |d| d.child(
                            div().flex().gap_2()
                                .child(button("review-approve", "Approve review").on_click(cx.listener(move |view, _, _, cx| {
                                    view.command(Command::ReviewDecision { id: approve_id.clone(), decision: morons_desktop::transport::ReviewDecision::Approve }, cx)
                                })))
                                .child(button("review-reject", "Reject review").on_click(cx.listener(move |view, _, _, cx| {
                                    view.command(Command::ReviewDecision { id: reject_id.clone(), decision: morons_desktop::transport::ReviewDecision::Reject }, cx)
                                })))
                        )),
                )
            })
            .when(!visualizations.is_empty(), |d| d.child(
                div().id("visualizations").role(gpui::Role::Region)
                    .aria_label("Structured visualizations")
                    .mx_6().mb_3().max_h(px(260.)).overflow_y_scroll()
                    .flex().flex_col().gap_2()
                    .children(visualizations.iter().map(morons_desktop::visualization::render_native))
            ))
                    ),
            ))
            .when_some(error, |d, error| {
                d.child(
                    div()
                        .mx_6()
                        .mb_2()
                        .text_sm()
                        .text_color(rgb(0xA04438))
                        .child(error),
                )
            })
            .when(!self.state.account_login, |d| d.child(
                div().px(px(if narrow { 12. } else { 16. }))
                    .pb(px(16.)).relative().child(
                    div()
                        .w_full()
                        .min_h(px(123.))
                        .relative()
                        .flex()
                        .flex_col()
                        .pt(px(14.)).px(px(14.)).pb(px(10.))
                        .rounded(px(20.))
                        .border_1().border_color(rgb(0xE3E5E8))
                        .bg(rgb(0xFFFFFF))
                        .shadow(vec![
                            BoxShadow::new(px(0.), px(3.), hsla(0., 0., 0., 0.07)).blur_radius(px(14.)),
                            BoxShadow::new(px(0.), px(1.), hsla(0., 0., 0., 0.03)).blur_radius(px(3.)),
                        ])
                        .child(self.input.clone())
                        .child(div().flex_1().min_h(px(10.)))
                        .child(div().flex().items_center().gap(px(8.))
                            .child(div().id("attach-unavailable")
                                .aria_label("Attachments unavailable for this connection")
                                .w(px(32.)).h(px(32.)).flex().items_center().justify_center()
                                .child(svg().data(ICON_PLUS).w(px(20.)).h(px(20.)).text_color(rgb(0x24262B))))
                            .when(self.state.fast_available, |d| d.child(
                                div().id("fast-mode").role(gpui::Role::Button)
                                    .aria_label(if self.state.fast_mode {
                                        "Turn Fast mode off"
                                    } else { "Turn Fast mode on; uses more subscription usage" })
                                    .aria_selected(self.state.fast_mode)
                                    .focusable().tab_stop(true).cursor_pointer()
                                    .w(px(28.)).h(px(28.)).rounded(px(6.))
                                    .bg(if self.state.fast_mode { rgb(0xFFF5D9) } else { rgb(0xFFFFFF) })
                                    .flex().items_center().justify_center()
                                    .child(svg().data(ICON_BOLT).w(px(17.)).h(px(17.))
                                        .text_color(if self.state.fast_mode { rgb(0xB77900) } else { rgb(0x80858D) }))
                                    .on_click(cx.listener(|view, _, _, cx| {
                                        view.command(Command::SelectFast(!view.state.fast_mode), cx);
                                        cx.stop_propagation();
                                    }))
                                    .on_key_down(cx.listener(|view, event: &KeyDownEvent, _, cx| {
                                        if !event.keystroke.modifiers.modified() &&
                                            matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                            view.command(Command::SelectFast(!view.state.fast_mode), cx);
                                            cx.stop_propagation();
                                        }
                                    }))))
                            .child(div().id("model").role(gpui::Role::Button)
                                .aria_label("Choose a model")
                                .aria_expanded(self.show_model)
                                .focusable().tab_stop(true)
                                .min_w_0().max_w(px(230.)).h(px(28.)).px(px(7.))
                                .rounded(px(6.)).flex().items_center().gap_1()
                                .hover(|d| d.bg(rgb(0xECEEF1))).cursor_pointer()
                                .text_size(px(12.))
                                .child(svg().data(model_icon(selected_model.as_ref().map(|item| item.1.as_str()).unwrap_or("")))
                                    .w(px(16.)).h(px(16.)).text_color(rgb(0x626772)))
                                .child(div().min_w_0().truncate().child(model_display.clone()))
                                .child(svg().data(ICON_CHEVRON).w(px(13.)).h(px(13.)))
                                .on_click(cx.listener(|view, _, window, cx| {
                                    view.open_model_menu(window, cx);
                                    cx.stop_propagation();
                                }))
                                .on_key_down(cx.listener(|view, event: &KeyDownEvent, window, cx| {
                                    if !event.keystroke.modifiers.modified() &&
                                        matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                        view.open_model_menu(window, cx);
                                        cx.stop_propagation();
                                    }
                                })))
                            .when(!selected_efforts.is_empty(), |d| d
                                .child(div().h(px(14.)).border_l_1().border_color(rgb(0xE3E5E8)).mx(px(2.)))
                                .child(div().id("effort").role(gpui::Role::Button)
                                    .aria_label("Choose reasoning effort")
                                    .aria_expanded(self.show_effort)
                                    .focusable().tab_stop(true).cursor_pointer()
                                    .h(px(28.)).px(px(7.)).rounded(px(6.))
                                    .hover(|d| d.bg(rgb(0xECEEF1)))
                                    .flex().items_center().gap_1().text_size(px(12.))
                                    .child(effort_label.unwrap_or("Off"))
                                    .child(svg().data(ICON_CHEVRON).w(px(13.)).h(px(13.)))
                                    .on_click(cx.listener(|view, _, _, cx| {
                                        view.show_effort = !view.show_effort;
                                        view.show_model = false;
                                        cx.stop_propagation(); cx.notify();
                                    }))
                                    .on_key_down(cx.listener(|view, event: &KeyDownEvent, _, cx| {
                                        if !event.keystroke.modifiers.modified() &&
                                            matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                            view.show_effort = !view.show_effort;
                                            view.show_model = false;
                                            cx.stop_propagation(); cx.notify();
                                        }
                                    }))))
                            .child(div().flex_1())
                            .when(self.state.pending, |d| d.child(button("retry", "Retry")
                                .on_click(cx.listener(|view, _, _, cx| view.command(Command::Retry, cx)))))
                            .when_some(if self.state.selected_moron.is_none() { active.clone() } else { None }, |d, id| d.child(button("stop", "Stop")
                                .on_click(cx.listener(move |view, _, _, cx| view.command(Command::Stop(id.clone()), cx)))))
                            .child(div().id("mic-unavailable")
                                .aria_label("Dictation unavailable")
                                .w(px(32.)).h(px(32.)).rounded(px(16.))
                                .flex().items_center().justify_center()
                                .child(svg().data(ICON_MIC).w(px(20.)).h(px(20.)).text_color(rgb(0x24262B))))
                            .when(self.state.ready && !self.state.pending, |d| d.child(
                                div().id("send").aria_label(if draft_ready { "Send message" } else { "Write a message to enable send" })
                                    .w(px(28.)).h(px(28.)).rounded(px(14.))
                                    .bg(if draft_ready { rgb(0x24262B) } else { rgb(0x9DA1A7) })
                                    .flex().items_center().justify_center()
                                    .child(svg().data(ICON_SEND).w(px(16.)).h(px(16.)).text_color(rgb(0xFFFFFF)))
                                    .when(draft_ready, |d| d.role(gpui::Role::Button)
                                        .focusable().tab_stop(true).cursor_pointer()
                                        .on_click(cx.listener(|view, _, window, cx| view.send(&SendMessage, window, cx)))
                                        .on_key_down(cx.listener(|view, event: &KeyDownEvent, window, cx| {
                                            if !event.keystroke.modifiers.modified() &&
                                                matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                                view.send(&SendMessage, window, cx);
                                                cx.stop_propagation();
                                            }
                                        })))
                            )))
                    )
                        .when(self.show_model, |d| {
                            d.child(
                                div()
                                    .id("model-menu")
                                    .role(gpui::Role::Dialog)
                                    .aria_label("Choose a model")
                                    .absolute().bottom(px(72.)).left(px(if narrow { 26. } else { 30. }))
                                    .w(px(362.)).max_w_full().h(px(348.))
                                    .rounded(px(10.))
                                    .border_1()
                                    .border_color(rgb(0xE3E5E8))
                                    .bg(rgb(0xFFFFFF))
                                    .shadow(vec![
                                        BoxShadow::new(px(0.), px(10.), hsla(0., 0., 0., 0.12)).blur_radius(px(28.)),
                                        BoxShadow::new(px(0.), px(2.), hsla(0., 0., 0., 0.03)).blur_radius(px(5.)),
                                    ])
                                    .text_size(px(12.))
                                    .on_click(cx.listener(|_, _, _, cx| cx.stop_propagation()))
                                    .on_key_down(cx.listener(|view, event: &KeyDownEvent, _, cx| {
                                        if !event.keystroke.modifiers.modified() {
                                            let choices = view.visible_models(cx).into_iter().filter(|option| option.available).count();
                                            if choices > 0 && matches!(event.keystroke.key.as_str(), "down" | "up") {
                                                if event.keystroke.key == "down" { view.model_cursor = (view.model_cursor + 1) % choices; }
                                                else { view.model_cursor = (view.model_cursor + choices - 1) % choices; }
                                                cx.stop_propagation(); cx.notify();
                                            }
                                        }
                                    }))
                                    .flex()
                                    .child(div().w(px(44.)).h_full().flex_shrink_0()
                                        .border_r_1().border_color(rgb(0xE3E5E8))
                                        .flex().flex_col().items_center().pt(px(5.)).gap(px(4.))
                                        .child(div().id("model-favorites").role(gpui::Role::Button)
                                            .aria_label("Favorites").aria_selected(self.model_section == "favorites")
                                            .focusable().tab_stop(true).cursor_pointer()
                                            .w(px(35.)).h(px(36.)).rounded(px(6.))
                                            .bg(if self.model_section == "favorites" { rgb(0xECEEF1) } else { rgb(0xFFFFFF) })
                                            .flex().items_center().justify_center()
                                            .child(svg().data(ICON_STAR).w(px(20.)).h(px(20.)).text_color(rgb(0xB77900)))
                                            .on_click(cx.listener(|view, _, window, cx| {
                                                view.model_section = "favorites".into(); view.model_cursor = 0;
                                                view.model_search.update(cx, |field, cx| { field.reset(); cx.notify(); });
                                                window.focus(&view.model_search.focus_handle(cx), cx);
                                                cx.stop_propagation(); cx.notify();
                                            }))
                                            .on_key_down(cx.listener(|view, event: &KeyDownEvent, window, cx| {
                                                if !event.keystroke.modifiers.modified() &&
                                                    matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                                    view.model_section = "favorites".into(); view.model_cursor = 0;
                                                    view.model_search.update(cx, |field, cx| { field.reset(); cx.notify(); });
                                                    window.focus(&view.model_search.focus_handle(cx), cx);
                                                    cx.stop_propagation(); cx.notify();
                                                }
                                            })))
                                        .child(div().w(px(32.)).border_t_1().border_color(rgb(0xE3E5E8)))
                                        .children(providers.iter().map(|provider| {
                                            let chosen = provider.clone();
                                            let keyboard_choice = provider.clone();
                                            div().id(SharedString::from(format!("model-provider-{provider}")))
                                                .role(gpui::Role::Button)
                                                .aria_label(SharedString::from(provider_name(provider).to_owned()))
                                                .aria_selected(self.model_section == *provider)
                                                .focusable().tab_stop(true).cursor_pointer()
                                                .w(px(35.)).h(px(36.)).rounded(px(6.))
                                                .bg(if self.model_section == *provider { rgb(0xECEEF1) } else { rgb(0xFFFFFF) })
                                                .flex().items_center().justify_center()
                                                .child(svg().data(provider_icon(provider)).w(px(20.)).h(px(20.)).text_color(rgb(0x626772)))
                                                .on_click(cx.listener(move |view, _, window, cx| {
                                                    view.model_section = chosen.clone(); view.model_cursor = 0;
                                                    view.model_search.update(cx, |field, cx| { field.reset(); cx.notify(); });
                                                    window.focus(&view.model_search.focus_handle(cx), cx);
                                                    cx.stop_propagation(); cx.notify();
                                                }))
                                                .on_key_down(cx.listener(move |view, event: &KeyDownEvent, window, cx| {
                                                    if !event.keystroke.modifiers.modified() &&
                                                        matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                                        view.model_section = keyboard_choice.clone(); view.model_cursor = 0;
                                                        view.model_search.update(cx, |field, cx| { field.reset(); cx.notify(); });
                                                        window.focus(&view.model_search.focus_handle(cx), cx);
                                                        cx.stop_propagation(); cx.notify();
                                                    }
                                                }))
                                        })))
                                    .child(div().flex_1().min_w_0().pt(px(7.)).px(px(12.)).pb(px(9.)).flex().flex_col()
                                        .when(needs_provider || provider_state.as_deref() == Some("connected"), |d| d.child(
                                            div().id("provider-setup-choice").role(gpui::Role::Button)
                                                .aria_label(if provider_state.as_deref() == Some("connected") { "Disconnect ChatGPT" } else { "Set up provider" })
                                                .h(px(42.)).px_2().mb_1().rounded(px(6.))
                                                .bg(rgb(0xF7F7F8)).flex().items_center()
                                                .child(div().flex_1().child(if provider_state.as_deref() == Some("connected") { "Disconnect ChatGPT" } else { "Set up provider" }))
                                                .child(div().text_size(px(11.)).text_color(rgb(0x626772))
                                                    .child(if self.state.provider_available { "ChatGPT" } else { "Server setup required" }))
                                                .when(self.state.provider_available, |d| d.focusable().tab_stop(true).cursor_pointer())
                                                .on_click(cx.listener(|view, _, _, cx| {
                                                    if view.state.provider_available {
                                                        view.show_model = false;
                                                        view.command(if view.state.provider_state.as_deref() == Some("connected") {
                                                            Command::ProviderLogout
                                                        } else { Command::ProviderStart }, cx);
                                                    }
                                                    cx.stop_propagation();
                                                }))
                                                .on_key_down(cx.listener(|view, event: &KeyDownEvent, _, cx| {
                                                    if view.state.provider_available && !event.keystroke.modifiers.modified() &&
                                                        matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                                        view.show_model = false;
                                                        view.command(if view.state.provider_state.as_deref() == Some("connected") {
                                                            Command::ProviderLogout
                                                        } else { Command::ProviderStart }, cx);
                                                        cx.stop_propagation();
                                                    }
                                                }))
                                        ))
                                        .child(div().h(px(32.)).border_b_1()
                                            .border_color(rgb(0xE3E5E8)).flex().items_center().gap(px(5.))
                                            .child(svg().data(ICON_SEARCH).w(px(16.)).h(px(16.)).text_color(rgb(0x626772)))
                                            .child(self.model_search.clone()))
                                        .when(self.model_section == "favorites" && self.model_search.read(cx).text().is_empty(), |d|
                                            d.child(div().pt(px(10.)).px_2().text_size(px(11.))
                                                .text_color(rgb(0x626772)).child("Favorites")))
                                        .child(div().id("model-catalog").role(gpui::Role::List)
                                            .aria_label("Models")
                                            .flex_1().min_h_0().overflow_y_scroll().pt(px(7.))
                                            .when(visible_models.is_empty(), |d| d.child(
                                                div().px_2().pt(px(20.)).text_color(rgb(0x626772))
                                                    .child(if !self.model_search.read(cx).text().is_empty() { "No models found" }
                                                        else if self.model_section == "favorites" { "No favorites yet" }
                                                        else if self.model_section == "openai" &&
                                                            self.state.provider_state.as_deref() != Some("connected") {
                                                            "Set up provider to see models"
                                                        } else { "No available models" })))
                                            .children(visible_models.iter().enumerate().map(|(index, option)| {
                                                let selected = selected_model.as_ref().is_some_and(|(provider, id)|
                                                    provider == &option.provider && id == &option.id);
                                                let favorite = model_favorites.contains(&(option.provider.clone(), option.id.clone()));
                                                let provider = option.provider.clone(); let id = option.id.clone();
                                                let star_provider = provider.clone(); let star_id = id.clone();
                                                let key_provider = provider.clone(); let key_id = id.clone();
                                                let star_key_provider = provider.clone(); let star_key_id = id.clone();
                                                let active_index = visible_models[..index].iter().filter(|item| item.available).count();
                                                div().id(SharedString::from(format!("model-option-{provider}-{id}")))
                                                    .role(gpui::Role::ListItem).aria_selected(selected)
                                                    .when(option.available, |d| d.focusable().tab_stop(true))
                                                    .h(px(46.)).px(px(8.)).rounded(px(6.))
                                                    .bg(if selected || (option.available && self.model_cursor == active_index) { rgb(0xECEEF1) } else { rgb(0xFFFFFF) })
                                                    .flex().items_center().gap(px(5.))
                                                    .on_key_down(cx.listener(move |view, event: &KeyDownEvent, window, cx| {
                                                        if !event.keystroke.modifiers.modified() &&
                                                            matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                                            view.choose_model(key_provider.clone(), key_id.clone(), cx);
                                                            window.focus(&view.input.focus_handle(cx), cx);
                                                            cx.stop_propagation();
                                                        }
                                                    }))
                                                    .child(div().id(SharedString::from(format!("model-choice-{provider}-{id}")))
                                                        .role(gpui::Role::Button)
                                                        .aria_label(SharedString::from(format!("Select {}", model_label(&option.provider, &option.label))))
                                                        .flex_1().min_w_0().flex().flex_col().justify_center()
                                                        .when(option.available, |d| d.cursor_pointer())
                                                        .when(!option.available, |d| d.opacity(0.45))
                                                        .child(div().truncate().line_height(px(16.)).child(model_label(&option.provider, &option.label)))
                                                        .child(div().flex().items_center().gap(px(5.)).mt(px(3.))
                                                            .text_size(px(11.)).text_color(rgb(0x626772))
                                                            .child(svg().data(provider_icon(&option.provider)).w(px(12.)).h(px(12.)).text_color(rgb(0x626772)))
                                                            .child(provider_name(&option.provider).to_owned()))
                                                        .on_click(cx.listener(move |view, _, window, cx| {
                                                            view.choose_model(provider.clone(), id.clone(), cx);
                                                            window.focus(&view.input.focus_handle(cx), cx);
                                                            cx.stop_propagation();
                                                        })))
                                                    .when(selected, |d| d.child(div().text_color(rgb(0x626772)).child("✓")))
                                                    .child(div().id(SharedString::from(format!("model-star-{}-{}", option.provider, option.id)))
                                                        .role(gpui::Role::Button)
                                                        .aria_label(if favorite { "Remove from favorites" } else { "Add to favorites" })
                                                        .aria_selected(favorite).focusable().tab_stop(true)
                                                        .w(px(24.)).h(px(26.)).rounded(px(4.))
                                                        .flex().items_center().justify_center().cursor_pointer()
                                                        .child(svg().data(if favorite { ICON_STAR_FILLED } else { ICON_STAR })
                                                            .w(px(14.)).h(px(14.)))
                                                        .on_click(cx.listener(move |view, _, _, cx| {
                                                            view.toggle_favorite(star_provider.clone(), star_id.clone(), !favorite, cx);
                                                            cx.stop_propagation();
                                                        }))
                                                        .on_key_down(cx.listener(move |view, event: &KeyDownEvent, _, cx| {
                                                            if !event.keystroke.modifiers.modified() &&
                                                                matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                                                view.toggle_favorite(star_key_provider.clone(), star_key_id.clone(), !favorite, cx);
                                                                cx.stop_propagation();
                                                            }
                                                        })))
                                            }))),
                                    ),
                            )
                        })
                        .when(self.show_effort && !selected_efforts.is_empty(), |d| d.child(
                            div().id("effort-menu").role(gpui::Role::Dialog)
                                .aria_label("Reasoning effort")
                                .absolute().bottom(px(72.)).left(px(if narrow { 143. } else { 147. }))
                                .w(px(144.)).p(px(5.))
                                .rounded(px(8.)).border_1().border_color(rgb(0xE3E5E8))
                                .bg(rgb(0xFFFFFF))
                                .shadow(vec![BoxShadow::new(px(0.), px(8.), hsla(0., 0., 0., 0.12)).blur_radius(px(18.))])
                                .flex().flex_col()
                                .on_click(cx.listener(|_, _, _, cx| cx.stop_propagation()))
                                .children(selected_efforts.iter().map(|effort| {
                                    let chosen = effort.clone();
                                    let keyboard_choice = effort.clone();
                                    let label = if effort == "off" { "Off".to_owned() } else {
                                        let mut chars = effort.chars();
                                        chars.next().map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
                                            .unwrap_or_default()
                                    };
                                    div().id(SharedString::from(format!("effort-{effort}")))
                                        .role(gpui::Role::Button)
                                        .aria_label(SharedString::from(format!("Reasoning effort {label}")))
                                        .aria_selected(selected_effort.as_deref() == Some(effort.as_str()))
                                        .focusable().tab_stop(true).cursor_pointer()
                                        .px(px(10.)).py(px(7.)).rounded(px(5.))
                                        .bg(if selected_effort.as_deref() == Some(effort.as_str()) {
                                            rgb(0xECEEF1) } else { rgb(0xFFFFFF) })
                                        .text_size(px(12.)).child(label)
                                        .on_click(cx.listener(move |view, _, _, cx| {
                                            view.command(Command::SelectEffort(chosen.clone()), cx);
                                            view.show_effort = false;
                                            cx.stop_propagation(); cx.notify();
                                        }))
                                        .on_key_down(cx.listener(move |view, event: &KeyDownEvent, _, cx| {
                                            if !event.keystroke.modifiers.modified() &&
                                                matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                                view.command(Command::SelectEffort(keyboard_choice.clone()), cx);
                                                view.show_effort = false;
                                                cx.stop_propagation(); cx.notify();
                                            }
                                        }))
                                }))
                        ))
            )))
    }
}
fn main() {
    let config = match Config::from_env() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("Morons: {error}");
            return;
        }
    };
    let login_initial = matches!(config, Config::NamedLogin { .. } | Config::Local);
    let preview = std::env::var_os("MORONS_UI_PREVIEW").is_some();
    gpui_platform::application().run(move |cx: &mut App| {
        input::bind_keys(cx);
        cx.bind_keys([
            KeyBinding::new("enter", SendMessage, Some("TextInput")),
            KeyBinding::new("tab", FocusNext, None),
            KeyBinding::new("shift-tab", FocusPrevious, None),
            KeyBinding::new("cmd-q", Quit, None),
        ]);
        #[cfg(target_os = "windows")]
        cx.bind_keys([KeyBinding::new("ctrl-q", Quit, None)]);
        cx.on_action(|_: &Quit, cx| cx.quit());
        let bounds = Bounds::centered(None, size(px(1200.), px(760.)), cx);
        let window = cx
            .open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    window_min_size: Some(size(px(640.), px(480.))),
                    titlebar: Some(TitlebarOptions {
                        title: Some(if preview { "Morons UI Preview".into() } else { "Morons".into() }),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                |_, cx| cx.new(|cx| Chat::new(config, cx)),
            )
            .expect("open Morons window");
        window
            .update(cx, |view, window, cx| {
                window.focus(&if login_initial { view.login_name.focus_handle(cx) } else { view.input.focus_handle(cx) }, cx);
                cx.activate(true);
            })
            .expect("focus composer");
        cx.on_window_closed(|cx, _| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
    });
}
