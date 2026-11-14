mod config;
mod context;
mod protocol;
mod provider;
mod transport;

use config::Config;
use context::ContextEngine;
use protocol::{Completion, Document};
use provider::{Answer, Event, Failure, HybridRouter, IdeBridgeProvider, LocalProvider};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::BufReader,
    sync::{mpsc, oneshot},
};
use tokio_util::sync::CancellationToken;
use transport::{read_frame, write_frame};

struct Job {
    id: Value,
    uri: String,
    version: u32,
    cancel: CancellationToken,
}
struct Reverse {
    job: u64,
    reply: oneshot::Sender<Answer>,
}
struct Server {
    output: tokio::io::Stdout,
    context: ContextEngine,
    config: Config,
    initialized: bool,
    jobs: BTreeMap<u64, Job>,
    reverse: HashMap<String, Reverse>,
    serial: u64,
    events: mpsc::Sender<Event>,
    local: Arc<LocalProvider>,
}

impl Server {
    async fn result(&mut self, id: Value, result: Value) -> std::io::Result<()> {
        write_frame(
            &mut self.output,
            &json!({"jsonrpc":"2.0","id":id,"result":result}),
        )
        .await
    }
    async fn error(&mut self, id: Value, code: i32, message: &str) -> std::io::Result<()> {
        write_frame(
            &mut self.output,
            &json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}}),
        )
        .await
    }
    async fn clear_reverse(&mut self, job: u64) -> std::io::Result<()> {
        let keys: Vec<_> = self
            .reverse
            .iter()
            .filter(|(_, value)| value.job == job)
            .map(|(key, _)| key.clone())
            .collect();
        for key in keys {
            if let Some(reverse) = self.reverse.remove(&key) {
                let _ = reverse.reply.send(Err(Failure::cancelled()));
            }
            write_frame(
                &mut self.output,
                &json!({"jsonrpc":"2.0","method":"cancelRequest","params":{"id":key}}),
            )
            .await?;
        }
        Ok(())
    }
    async fn cancel(&mut self, key: u64, code: i32, message: &str) -> std::io::Result<()> {
        if let Some(job) = self.jobs.remove(&key) {
            job.cancel.cancel();
            self.clear_reverse(key).await?;
            self.error(job.id, code, message).await?;
        }
        Ok(())
    }
    async fn cancel_document(&mut self, uri: &str) -> std::io::Result<()> {
        let keys: Vec<_> = self
            .jobs
            .iter()
            .filter(|(_, job)| job.uri == uri)
            .map(|(key, _)| *key)
            .collect();
        for key in keys {
            self.cancel(key, -32801, "Document changed or closed")
                .await?;
        }
        Ok(())
    }
    async fn event(&mut self, event: Event) -> std::io::Result<()> {
        match event {
            Event::Reverse {
                job,
                mut params,
                reply,
            } => {
                if !self.jobs.contains_key(&job) {
                    let _ = reply.send(Err(Failure::cancelled()));
                    return Ok(());
                }
                self.serial += 1;
                let id = format!("core:{}", self.serial);
                params["requestId"] = json!(id);
                write_frame(
                    &mut self.output,
                    &json!({"jsonrpc":"2.0","id":id,"method":"requestIdeModel","params":params}),
                )
                .await?;
                self.reverse.insert(id, Reverse { job, reply });
            }
            Event::Finished { job: key, result } => {
                if let Some(job) = self.jobs.remove(&key) {
                    self.clear_reverse(key).await?;
                    if self.context.version(&job.uri) != Some(job.version) {
                        self.error(job.id, -32801, "Document changed").await?;
                    } else {
                        match result {
                            Ok(answer) => self.result(job.id, json!({"text":answer.text,"version":job.version,"provider":answer.provider,"fallback":answer.fallback,"elapsedMs":answer.elapsed_ms})).await?,
                            Err(error) => self.error(job.id, error.code, &error.message).await?,
                        }
                    }
                }
            }
        }
        Ok(())
    }
    async fn message(&mut self, body: &[u8]) -> std::io::Result<bool> {
        let message: Value = match serde_json::from_slice(body) {
            Ok(value) => value,
            Err(_) => {
                self.error(Value::Null, -32700, "Parse error").await?;
                return Ok(false);
            }
        };
        if !message.is_object() || message["jsonrpc"] != "2.0" {
            self.error(Value::Null, -32600, "Invalid Request").await?;
            return Ok(false);
        }
        let id = message.get("id").cloned();
        let Some(method) = message.get("method") else {
            if let Some(key) = id.as_ref().and_then(Value::as_str)
                && let Some(reverse) = self.reverse.remove(key)
            {
                let result = if message.get("error").is_some() {
                    Err(Failure::new(
                        -32003,
                        message["error"]["message"]
                            .as_str()
                            .map(|text| context::head(text, 256))
                            .unwrap_or("IDE model unavailable"),
                    ))
                } else if let Some(text) = message["result"]["text"].as_str() {
                    if text.len() > 65_536 {
                        Err(Failure::new(-32603, "IDE completion exceeds limit"))
                    } else {
                        Ok(text.into())
                    }
                } else {
                    Err(Failure::new(-32603, "Invalid IDE result"))
                };
                let _ = reverse.reply.send(result);
            }
            return Ok(false);
        };
        if id.as_ref().is_some_and(|id| {
            !(id.is_string()
                || id
                    .as_i64()
                    .is_some_and(|n| n.unsigned_abs() <= 9_007_199_254_740_991))
        }) || !method.is_string()
        {
            self.error(Value::Null, -32600, "Invalid method or ID")
                .await?;
            return Ok(false);
        }
        let method = method.as_str().unwrap();
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let mut result: Result<Value, (i32, &str)> = Ok(Value::Null);
        match method {
            "initialize" => {
                if params["protocolVersion"] != 1 {
                    result = Err((-32602, "Expected protocolVersion 1"));
                } else {
                    self.initialized = true;
                    result = Ok(
                        json!({"protocolVersion":1,"phase":4,"capabilities":{"fim":true,"nextEdit":true,"cancellation":true,"streamingLocal":true},"version":env!("CARGO_PKG_VERSION")}),
                    );
                }
            }
            "shutdown" => {
                if let Some(id) = id {
                    self.result(id, Value::Null).await?;
                }
                return Ok(true);
            }
            _ if !self.initialized => result = Err((-32000, "Initialize first")),
            "configure" => match serde_json::from_value::<Config>(params) {
                Ok(config) => match config.validate() {
                    Ok(()) => {
                        let keys: Vec<_> = self.jobs.keys().copied().collect();
                        for key in keys {
                            self.cancel(key, -32800, "Configuration changed").await?;
                        }
                        self.config = config;
                    }
                    Err(message) => result = Err((-32602, message)),
                },
                Err(_) => result = Err((-32602, "Invalid configuration")),
            },
            "updateDocument" => match serde_json::from_value::<Document>(params) {
                Ok(doc) => {
                    let uri = doc.uri.clone();
                    result = self.context.update(doc).map(|_| Value::Null);
                    if result.is_ok() {
                        self.cancel_document(&uri).await?;
                    }
                }
                Err(_) => result = Err((-32602, "Invalid document")),
            },
            "closeDocument" => {
                if let Some(uri) = params["uri"].as_str() {
                    self.context.close(uri);
                    self.cancel_document(uri).await?;
                } else {
                    result = Err((-32602, "Expected uri"));
                }
            }
            "cancelRequest" | "$/cancelRequest" => {
                let keys: Vec<_> = self
                    .jobs
                    .iter()
                    .filter(|(_, job)| job.id == params["id"])
                    .map(|(key, _)| *key)
                    .collect();
                for key in keys {
                    self.cancel(key, -32800, "Request cancelled").await?;
                }
            }
            "requestCompletion" => {
                let Some(original) = id.clone() else {
                    return Ok(false);
                };
                match serde_json::from_value::<Completion>(params) {
                    Err(_) => result = Err((-32602, "Invalid completion parameters")),
                    Ok(request) => match self.context.prompt(&request, &self.config) {
                        Err(error) => result = Err(error),
                        Ok(prompt) => {
                            self.cancel_document(&request.uri).await?;
                            if self.jobs.len() >= 16 {
                                result = Err((-32005, "Too many pending requests"));
                            } else if self.jobs.values().any(|job| job.id == original) {
                                result = Err((-32600, "Request ID already active"));
                            } else {
                                self.serial += 1;
                                let key = self.serial;
                                let cancel = CancellationToken::new();
                                let config = self.config.clone();
                                let events = self.events.clone();
                                let router = HybridRouter {
                                    local: self.local.clone(),
                                    ide: IdeBridgeProvider {
                                        events: events.clone(),
                                        job: key,
                                    },
                                };
                                self.jobs.insert(
                                    key,
                                    Job {
                                        id: original,
                                        uri: request.uri,
                                        version: request.version,
                                        cancel: cancel.clone(),
                                    },
                                );
                                tokio::spawn(async move {
                                    let generate = async {
                                        if !request.explicit {
                                            tokio::time::sleep(Duration::from_millis(
                                                config.debounce_ms,
                                            ))
                                            .await;
                                        }
                                        router
                                            .generate(request.mode, &prompt, &config, &cancel)
                                            .await
                                    };
                                    let result = tokio::select! {
                                        biased;
                                        _ = cancel.cancelled() => Err(Failure::cancelled()),
                                        result = tokio::time::timeout(Duration::from_millis(config.request_timeout_ms), generate) => result.unwrap_or_else(|_| Err(Failure::new(-32002, "Completion timed out"))),
                                    };
                                    let _ = events.send(Event::Finished { job: key, result }).await;
                                });
                                return Ok(false);
                            }
                        }
                    },
                }
            }
            _ => result = Err((-32601, "Method not found")),
        }
        if let Some(id) = id {
            match result {
                Ok(value) => self.result(id, value).await?,
                Err((code, message)) => self.error(id, code, message).await?,
            }
        }
        Ok(false)
    }
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let (events, mut receiver) = mpsc::channel(64);
    let mut server = Server {
        output: tokio::io::stdout(),
        context: ContextEngine::default(),
        config: Config::default(),
        initialized: false,
        jobs: BTreeMap::new(),
        reverse: HashMap::new(),
        serial: 0,
        events,
        local: Arc::new(LocalProvider::new().map_err(std::io::Error::other)?),
    };
    let mut input = BufReader::new(tokio::io::stdin());
    let mut frame = Box::pin(read_frame(&mut input));
    loop {
        tokio::select! {
            result = &mut frame => {
                let body = result?;
                drop(frame);
                frame = Box::pin(read_frame(&mut input));
                let Some(body) = body else { break; };
                if server.message(&body).await? { break; }
            }
            Some(event) = receiver.recv() => server.event(event).await?,
        }
    }
    for job in server.jobs.values() {
        job.cancel.cancel();
    }
    Ok(())
}
