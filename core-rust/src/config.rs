use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum LocalApi {
    #[default]
    LlamaInfill,
    Ollama,
    OpenAi,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum FimFormat {
    #[default]
    Qwen,
    Codestral,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum HybridPreference {
    #[default]
    Auto,
    Local,
    Ide,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    pub local_api: LocalApi,
    pub endpoint: String,
    pub model: String,
    pub fim_format: FimFormat,
    pub debounce_ms: u64,
    pub request_timeout_ms: u64,
    pub max_tokens: usize,
    pub max_context_bytes: usize,
    pub project_context: String,
    pub ide_available: bool,
    pub hybrid_preference: HybridPreference,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            local_api: LocalApi::LlamaInfill,
            endpoint: "http://127.0.0.1:8080/infill".into(),
            model: String::new(),
            fim_format: FimFormat::Qwen,
            debounce_ms: 60,
            request_timeout_ms: 10_000,
            max_tokens: 128,
            max_context_bytes: 24_000,
            project_context: String::new(),
            ide_available: false,
            hybrid_preference: HybridPreference::Auto,
        }
    }
}

impl Config {
    pub fn validate(&self) -> Result<(), &'static str> {
        let url = reqwest::Url::parse(&self.endpoint).map_err(|_| "Invalid local endpoint")?;
        let loopback = url.host_str().is_some_and(|host| {
            host == "localhost"
                || host
                    .trim_matches(['[', ']'])
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        });
        if !loopback
            || url.scheme() != "http"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("Local endpoint must be an HTTP loopback URL without credentials or query");
        }
        if self.debounce_ms > 1000
            || !(250..=120_000).contains(&self.request_timeout_ms)
            || !(1..=1024).contains(&self.max_tokens)
            || !(2048..=64_000).contains(&self.max_context_bytes)
            || self.project_context.len() > 8192
            || self.model.len() > 256
        {
            return Err("Configuration exceeds supported limits");
        }
        if !matches!(self.local_api, LocalApi::LlamaInfill) && self.model.trim().is_empty() {
            return Err("A model name is required for Ollama/OpenAI-compatible APIs");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_loopback_endpoints_and_bounded_settings() {
        for endpoint in [
            "http://localhost:8080/infill",
            "http://[::1]:8080/infill",
            "http://127.0.0.2:8080/infill",
        ] {
            assert!(
                Config {
                    endpoint: endpoint.into(),
                    ..Config::default()
                }
                .validate()
                .is_ok()
            );
        }
        for endpoint in [
            "https://example.com",
            "http://127.0.0.1.evil.test",
            "http://user:secret@localhost",
            "http://localhost/?token=x",
        ] {
            assert!(
                Config {
                    endpoint: endpoint.into(),
                    ..Config::default()
                }
                .validate()
                .is_err()
            );
        }
    }
}
