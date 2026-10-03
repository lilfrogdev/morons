// Adapted from GPUI examples/input.rs at 7ea5428. Copyright 2022-2025 Zed Industries, Inc.
// Apache-2.0. Modified for Morons: masked API-key input, no clipboard export, ASCII-only editing.
use std::ops::Range;
use zeroize::Zeroizing;

use gpui::{
    App, Bounds, Context, CursorStyle, ElementId, ElementInputHandler, Entity, EntityInputHandler,
    FocusHandle, Focusable, GlobalElementId, KeyBinding, LayoutId, MouseButton, MouseDownEvent,
    MouseMoveEvent, MouseUpEvent, PaintQuad, Pixels, Point, SharedString, Style, TextRun,
    UTF16Selection, UnderlineStyle, Window, WrappedLine, actions, div, fill, hsla, point,
    prelude::*, px, relative, rgba, size, white,
};

use unicode_segmentation::*;

actions!(
    provider_secret,
    [
        Backspace,
        Delete,
        Left,
        Right,
        Up,
        Down,
        SelectUp,
        SelectDown,
        Newline,
        SelectLeft,
        SelectRight,
        SelectAll,
        Home,
        End,
        ShowCharacterPalette,
        Paste,
        Cut,
        Copy,
    ]
);

pub struct SecretInput {
    focus_handle: FocusHandle,
    content: Zeroizing<String>,
    mask: bool,
    placeholder: SharedString,
    selected_range: Range<usize>,
    selection_reversed: bool,
    marked_range: Option<Range<usize>>,
    last_layout: Option<TextLayout>,
    last_bounds: Option<Bounds<Pixels>>,
    is_selecting: bool,
    scroll: gpui::ScrollHandle,
    content_height: Pixels,
}

struct TextLayout {
    lines: Vec<WrappedLine>,
    line_height: Pixels,
}
impl TextLayout {
    fn position(&self, index: usize) -> Point<Pixels> {
        let mut offset = 0;
        let mut y = px(0.);
        for line in &self.lines {
            if index <= offset + line.len() {
                let position = line
                    .position_for_index(index - offset, self.line_height)
                    .unwrap_or_default();
                return point(position.x, position.y + y);
            }
            offset += line.len() + 1;
            y += line.size(self.line_height).height;
        }
        point(px(0.), y)
    }
    fn index(&self, position: Point<Pixels>) -> usize {
        let mut offset = 0;
        let mut y = px(0.);
        for line in &self.lines {
            let height = line.size(self.line_height).height;
            if position.y < y + height {
                let result = line.closest_index_for_position(
                    point(position.x, (position.y - y).max(px(0.))),
                    self.line_height,
                );
                return offset + result.unwrap_or_else(|index| index);
            }
            y += height;
            offset += line.len() + 1;
        }
        offset.saturating_sub(1)
    }
}
impl SecretInput {
    pub fn new(cx: &mut Context<Self>) -> Self {
        Self {
            focus_handle: cx.focus_handle(),
            content: Zeroizing::new(String::new()),
            mask: true,
            placeholder: "Provider API key · choose a model first".into(),
            selected_range: 0..0,
            selection_reversed: false,
            marked_range: None,
            last_layout: None,
            last_bounds: None,
            is_selecting: false,
            scroll: gpui::ScrollHandle::new(),
            content_height: px(24.),
        }
    }
    pub fn new_secret(cx: &mut Context<Self>, label: &'static str) -> Self {
        let mut input = Self::new(cx);
        input.placeholder = label.into();
        input
    }
    pub fn new_public(cx: &mut Context<Self>, label: &'static str) -> Self {
        let mut input = Self::new_secret(cx, label);
        input.mask = false;
        input
    }
    pub fn load_secret(&mut self, secret: &str, cx: &mut Context<Self>) {
        self.reset();
        self.content = Zeroizing::new(secret.to_owned());
        self.selected_range = self.content.len()..self.content.len();
        cx.notify();
    }
    pub fn set_label(&mut self, label: &'static str, cx: &mut Context<Self>) {
        self.placeholder = label.into();
        cx.notify();
    }
    pub fn secret(&self) -> Zeroizing<String> {
        Zeroizing::new(self.content.to_string())
    }
    pub fn masked(&self) -> SharedString {
        if self.mask {
            "*".repeat(self.content.len()).into()
        } else {
            self.content.to_string().into()
        }
    }

