mod protocol;
mod transport;

use protocol::{Completion, Document, Mode, offset};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
use tokio::io::{AsyncWrite, BufReader};
use transport::{read_frame, write_frame};

struct Pending {
    original: Value,
    uri: String,
    version: u32,
    deadline: Instant,
}

async fn error<W: AsyncWrite + Unpin>(
    out: &mut W,
    id: Value,
    code: i32,
    message: &str,
) -> std::io::Result<()> {
    write_frame(
        out,
        &json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}}),
    )
    .await
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    // Only framed protocol messages go to stdout. Diagnostics go to stderr.
    let mut input = BufReader::new(tokio::io::stdin());
    let mut output = tokio::io::stdout();
    let mut documents: HashMap<String, Document> = HashMap::new();
    let mut pending: HashMap<String, Pending> = HashMap::new();
    let mut serial: u64 = 0;
    let mut initialized = false;
    let mut tick = tokio::time::interval(Duration::from_millis(100));
    // Keep the partially-read frame alive while processing timeout ticks.
    let mut frame = Box::pin(read_frame(&mut input));
    loop {
        let body = tokio::select! {
            result = &mut frame => {
                let body = result?;
                drop(frame);
                frame = Box::pin(read_frame(&mut input));
                match body { Some(body) => body, None => break }
            }
            _ = tick.tick() => {
                let expired: Vec<_> = pending.iter().filter(|(_, p)| p.deadline <= Instant::now()).map(|(id, _)| id.clone()).collect();
                for id in expired {
                    let p = pending.remove(&id).unwrap();
                    write_frame(&mut output, &json!({"jsonrpc":"2.0","method":"cancelRequest","params":{"id":id}})).await?;
                    error(&mut output, p.original, -32002, "IDE bridge timed out").await?;
                }
                continue;
            }
        };
        let message: Value = match serde_json::from_slice(&body) {
            Ok(value) => value,
            Err(_) => {
                error(&mut output, Value::Null, -32700, "Parse error").await?;
                continue;
            }
        };
        let id = message.get("id").cloned();
        if !message.is_object() || message["jsonrpc"] != "2.0" {
            error(&mut output, Value::Null, -32600, "Invalid Request").await?;
            continue;
        }
        let Some(method) = message.get("method") else {
            // Resolve reverse requests independently of incoming forward requests.
            if let Some(key) = id.as_ref().and_then(Value::as_str)
                && let Some(p) = pending.remove(key)
            {
                if message.get("error").is_some() {
                    error(&mut output, p.original, -32003, "IDE model unavailable").await?;
                } else if documents.get(&p.uri).map(|d| d.version) != Some(p.version) {
                    error(&mut output, p.original, -32801, "Document changed").await?;
                } else if let Some(text) = message["result"]["text"].as_str() {
                    write_frame(&mut output, &json!({"jsonrpc":"2.0","id":p.original,"result":{"text":text,"version":p.version}})).await?;
                } else {
                    error(&mut output, p.original, -32603, "Invalid IDE result").await?;
                }
            }
            continue;
        };
        if id.as_ref().is_some_and(|id| {
            !(id.is_string()
                || id
                    .as_i64()
                    .is_some_and(|n| n.unsigned_abs() <= 9_007_199_254_740_991))
        }) {
            error(&mut output, Value::Null, -32600, "Invalid request ID").await?;
            continue;
        }
        let Some(method) = method.as_str() else {
            error(
                &mut output,
                id.unwrap_or(Value::Null),
                -32600,
                "Invalid method",
            )
            .await?;
            continue;
        };
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let mut result = Ok(Value::Null);
        match method {
            "initialize" => {
                if params["protocolVersion"] != 1 {
                    result = Err((-32602, "Expected protocolVersion 1"));
                } else {
                    initialized = true;
                    result = Ok(json!({"protocolVersion":1,"phase":1}));
                }
            }
            "shutdown" => {
                if let Some(id) = id {
                    write_frame(&mut output, &json!({"jsonrpc":"2.0","id":id,"result":null}))
                        .await?;
                }
                break;
            }
            _ if !initialized => result = Err((-32000, "Initialize first")),
            "updateDocument" => match serde_json::from_value::<Document>(params) {
                Ok(doc) => {
                    if documents
                        .get(&doc.uri)
                        .is_some_and(|old| old.version >= doc.version)
                    {
                        result = Err((-32801, "Document version must increase"));
                    } else {
                        documents.insert(doc.uri.clone(), doc);
                    }
                }
                Err(_) => result = Err((-32602, "Invalid document")),
            },
            "closeDocument" => {
                if let Some(uri) = params["uri"].as_str() {
                    documents.remove(uri);
                } else {
                    result = Err((-32602, "Expected uri"));
                }
            }
            "cancelRequest" => {
                let target = &params["id"];
                let keys: Vec<_> = pending
                    .iter()
                    .filter(|(_, p)| &p.original == target)
                    .map(|(key, _)| key.clone())
                    .collect();
                for key in keys {
                    let p = pending.remove(&key).unwrap();
                    write_frame(
                        &mut output,
                        &json!({"jsonrpc":"2.0","method":"cancelRequest","params":{"id":key}}),
                    )
                    .await?;
                    error(&mut output, p.original, -32800, "Request cancelled").await?;
                }
            }
            "requestCompletion" => {
                // A notification must never allocate reverse-request state.
                let Some(original) = id.clone() else {
                    continue;
                };
                match serde_json::from_value::<Completion>(params) {
                    Err(_) => result = Err((-32602, "Invalid completion parameters")),
                    Ok(request) => {
                        if let Some(doc) = documents.get(&request.uri) {
                            if doc.version != request.version {
                                result = Err((-32801, "Document changed"));
                            } else if let Some(cursor) = offset(&doc.text, &request.position) {
                                if matches!(request.mode, Mode::Local) {
                                    result = Err((-32004, "Local provider is planned for phase 3"));
                                } else if pending.len() >= 128 {
                                    result = Err((-32005, "Too many pending requests"));
                                } else {
                                    serial += 1;
                                    let reverse_id = format!("core:{serial}");
                                    // Diagnostic split only; optimized FIM prompts belong to phase 2.
                                    let prompt = format!(
                                        "{}\n[CURSOR]\n{}",
                                        &doc.text[..cursor],
                                        &doc.text[cursor..]
                                    );
                                    write_frame(&mut output, &json!({"jsonrpc":"2.0","id":reverse_id,"method":"requestIdeModel","params":{"requestId":reverse_id,"prompt":prompt,"languageId":doc.language_id,"maxTokens":128}})).await?;
                                    pending.insert(
                                        reverse_id,
                                        Pending {
                                            original,
                                            uri: request.uri,
                                            version: request.version,
                                            deadline: Instant::now() + Duration::from_secs(10),
                                        },
                                    );
                                    continue;
                                }
                            } else {
                                result = Err((-32602, "Invalid UTF-16 position"));
                            }
                        } else {
                            result = Err((-32602, "Unknown document"));
                        }
                    }
                }
            }
            _ => result = Err((-32601, "Method not found")),
        }
        if let Some(id) = id {
            match result {
                Ok(value) => {
                    write_frame(
                        &mut output,
                        &json!({"jsonrpc":"2.0","id":id,"result":value}),
                    )
                    .await?
                }
                Err((code, message)) => error(&mut output, id, code, message).await?,
            }
        }
    }
    Ok(())
}
