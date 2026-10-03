#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
compile_error!("Morons desktop supports macOS Apple Silicon only");

mod input;
use gpui::{prelude::*, *};
use morons_desktop::{
    model::{Role, TaskStatus},
    transport::{Command, Config, State, Worker},
};

actions!(morons, [SendMessage, Quit]);
struct Chat {
    input: Entity<input::TextInput>,
    worker: Worker,
    state: State,
    // Keep the foreground listener alive for exactly the view lifetime.
    _updates: Task<()>,
    local_error: Option<&'static str>,
    last_ack: Option<String>,
    scroll: ScrollHandle,
}
impl Chat {
    fn new(config: Config, cx: &mut Context<Self>) -> Self {
        let input = cx.new(input::TextInput::new);
        let (worker, updates) = Worker::start(config);
        let task = cx.spawn(async move |view, cx| {
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
            worker,
            state: State::default(),
            _updates: task,
            local_error: None,
            last_ack: None,
            scroll: ScrollHandle::new(),
        }
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
        let status = if active.is_some() {
            "Working…"
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
                    .child(button("reconnect", "Reconnect").on_click(
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
                                        .child("One Moron. A conversation that stays with you."),
                                )
                            })
                            .children(messages),
                    ),
            )
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
    gpui_platform::application().run(move |cx: &mut App| {
        input::bind_keys(cx);
        cx.bind_keys([
            KeyBinding::new("enter", SendMessage, Some("TextInput")),
            KeyBinding::new("cmd-q", Quit, None),
        ]);
        cx.on_action(|_: &Quit, cx| cx.quit());
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
        cx.on_window_closed(|cx, _| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
    });
}