    fn vertical(&mut self, direction: f32, select: bool, cx: &mut Context<Self>) {
        if let Some(layout) = &self.last_layout {
            let position = layout.position(self.cursor_offset());
            let index = layout.index(point(
                position.x,
                position.y + layout.line_height * direction,
            ));
            if select {
                self.select_to(index.min(self.content.len()), cx);
            } else {
                self.move_to(index.min(self.content.len()), cx);
            }
        }
    }
    fn up(&mut self, _: &Up, _: &mut Window, cx: &mut Context<Self>) {
        self.vertical(-1., false, cx);
    }
    fn down(&mut self, _: &Down, _: &mut Window, cx: &mut Context<Self>) {
        self.vertical(1., false, cx);
    }
    fn select_up(&mut self, _: &SelectUp, _: &mut Window, cx: &mut Context<Self>) {
        self.vertical(-1., true, cx);
    }
    fn select_down(&mut self, _: &SelectDown, _: &mut Window, cx: &mut Context<Self>) {
        self.vertical(1., true, cx);
    }
    fn newline(&mut self, _: &Newline, window: &mut Window, cx: &mut Context<Self>) {
        self.replace_text_in_range(None, "\n", window, cx);
    }
    fn left(&mut self, _: &Left, _: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            self.move_to(self.previous_boundary(self.cursor_offset()), cx);
        } else {
            self.move_to(self.selected_range.start, cx)
        }
    }

    fn right(&mut self, _: &Right, _: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            self.move_to(self.next_boundary(self.selected_range.end), cx);
        } else {
            self.move_to(self.selected_range.end, cx)
        }
    }

    fn select_left(&mut self, _: &SelectLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.previous_boundary(self.cursor_offset()), cx);
    }

    fn select_right(&mut self, _: &SelectRight, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.next_boundary(self.cursor_offset()), cx);
    }

    fn select_all(&mut self, _: &SelectAll, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(0, cx);
        self.select_to(self.content.len(), cx)
    }

    fn home(&mut self, _: &Home, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(0, cx);
    }

    fn end(&mut self, _: &End, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.content.len(), cx);
    }

    fn backspace(&mut self, _: &Backspace, window: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            let prev = self.previous_boundary(self.cursor_offset());
            if self.cursor_offset() == prev {
                window.play_system_bell();
                return;
            }
            self.select_to(prev, cx)
        }
        self.replace_text_in_range(None, "", window, cx)
    }

    fn delete(&mut self, _: &Delete, window: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            let next = self.next_boundary(self.cursor_offset());
            if self.cursor_offset() == next {
                window.play_system_bell();
                return;
            }
            self.select_to(next, cx)
        }
        self.replace_text_in_range(None, "", window, cx)
    }

    fn on_mouse_down(
        &mut self,
        event: &MouseDownEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        _window.focus(&self.focus_handle, cx);
        self.is_selecting = true;

        if event.modifiers.shift {
            self.select_to(self.index_for_mouse_position(event.position), cx);
        } else {
            self.move_to(self.index_for_mouse_position(event.position), cx)
        }
    }

    fn on_mouse_up(&mut self, _: &MouseUpEvent, _window: &mut Window, _: &mut Context<Self>) {
        self.is_selecting = false;
        self.scroll.set_offset(point(px(0.), px(0.)));
        self.content_height = px(24.);
    }

    fn on_mouse_move(&mut self, event: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        if self.is_selecting {
            self.select_to(self.index_for_mouse_position(event.position), cx);
        }
    }

    fn show_character_palette(
        &mut self,
        _: &ShowCharacterPalette,
        window: &mut Window,
        _: &mut Context<Self>,
    ) {
        window.show_character_palette();
    }

    fn paste(&mut self, _: &Paste, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
            self.replace_text_in_range(
                None,
                &text.replace("\r\n", "\n").replace('\r', "\n"),
                window,
                cx,
            );
        }
    }

    // Never export secret contents to the clipboard, including via Cut.
    fn copy(&mut self, _: &Copy, _: &mut Window, _: &mut Context<Self>) {}
    fn cut(&mut self, _: &Cut, window: &mut Window, cx: &mut Context<Self>) {
        if !self.selected_range.is_empty() {
            self.replace_text_in_range(None, "", window, cx);
        }
    }

    fn move_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        self.selected_range = offset..offset;
        self.selection_reversed = false;
        self.reveal_cursor();
        cx.notify()
    }

    fn reveal_cursor(&self) {
        if let Some(layout) = &self.last_layout {
            let y = layout.position(self.cursor_offset()).y;
            let offset = self.scroll.offset();
            if y + offset.y < px(0.) {
                self.scroll.set_offset(point(px(0.), -y));
            } else if y + layout.line_height + offset.y > px(104.) {
                self.scroll
                    .set_offset(point(px(0.), px(104.) - y - layout.line_height));
            }
        }
    }
    fn cursor_offset(&self) -> usize {
        if self.selection_reversed {
            self.selected_range.start
        } else {
            self.selected_range.end
        }
    }

    fn index_for_mouse_position(&self, position: Point<Pixels>) -> usize {
        if self.content.is_empty() {
            return 0;
        }

        let (Some(bounds), Some(line)) = (self.last_bounds.as_ref(), self.last_layout.as_ref())
        else {
            return 0;
        };
        if position.y < bounds.top() {
            return 0;
        }
        if position.y > bounds.bottom() {
            return self.content.len();
        }
        line.index(position - bounds.origin).min(self.content.len())
    }

    fn select_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        if self.selection_reversed {
            self.selected_range.start = offset
        } else {
            self.selected_range.end = offset
        };
        if self.selected_range.end < self.selected_range.start {
            self.selection_reversed = !self.selection_reversed;
            self.selected_range = self.selected_range.end..self.selected_range.start;
        }
        cx.notify()
    }

    fn offset_from_utf16(&self, offset: usize) -> usize {
        let mut utf8_offset = 0;
        let mut utf16_count = 0;

        for ch in self.content.chars() {
            if utf16_count >= offset {
                break;
            }
            utf16_count += ch.len_utf16();
            utf8_offset += ch.len_utf8();
        }

        utf8_offset
    }

    fn offset_to_utf16(&self, offset: usize) -> usize {
        let mut utf16_offset = 0;
        let mut utf8_count = 0;

        for ch in self.content.chars() {
            if utf8_count >= offset {
                break;
            }
            utf8_count += ch.len_utf8();
            utf16_offset += ch.len_utf16();
        }

        utf16_offset
    }

    fn range_to_utf16(&self, range: &Range<usize>) -> Range<usize> {
        self.offset_to_utf16(range.start)..self.offset_to_utf16(range.end)
    }

    fn range_from_utf16(&self, range_utf16: &Range<usize>) -> Range<usize> {
        self.offset_from_utf16(range_utf16.start)..self.offset_from_utf16(range_utf16.end)
    }

    fn previous_boundary(&self, offset: usize) -> usize {
        self.content
            .grapheme_indices(true)
            .rev()
            .find_map(|(idx, _)| (idx < offset).then_some(idx))
            .unwrap_or(0)
    }

    fn next_boundary(&self, offset: usize) -> usize {
        self.content
            .grapheme_indices(true)
            .find_map(|(idx, _)| (idx > offset).then_some(idx))
            .unwrap_or(self.content.len())
    }

    pub fn reset(&mut self) {
        self.content = Zeroizing::new(String::new());
        self.selected_range = 0..0;
        self.selection_reversed = false;
        self.marked_range = None;
        self.last_layout = None;
        self.last_bounds = None;
        self.is_selecting = false;
        self.scroll.set_offset(point(px(0.), px(0.)));
        self.content_height = px(24.);
    }
}

