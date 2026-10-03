use serde::{Deserialize, Serialize};

// Mirror the reviewed backend provider-selection contract. No credential shape
// chooses a provider; endpoint and secret slot are derived from explicit tuples.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    pub host: String,
    pub provider: String,
    pub auth: String,
    pub model_id: String,
}
impl Selection {
    pub fn zen(model: &str) -> Self {
        Self {
            host: "cloud".into(),
            provider: "opencode".into(),
            auth: "api_key".into(),
            model_id: model.into(),
        }
    }
    pub fn legacy_openai() -> Self {
        Self {
            host: "cloud".into(),
            provider: "openai".into(),
            auth: "api_key".into(),
            model_id: "gpt-5-mini".into(),
        }
    }
    pub fn valid(&self) -> bool {
        self.host == "cloud"
            && self.auth == "api_key"
            && match self.provider.as_str() {
                "opencode" => {
                    ["gpt-6.1-sol", "kimi-k3", "minimax-m3"].contains(&self.model_id.as_str())
                }
                "openai" => self.model_id == "gpt-5-mini",
                _ => false,
            }
    }
    pub fn endpoint(&self) -> &'static str {
        match (self.provider.as_str(), self.model_id.as_str()) {
            ("opencode", "gpt-6.1-sol") => "https://opencode.ai/zen/v1/responses",
            ("opencode", _) => "https://opencode.ai/zen/v1/chat/completions",
            _ => "https://api.openai.com/v1/responses",
        }
    }
    pub fn secret_slot(&self) -> &'static str {
        if self.provider == "opencode" {
            "OPENCODE_API_KEY"
        } else {
            "OPENAI_API_KEY"
        }
    }
    pub fn keychain_service(&self) -> &'static str {
        if self.provider == "opencode" {
            "morons://provider/opencode/zen/api-key"
        } else {
            super::KEYCHAIN_SERVICE
        }
    }
    pub fn key_label(&self) -> &'static str {
        if self.provider == "opencode" {
            "OpenCode Zen API key"
        } else {
            "OpenAI API key"
        }
    }
    pub fn valid_key(&self, key: &str) -> bool {
        self.valid()
            && if self.provider == "opencode" {
                (16..=4096).contains(&key.len())
                    && key
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            } else {
                super::valid_api_key(key)
            }
    }
    pub fn summary(&self) -> String {
        format!(
            "{} · {} · {}",
            if self.provider == "opencode" {
                "OpenCode Zen (paid API key)"
            } else {
                "OpenAI API key"
            },
            self.model_id,
            self.endpoint()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_tuples_control_keys_endpoints_and_slots() {
        for model in ["gpt-6.1-sol", "kimi-k3", "minimax-m3"] {
            let choice = Selection::zen(model);
            assert!(choice.valid());
            assert_eq!(choice.secret_slot(), "OPENCODE_API_KEY");
            assert!(choice.valid_key("fixture-zen-paid-key"));
            assert!(!choice.valid_key("eyJ.fixture.jwt"));
            assert!(choice.endpoint().starts_with("https://opencode.ai/zen/v1/"));
        }
        assert!(!Selection::zen("arbitrary-model").valid());
        let mut go = Selection::zen("kimi-k3");
        go.provider = "opencode-go".into();
        assert!(!go.valid_key("fixture-zen-paid-key"));
        let mut subscription = Selection::legacy_openai();
        subscription.auth = "chatgpt_subscription".into();
        assert!(!subscription.valid());
        assert_ne!(
            Selection::zen("kimi-k3").keychain_service(),
            Selection::legacy_openai().keychain_service()
        );
    }
}
