use std::collections::HashMap;

#[derive(Default)]
pub struct Drafts {
    active: Option<String>,
    by_moron: HashMap<String, String>,
}

impl Drafts {
    pub fn switch(&mut self, next: Option<&str>, current_text: &str) -> String {
        if self.active.as_deref() == next {
            return current_text.to_owned();
        }
        if let Some(previous) = self.active.take() {
            self.by_moron.insert(previous, current_text.to_owned());
        }
        self.active = next.map(str::to_owned);
        next.and_then(|id| self.by_moron.get(id)).cloned().unwrap_or_default()
    }

    pub fn clear(&mut self) {
        self.active = None;
        self.by_moron.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::Drafts;

    #[test]
    fn drafts_follow_named_moron_without_cross_talk_and_clear_on_logout() {
        let mut drafts = Drafts::default();
        assert_eq!(drafts.switch(Some("repo"), ""), "");
        assert_eq!(drafts.switch(Some("fitness"), "repository draft"), "");
        assert_eq!(drafts.switch(Some("repo"), "fitness draft"), "repository draft");
        assert_eq!(drafts.switch(Some("fitness"), "repository draft"), "fitness draft");
        drafts.clear();
        assert_eq!(drafts.switch(Some("repo"), ""), "");
    }
}