impl EntityInputHandler for SecretInput {
    fn text_for_range(
        &mut self,
        range_utf16: Range<usize>,
        actual_range: &mut Option<Range<usize>>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<String> {
        let range = self.range_from_utf16(&range_utf16);
        actual_range.replace(self.range_to_utf16(&range));
        Some(if self.mask {
            "*".repeat(range.len())
        } else {
            self.content[range].to_string()
        })
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.range_to_utf16(&self.selected_range),
            reversed: self.selection_reversed,
        })
    }

    fn marked_text_range(
        &self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Range<usize>> {
        self.marked_range
            .as_ref()
            .map(|range| self.range_to_utf16(range))
    }

    fn unmark_text(&mut self, _window: &mut Window, _cx: &mut Context<Self>) {
        self.marked_range = None;
    }

    fn replace_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range_utf16
            .as_ref()
            .map(|range_utf16| self.range_from_utf16(range_utf16))
            .or(self.marked_range.clone())
            .unwrap_or(self.selected_range.clone());

        if !new_text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            || self.content.len() - (range.end - range.start) + new_text.len() > 4096
        {
            return;
        }
        let mut replacement =
            Zeroizing::new(String::with_capacity(self.content.len() + new_text.len()));
        replacement.push_str(&self.content[..range.start]);
        replacement.push_str(new_text);
        replacement.push_str(&self.content[range.end..]);
        self.content = replacement;
        self.selected_range = range.start + new_text.len()..range.start + new_text.len();
        self.marked_range.take();
        cx.notify();
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        new_selected_range_utf16: Option<Range<usize>>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range_utf16
            .as_ref()
            .map(|range_utf16| self.range_from_utf16(range_utf16))
            .or(self.marked_range.clone())
            .unwrap_or(self.selected_range.clone());

        if !new_text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            || self.content.len() - (range.end - range.start) + new_text.len() > 4096
        {
            return;
        }
        let mut replacement =
            Zeroizing::new(String::with_capacity(self.content.len() + new_text.len()));
        replacement.push_str(&self.content[..range.start]);
        replacement.push_str(new_text);
        replacement.push_str(&self.content[range.end..]);
        self.content = replacement;
        if !new_text.is_empty() {
            self.marked_range = Some(range.start..range.start + new_text.len());
        } else {
            self.marked_range = None;
        }
        self.selected_range = new_selected_range_utf16
            .as_ref()
            .map(|r| utf16_offset(new_text, r.start)..utf16_offset(new_text, r.end))
            .map(|new_range| new_range.start + range.start..new_range.end + range.start)
            .unwrap_or_else(|| range.start + new_text.len()..range.start + new_text.len());

        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        range_utf16: Range<usize>,
        bounds: Bounds<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let layout = self.last_layout.as_ref()?;
        let range = self.range_from_utf16(&range_utf16);
        let start = layout.position(range.start);
        Some(Bounds::new(
            bounds.origin + start,
            size(px(2.), layout.line_height),
        ))
    }

    fn character_index_for_point(
        &mut self,
        point: gpui::Point<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        let bounds = self.last_bounds?;
        let layout = self.last_layout.as_ref()?;
        Some(self.offset_to_utf16(layout.index(point - bounds.origin).min(self.content.len())))
    }
}

