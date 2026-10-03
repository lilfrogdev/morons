#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
compile_error!("Morons desktop supports macOS Apple Silicon only");

mod input;
use gpui::{prelude::*, *};
use morons_desktop::{
    model::{Role, TaskStatus},
    transport::{Command, Config, State, Worker},
};

actions!(morons, [SendMessage, Quit]);
// In-memory selection only. Provider capabilities remain owned by the service.
struct SelectedConnection(Config);
impl Global for SelectedConnection {}
struct Chat {
    input: Entity<input::TextInput>,
    worker: Worker,
    approvals: Entity<morons_desktop::approval_view::ApprovalView>,
    _approval_decisions: Subscription,
    setup: Entity<morons_desktop::provider_setup::native::ProviderSetup>,
    state: State,
    // Keep the foreground listener alive for exactly the view lifetime.
    _updates: Task<()>,
    _connection: Subscription,
    _settings_close: Subscription,
    settings_windows: Vec<WindowId>,
    local_error: Option<&'static str>,
    pending_paid: Option<(String, String, morons_desktop::model::Status)>,
    last_ack: Option<String>,
    scroll: ScrollHandle,
}
impl Chat {
    fn new(config: Config, cx: &mut Context<Self>) -> Self {
        let input = cx.new(input::TextInput::new);
        let setup =
            cx.new(|cx| morons_desktop::provider_setup::native::ProviderSetup::new(&config, cx));
        let approvals = cx.new(|_| morons_desktop::approval_view::ApprovalView::new());
        let decisions = cx.subscribe(
            &approvals,
            |view, _, decision: &morons_desktop::model::ApprovalDecision, cx| {
                view.local_error = view
                    .worker
                    .send(Command::DecideApproval(decision.clone()))
                    .err();
                if view.local_error.is_some() {
                    view.approvals
                        .update(cx, |view, cx| view.reset_submission(cx));
                }
                cx.notify();
            },
        );
        let (worker, updates) = Worker::start(config);
        let task = Self::listen(updates, cx);
        let connection = cx.subscribe(
            &setup,
            |view, _, event: &morons_desktop::provider_setup::ConnectionReady, cx| {
                let Ok(url) = reqwest::Url::parse(&event.endpoint) else {
                    return;
                };
                let (worker, updates) = Worker::start(if event.fixture {
                    Config::Mock
                } else {
                    Config::Http {
                        url,
                        bearer: Some(event.bearer.to_string()),
                    }
                });
                cx.set_global(SelectedConnection(if event.fixture {
                    Config::Mock
                } else {
                    Config::Http {
                        url: reqwest::Url::parse(&event.endpoint).expect("validated endpoint"),
                        bearer: Some(event.bearer.to_string()),
                    }
                }));
                view.worker = worker;
                view._updates = Self::listen(updates, cx);
                view.pending_paid = None;
                view.state = State::default();
                view.last_ack = None;
                view.local_error = None;
                cx.notify();
            },
        );
        let weak_view = cx.entity().downgrade();
        let settings_close = cx.on_window_closed(move |cx, id| {
            if let Some(view) = weak_view.upgrade() {
                view.update(cx, |view, cx| {
                    if view.settings_windows.contains(&id) {
                        view.settings_windows.retain(|window| *window != id);
                        view.setup.update(cx, |setup, cx| setup.clear_ephemeral(cx));
                    }
                });
            }
        });
        Self {
            input,
            worker,
            approvals,
            _approval_decisions: decisions,
            setup,
            state: State::default(),
            _updates: task,
            _connection: connection,
            _settings_close: settings_close,
            settings_windows: vec![],
            local_error: None,
            pending_paid: None,
            last_ack: None,
            scroll: ScrollHandle::new(),
        }
    }
    fn connect_local(&mut self, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("Select the local service connection.json".into()),
        });
        cx.spawn(async move |view, cx| {
            let Ok(Ok(Some(paths))) = paths.await else {
                return;
            };
            let Some(path) = paths.into_iter().next() else {
                return;
            };
            let valid = morons_desktop::local_service::discover(&path).map(|_| ());
            let _ = view.update(cx, |view, cx| {
                if view.state.pending {
                    view.local_error = Some("Resolve the pending request before changing services");
                } else if let Err(error) = valid {
                    view.local_error = Some(error);
                } else {
                    let config = Config::Local { discovery: path };
                    cx.set_global(SelectedConnection(config.clone()));
                    let (worker, updates) = Worker::start(config);
                    view.worker = worker;
                    view._updates = Self::listen(updates, cx);
                    view.state = State::default();
                    view.pending_paid = None;
                    view.last_ack = None;
                    view.local_error = None;
                    view.approvals
                        .update(cx, |approval, cx| approval.set_records(vec![], cx));
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn listen(updates: async_channel::Receiver<State>, cx: &mut Context<Self>) -> Task<()> {
        cx.spawn(async move |view, cx| {
            while let Ok(state) = updates.recv().await {
                if view
                    .update(cx, |view, cx| {
                        if let Some((id, text)) = &state.accepted
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
                        view.approvals.update(cx, |approval, cx| {
                            approval.set_records(state.snapshot.approvals.clone(), cx);
                            if state.request_error.is_some() {
                                approval.reset_submission(cx);
                            }
                        });
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
        })
    }
    fn send(&mut self, _: &SendMessage, _: &mut Window, cx: &mut Context<Self>) {
        if !self.state.ready {
            self.local_error = Some("Backend not ready");
            cx.notify();
            return;
        }
        if self.input.read(cx).composing()
            || self.state.pending
            || self.state.snapshot.active_task_id.is_some()
        {
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
        if let Some(endpoint) = &self.state.endpoint {
            let Some(action) = &self.state.action else {
                self.local_error = Some("Provider metadata unavailable; reconnect before sending");
                cx.notify();
                return;
            };
            if !action.fixture_only() {
                if action.provider.is_none()
                    || action.paid.is_none()
                    || action.configuration_revision.is_none()
                    || action.provider_endpoint.is_none()
                    || action.execution_host.is_none()
                {
                    self.local_error = Some(
                        "Provider action metadata is incomplete; configure the service before sending",
                    );
                    cx.notify();
                    return;
                }
                self.pending_paid = Some((text, endpoint.clone(), action.clone()));
                cx.notify();
                return;
            }
        }
        self.submit(text, cx);
    }
    fn confirm_paid(&mut self, cx: &mut Context<Self>) {
        let Some((text, endpoint, action)) = self.pending_paid.take() else {
            return;
        };
        if self.input.read(cx).text() != text
            || self.state.endpoint.as_ref() != Some(&endpoint)
            || self.state.action.as_ref() != Some(&action)
            || !self.state.ready
            || self.state.pending
            || self.state.snapshot.active_task_id.is_some()
        {
            self.local_error = Some("Message or connection changed; review the send again");
            cx.notify();
            return;
        }
        self.submit(text, cx);
    }
    fn submit(&mut self, text: String, cx: &mut Context<Self>) {
        let command = if let Some(action) = self.state.action.clone() {
            Command::SubmitReviewed { text, action }
        } else {
            Command::Submit(text)
        };
        match self.worker.send(command) {
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
        .rounded_md()
        .bg(rgb(0xE8ECEF))
        .text_color(rgb(0x233342))
        .text_sm()
        .cursor_pointer()
        .hover(|s| s.bg(rgb(0xD9E2E8)))
        .child(label)
}
impl Render for Chat {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let active = self.state.snapshot.active_task_id.clone();
        let error = self
            .local_error
            .or(self.state.request_error)
            .or(self.state.error);
        let waiting = self
            .state
            .snapshot
            .approvals
            .iter()
            .any(|a| a.state == morons_desktop::model::ApprovalState::Pending);
        let status = if !self.state.ready {
            self.state.status
        } else if waiting {
            "Waiting for your confirmation"
        } else if active.is_some() {
            "Working…"
        } else if self.state.action.as_ref().is_some_and(|action| {
            action.execution_host.as_deref() == Some("local") && action.fixture_only()
        }) {
            "Local service connected · fixture provider"
        } else {
            self.state.status
        };
        let messages = self
            .state
            .snapshot
            .messages
            .iter()
            .map(|message| {
                let text = message.text.clone();
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
                    .rounded_lg()
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
            .flex_col()
            .bg(rgb(0xF6F8FA))
            .text_color(rgb(0x243440))
            .font_family(".AppleSystemUIFont")
            .on_action(cx.listener(Self::send))
            .child(
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
                    .child(button("connect-local-service", "Connect local service").on_click(cx.listener(|view, _, _, cx| view.connect_local(cx))))
                    .child(button("model-setup", "Model setup").on_click(cx.listener(|view, _, _, cx| {
                        if !view.settings_windows.is_empty() { return; }
                        let setup = view.setup.clone();
                        let bounds = Bounds::centered(None, size(px(640.), px(620.)), cx);
                        if let Ok(window) = cx.open_window(WindowOptions { titlebar: Some(TitlebarOptions { title: Some("Morons model connection".into()), ..Default::default() }), window_bounds: Some(WindowBounds::Windowed(bounds)), ..Default::default() }, |_, _| setup) { view.settings_windows.push(window.window_id()); }
                    })))
                    .child(button("reconnect", "Reconnect service").on_click(
                        cx.listener(|view, _, _, cx| view.command(Command::Reconnect, cx)),
                    )),
            )
            .child(
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
                                        .child("Connect your local service to recover saved conversations. Accepted service tasks continue when this window closes; Stop cancels only the selected task."),
                                )
                            })
                            .children(messages)
                            .child(self.approvals.clone()),
                    ),
            )
            .when_some(self.pending_paid.clone(), |d, (text, endpoint, action)| d.child(
                div().mx_6().p_4().flex().flex_col().gap_2().bg(rgb(0xFFF4DD))
                    .child("Review provider action")
                    .child(format!("Service: {endpoint} · Host: {} · Provider: {} · Model: {} · Provider endpoint: {} · Configuration: {}", action.execution_host.as_deref().unwrap_or("Unknown"), action.provider.as_deref().unwrap_or("Unknown"), action.model, action.provider_endpoint.as_deref().unwrap_or("Unknown"), action.configuration_revision.as_deref().unwrap_or("Unknown")))
                    .child("This sends the saved conversation and message to the selected provider. Account usage or API charges may apply even when the service runs locally.")
                    .child(text)
                    .child(button("confirm-paid-send", "Confirm paid send").on_click(cx.listener(|view, _, _, cx| view.confirm_paid(cx))))
                    .child(button("cancel-paid-send", "Cancel send").on_click(cx.listener(|view, _, _, cx| { view.pending_paid = None; cx.notify(); })))
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
            .child(
                div().px_6().pb_5().pt_2().child(
                    div()
                        .w_full()
                        .max_w(px(780.))
                        .mx_auto()
                        .flex()
                        .flex_col()
                        .gap_2()
                        .child(self.input.clone())
                        .child(
                            div()
                                .flex()
                                .justify_between()
                                .items_center()
                                .child(div().text_xs().text_color(rgb(0x667786)).child(
                                    "Enter to send · Shift-Enter for newline · Closing the app leaves backend work running",
                                ))
                                .child(
                                    div()
                                        .flex()
                                        .gap_2()
                                        .when(self.state.pending, |d| {
                                            d.child(button("retry", "Retry request").on_click(
                                                cx.listener(|view, _, _, cx| {
                                                    view.command(Command::Retry, cx)
                                                }),
                                            ))
                                        })
                                        .when_some(active, |d, id| {
                                            d.child(button("stop", "Stop").on_click(cx.listener(
                                                move |view, _, _, cx| {
                                                    view.command(Command::Stop(id.clone()), cx)
                                                },
                                            )))
                                        })
                                        .when(
                                            self.state.ready && !self.state.pending
                                                && self.state.snapshot.active_task_id.is_none(),
                                            |d| {
                                                d.child(button("send", "Send").on_click(
                                                    cx.listener(|view, _, window, cx| {
                                                        view.send(&SendMessage, window, cx)
                                                    }),
                                                ))
                                            },
                                        ),
                                ),
                        ),
                ),
            )
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
    let app = gpui_platform::application();
    app.on_reopen(move |cx| {
        if cx.windows().is_empty()
            && let Some(selection) = cx.try_global::<SelectedConnection>()
        {
            open_chat(selection.0.clone(), cx);
        }
        cx.activate(true);
    });
    app.run(move |cx: &mut App| {
        cx.set_global(SelectedConnection(config.clone()));
        input::bind_keys(cx);
        morons_desktop::provider_setup::native::bind_keys(cx);
        cx.bind_keys([
            KeyBinding::new("enter", SendMessage, Some("TextInput")),
            KeyBinding::new("cmd-q", Quit, None),
        ]);
        cx.on_action(|_: &Quit, cx| cx.quit());
        open_chat(config.clone(), cx);
    });
}

fn open_chat(config: Config, cx: &mut App) {
    let bounds = Bounds::centered(None, size(px(900.), px(720.)), cx);
    let window = cx
        .open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                window_min_size: Some(size(px(640.), px(480.))),
                titlebar: Some(TitlebarOptions {
                    title: Some("Morons".into()),
                    ..Default::default()
                }),
                ..Default::default()
            },
            |_, cx| cx.new(|cx| Chat::new(config, cx)),
        )
        .expect("open Morons window");
    window
        .update(cx, |view, window, cx| {
            window.focus(&view.input.focus_handle(cx), cx);
            cx.activate(true);
        })
        .expect("focus composer");
}
