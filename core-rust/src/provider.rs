use crate::{
    config::{Config, FimFormat, HybridPreference, LocalApi},
    context::{Prompt, head},
    protocol::Mode,
};
use async_trait::async_trait;
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone)]
pub struct Failure {
    pub code: i32,
    pub message: String,
}
impl Failure {
    pub fn new(code: i32, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    pub fn cancelled() -> Self {
        Self::new(-32800, "Request cancelled")
    }
}
pub type Answer = Result<String, Failure>;

pub enum Event {
    Reverse {
        job: u64,
        params: Value,
        reply: oneshot::Sender<Answer>,
    },
    Finished {
        job: u64,
        result: Result<Generated, Failure>,
    },
}

pub struct Generated {
    pub text: String,
    pub provider: &'static str,
    pub fallback: bool,
    pub elapsed_ms: u64,
}

#[async_trait]
pub trait CompletionProvider: Send + Sync {
    async fn complete(
        &self,
        prompt: &Prompt,
        config: &Config,
        cancel: &CancellationToken,
    ) -> Answer;
}

pub struct LocalProvider {
    pub client: reqwest::Client,
}
impl LocalProvider {
    pub fn new() -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(2))
                .build()?,
        })
    }
}

fn content<'a>(value: &'a Value, api: &LocalApi) -> Result<(&'a str, bool), Failure> {
    if value.get("error").is_some() {
        return Err(Failure::new(
            -32004,
            "Local server reported a generation error",
        ));
    }
    Ok(match api {
        LocalApi::LlamaInfill => (
            value["content"].as_str().unwrap_or(""),
            value["stop"].as_bool().unwrap_or(false),
        ),
        LocalApi::Ollama => (
            value["response"].as_str().unwrap_or(""),
            value["done"].as_bool().unwrap_or(false),
        ),
        LocalApi::OpenAi => (
            value["choices"][0]["text"].as_str().unwrap_or(""),
            value["choices"][0]["finish_reason"].is_string(),
        ),
    })
}

fn line(bytes: &[u8], api: &LocalApi, output: &mut String) -> Result<bool, Failure> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| Failure::new(-32603, "Invalid UTF-8 model stream"))?
        .trim();
    if text.is_empty()
        || text.starts_with(':')
        || text.starts_with("event:")
        || text.starts_with("id:")
    {
        return Ok(false);
    }
    let data = text.strip_prefix("data:").map_or(text, str::trim);
    if data == "[DONE]" {
        return Ok(true);
    }
    let value: Value = serde_json::from_str(data)
        .map_err(|_| Failure::new(-32603, "Invalid model stream JSON"))?;
    let (token, done) = content(&value, api)?;
    let remaining = 16_384usize.saturating_sub(output.len());
    output.push_str(head(token, remaining));
    Ok(done || output.len() >= 16_384)
}

#[async_trait]
impl CompletionProvider for LocalProvider {
    async fn complete(
        &self,
        prompt: &Prompt,
        config: &Config,
        cancel: &CancellationToken,
    ) -> Answer {
        let stop = match prompt.format {
            FimFormat::Qwen => vec![
                "<|fim_prefix|>",
                "<|fim_suffix|>",
                "<|fim_middle|>",
                "<|endoftext|>",
                "<|im_end|>",
            ],
            FimFormat::Codestral => vec!["[PREFIX]", "[SUFFIX]", "[MIDDLE]", "</s>"],
        };
        let body = match config.local_api {
            LocalApi::LlamaInfill => {
                json!({"input_prefix":prompt.prefix,"input_suffix":prompt.suffix,"input_extra":[{"filename":"context.txt","text":prompt.stable}],"n_predict":config.max_tokens,"temperature":0.1,"stream":true,"cache_prompt":true,"stop":stop})
            }
            LocalApi::Ollama => {
                json!({"model":config.model,"prompt":prompt.fim,"raw":true,"stream":true,"keep_alive":"5m","options":{"num_predict":config.max_tokens,"temperature":0.1,"stop":stop}})
            }
            LocalApi::OpenAi => {
                json!({"model":config.model,"prompt":prompt.fim,"max_tokens":config.max_tokens,"temperature":0.1,"stream":true,"stop":stop})
            }
        };
        let generate = async {
            let response = self
                .client
                .post(&config.endpoint)
                .json(&body)
                .send()
                .await
                .map_err(|_| Failure::new(-32004, "Local model server is unreachable"))?;
            if !response.status().is_success() {
                return Err(Failure::new(
                    -32004,
                    format!("Local model server HTTP {}", response.status().as_u16()),
                ));
            }
            let json_body = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.starts_with("application/json"));
            let mut stream = response.bytes_stream();
            let mut buffer = Vec::new();
            let mut output = String::new();
            let mut received = 0;
            let mut done = false;
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| Failure::new(-32004, "Local stream disconnected"))?;
                received += chunk.len();
                if received > 1_048_576 {
                    return Err(Failure::new(-32603, "Model stream exceeds limit"));
                }
                buffer.extend_from_slice(&chunk);
                if json_body {
                    continue;
                }
                while let Some(newline) = buffer.iter().position(|b| *b == b'\n') {
                    let current: Vec<_> = buffer.drain(..=newline).collect();
                    if line(&current, &config.local_api, &mut output)? {
                        done = true;
                        break;
                    }
                }
                if done {
                    break;
                }
                if buffer.len() > 65_536 {
                    return Err(Failure::new(-32603, "Model stream frame exceeds limit"));
                }
            }
            if !done && !buffer.is_empty() {
                done = line(&buffer, &config.local_api, &mut output)?;
            }
            if !done && !json_body {
                return Err(Failure::new(-32004, "Model stream ended before completion"));
            }
            if json_body && output.is_empty() {
                return Err(Failure::new(-32603, "Model returned no completion"));
            }
            Ok(clean(&output))
        };
        tokio::select! { biased; _ = cancel.cancelled() => Err(Failure::cancelled()), result = generate => result }
    }
}