struct TextElement {
    input: Entity<SecretInput>,
}

struct PrepaintState {
    line: Option<TextLayout>,
    cursor: Option<PaintQuad>,
    selection: Vec<PaintQuad>,
}

impl IntoElement for TextElement {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for TextElement {
    type RequestLayoutState = ();
    type PrepaintState = PrepaintState;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&gpui::InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        style.size.height = self.input.read(cx).content_height.into();
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        let input = self.input.read(cx);
        let content = input.masked();
        let selected_range = input.selected_range.clone();
        let cursor = input.cursor_offset();
        let style = window.text_style();

        let (display_text, text_color) = if content.is_empty() {
            (input.placeholder.clone(), hsla(0., 0., 0., 0.2))
        } else {
            (content, style.color)
        };

        let run = TextRun {
            len: display_text.len(),
            font: style.font(),
            color: text_color,
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        let runs = if let Some(marked_range) = input.marked_range.as_ref() {
            vec![
                TextRun {
                    len: marked_range.start,
                    ..run.clone()
                },
                TextRun {
                    len: marked_range.end - marked_range.start,
                    underline: Some(UnderlineStyle {
                        color: Some(run.color),
                        thickness: px(1.0),
                        wavy: false,
                    }),
                    ..run.clone()
                },
                TextRun {
                    len: display_text.len() - marked_range.end,
                    ..run
                },
            ]
            .into_iter()
            .filter(|run| run.len > 0)
            .collect()
        } else {
            vec![run]
        };

        let font_size = style.font_size.to_pixels(window.rem_size());
        let lines = window
            .text_system()
            .shape_text(
                display_text,
                font_size,
                &runs,
                Some(bounds.size.width),
                None,
            )
            .expect("shape input")
            .into_iter()
            .collect::<Vec<_>>();
        let line_height = window.line_height();
        let height = lines
            .iter()
            .fold(px(0.), |height, line| {
                height + line.size(line_height).height
            })
            .max(line_height);
        let layout = TextLayout { lines, line_height };
        let position = layout.position(cursor);
        let cursor = selected_range.is_empty().then(|| {
            fill(
                Bounds::new(bounds.origin + position, size(px(2.), line_height)),
                gpui::blue(),
            )
        });
        let mut selection = vec![];
        for (index, grapheme) in input.content.grapheme_indices(true) {
            if index >= selected_range.start && index < selected_range.end {
                let start = layout.position(index);
                let end = layout.position(index + grapheme.len());
                let width = if end.y == start.y {
                    (end.x - start.x).max(px(2.))
                } else {
                    (bounds.size.width - start.x).max(px(2.))
                };
                selection.push(fill(
                    Bounds::new(bounds.origin + start, size(width, line_height)),
                    rgba(0x3311ff30),
                ));
            }
        }
        self.input.update(cx, |input, cx| {
            if input.content_height != height {
                input.content_height = height;
                cx.notify();
            }
        });
        PrepaintState {
            line: Some(layout),
            cursor,
            selection,
        }
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let focus_handle = self.input.read(cx).focus_handle.clone();
        window.handle_input(
            &focus_handle,
            ElementInputHandler::new(bounds, self.input.clone()),
            cx,
        );
        for selection in prepaint.selection.drain(..) {
            window.paint_quad(selection);
        }
        let line = prepaint.line.take().unwrap();
        let mut origin = bounds.origin;
        for wrapped in &line.lines {
            wrapped
                .paint(
                    origin,
                    line.line_height,
                    gpui::TextAlign::Left,
                    None,
                    window,
                    cx,
                )
                .expect("paint input");
            origin.y += wrapped.size(line.line_height).height;
        }

        if focus_handle.is_focused(window)
            && let Some(cursor) = prepaint.cursor.take()
        {
            window.paint_quad(cursor);
        }

        self.input.update(cx, |input, _cx| {
            input.last_layout = Some(line);
            input.reveal_cursor();
            input.last_bounds = Some(bounds);
        });
    }
}

impl Render for SecretInput {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .id("provider-secret")
            .role(gpui::Role::TextInput)
            .aria_label(self.placeholder.clone())
            .aria_value(self.masked())
            .aria_placeholder(self.placeholder.clone())
            .key_context("ProviderSecret")
            .track_focus(&self.focus_handle(cx))
            .cursor(CursorStyle::IBeam)
            .on_action(cx.listener(Self::backspace))
            .on_action(cx.listener(Self::delete))
            .on_action(cx.listener(Self::left))
            .on_action(cx.listener(Self::right))
            .on_action(cx.listener(Self::up))
            .on_action(cx.listener(Self::down))
            .on_action(cx.listener(Self::select_up))
            .on_action(cx.listener(Self::select_down))
            .on_action(cx.listener(Self::newline))
            .on_action(cx.listener(Self::select_left))
            .on_action(cx.listener(Self::select_right))
            .on_action(cx.listener(Self::select_all))
            .on_action(cx.listener(Self::home))
            .on_action(cx.listener(Self::end))
            .on_action(cx.listener(Self::show_character_palette))
            .on_action(cx.listener(Self::paste))
            .on_action(cx.listener(Self::cut))
            .on_action(cx.listener(Self::copy))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .w_full()
            .line_height(px(24.))
            .text_size(px(16.))
            .child(
                div()
                    .id("provider-secret-scroll")
                    .track_scroll(&self.scroll)
                    .h(px(38.))
                    .overflow_y_scroll()
                    .w_full()
                    .p(px(4.))
                    .bg(white())
                    .child(TextElement { input: cx.entity() }),
            )
    }
}

impl Focusable for SecretInput {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("backspace", Backspace, Some("ProviderSecret")),
        KeyBinding::new("delete", Delete, Some("ProviderSecret")),
        KeyBinding::new("left", Left, Some("ProviderSecret")),
        KeyBinding::new("right", Right, Some("ProviderSecret")),
        KeyBinding::new("up", Up, Some("ProviderSecret")),
        KeyBinding::new("down", Down, Some("ProviderSecret")),
        KeyBinding::new("shift-up", SelectUp, Some("ProviderSecret")),
        KeyBinding::new("shift-down", SelectDown, Some("ProviderSecret")),
        KeyBinding::new("shift-enter", Newline, Some("ProviderSecret")),
        KeyBinding::new("shift-left", SelectLeft, Some("ProviderSecret")),
        KeyBinding::new("shift-right", SelectRight, Some("ProviderSecret")),
        KeyBinding::new("cmd-a", SelectAll, Some("ProviderSecret")),
        KeyBinding::new("cmd-v", Paste, Some("ProviderSecret")),
        KeyBinding::new("cmd-c", Copy, Some("ProviderSecret")),
        KeyBinding::new("cmd-x", Cut, Some("ProviderSecret")),
        KeyBinding::new("home", Home, Some("ProviderSecret")),
        KeyBinding::new("end", End, Some("ProviderSecret")),
        KeyBinding::new(
            "ctrl-cmd-space",
            ShowCharacterPalette,
            Some("ProviderSecret"),
        ),
    ]);
}

fn utf16_offset(text: &str, offset: usize) -> usize {
    let mut units = 0;
    let mut bytes = 0;
    for ch in text.chars() {
        if units >= offset {
            break;
        }
        units += ch.len_utf16();
        bytes += ch.len_utf8();
    }
    bytes
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ime_replacement_selection_uses_new_text_utf16() {
        assert_eq!(utf16_offset("🐸é", 2), 4);
        assert_eq!(utf16_offset("🐸é", 3), 6);
        assert_eq!(utf16_offset("hello", 999), 5);
    }
}