pub struct IdeBridgeProvider {
    pub events: mpsc::Sender<Event>,
    pub job: u64,
}
#[async_trait]
impl CompletionProvider for IdeBridgeProvider {
    async fn complete(
        &self,
        prompt: &Prompt,
        config: &Config,
        cancel: &CancellationToken,
    ) -> Answer {
        let (reply, response) = oneshot::channel();
        let params = json!({"prompt":prompt.chat,"qwenInfill":prompt.qwen_infill(),"qwenStopAt":prompt.qwen_stop_at(),"languageId":prompt.language_id,"maxTokens":config.max_tokens,"kind":if prompt.next_edit {"nextEdit"} else {"inline"}});
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(Failure::cancelled()),
            result = self.events.send(Event::Reverse { job: self.job, params, reply }) => {
                result.map_err(|_| Failure::new(-32603, "Core shutting down"))?;
            }
        }
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(Failure::cancelled()),
            result = response => result.map_err(|_| Failure::new(-32003, "IDE bridge closed"))?.map(|text| clean(&text)),
        }
    }
}

pub struct HybridRouter {
    pub local: Arc<LocalProvider>,
    pub ide: IdeBridgeProvider,
}
impl HybridRouter {
    pub async fn generate(
        &self,
        mode: Mode,
        prompt: &Prompt,
        config: &Config,
        cancel: &CancellationToken,
    ) -> Result<Generated, Failure> {
        let start = Instant::now();
        let primary_ide = matches!(mode, Mode::Ide)
            || (matches!(mode, Mode::Hybrid)
                && config.ide_available
                && (matches!(config.hybrid_preference, HybridPreference::Ide)
                    || (matches!(config.hybrid_preference, HybridPreference::Auto)
                        && prompt.complex)));
        let mut fallback = false;
        let first = if primary_ide {
            self.ide.complete(prompt, config, cancel).await
        } else if matches!(mode, Mode::Hybrid) && config.ide_available {
            tokio::time::timeout(
                Duration::from_millis((config.request_timeout_ms / 2).min(1500)),
                self.local.complete(prompt, config, cancel),
            )
            .await
            .unwrap_or_else(|_| Err(Failure::new(-32002, "Local latency budget exceeded")))
        } else {
            self.local.complete(prompt, config, cancel).await
        };
        let (result, provider) = match first {
            Err(error)
                if matches!(mode, Mode::Hybrid)
                    && error.code != -32800
                    && !cancel.is_cancelled()
                    && (primary_ide || config.ide_available) =>
            {
                fallback = true;
                if primary_ide {
                    (self.local.complete(prompt, config, cancel).await, "local")
                } else {
                    (self.ide.complete(prompt, config, cancel).await, "ide")
                }
            }
            result => (result, if primary_ide { "ide" } else { "local" }),
        };
        Ok(Generated {
            text: result?,
            provider,
            fallback,
            elapsed_ms: start.elapsed().as_millis() as u64,
        })
    }
}

pub fn clean(text: &str) -> String {
    if text.trim() == "<NO_COMPLETION>" {
        return String::new();
    }
    let mut text = text;
    if text.trim_start().starts_with("```") {
        let trimmed = text.trim();
        if let Some((_, rest)) = trimmed.split_once('\n') {
            let mut end = 0;
            for line in rest.split_inclusive('\n') {
                if line.trim() == "```" {
                    break;
                }
                end += line.len();
            }
            text = rest[..end].trim_end_matches(['\r', '\n']);
        }
    }
    let end = [
        "<|fim_prefix|>",
        "<|fim_suffix|>",
        "<|fim_middle|>",
        "<|endoftext|>",
        "<|im_end|>",
        "[PREFIX]",
        "[SUFFIX]",
        "[MIDDLE]",
        "</s>",
    ]
    .iter()
    .filter_map(|token| text.find(token))
    .min()
    .unwrap_or(text.len());
    head(&text[..end], 16_384).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stream_formats_and_cleanup_preserve_indentation() {
        for (api, data) in [
            (
                LocalApi::LlamaInfill,
                "data: {\"content\":\"  😀\",\"stop\":true}\n",
            ),
            (LocalApi::Ollama, "{\"response\":\"  😀\",\"done\":true}\n"),
            (
                LocalApi::OpenAi,
                "data: {\"choices\":[{\"text\":\"  😀\",\"finish_reason\":\"stop\"}]}\n",
            ),
        ] {
            let mut output = String::new();
            assert!(line(data.as_bytes(), &api, &mut output).unwrap());
            assert_eq!(output, "  😀");
        }
        assert_eq!(clean("```rust\n  foo();\n```"), "  foo();");
        assert_eq!(clean("  foo()<|fim_suffix|>rest"), "  foo()");
        assert_eq!(clean(" \n<NO_COMPLETION>\n"), "");
        assert_eq!(
            clean("const tag = '<NO_COMPLETION>';"),
            "const tag = '<NO_COMPLETION>';"
        );
    }
}
