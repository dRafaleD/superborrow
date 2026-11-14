# JSON-RPC application profile v1

UTF-8 JSON objects over stdin/stdout with `Content-Length: <bytes>\r\n\r\n`.
Only protocol messages go to stdout. Headers: 8 KiB maximum. Bodies: 8 MiB
maximum. Invalid framing closes the stream. Malformed JSON returns `-32700`.
The profile accepts single objects, named parameters and string/safe-integer
IDs; no batches. Notifications omit ID and do not receive replies. Forward
client IDs are numbers; core reverse IDs are `core:<counter>` strings.

| Method | Direction | Parameters / result |
| --- | --- | --- |
| initialize | TS → Rust | `{protocolVersion:1}` → `{protocolVersion:1,phase:4,version,capabilities}` |
| configure | TS → Rust | Config object (omitted keys use defaults) → null |
| updateDocument | TS → Rust | `{uri,languageId,version,text}` → null |
| closeDocument | TS → Rust | `{uri}` → null |
| requestCompletion | TS → Rust | Completion request → completion result |
| cancelRequest | either | notification `{id}` |
| requestIdeModel | Rust → TS | Model request → `{text}` |
| shutdown | TS → Rust | no parameters → null and exit |

Configure is a full replacement with defaults, not a merge. Changed settings
cancel active jobs; identical settings are a no-op. Initialize must precede
document/configuration/completion calls. `hybridPreference` is auto / local / ide.

```json
{
  "localApi": "ollama",
  "endpoint": "http://127.0.0.1:11434/api/generate",
  "model": "qwen2.5-coder:7b",
  "fimFormat": "qwen",
  "debounceMs": 60,
  "requestTimeoutMs": 10000,
  "maxTokens": 128,
  "maxContextBytes": 24000,
  "projectContext": "",
  "ideAvailable": false,
  "hybridPreference": "auto"
}
```

`localApi`: llamaInfill / ollama / openAi. `fimFormat`: qwen / codestral.
Validation limits are defined in config.rs and mirrored in the extension
manifest. Credentials, queries and fragments are rejected in local endpoints;
only HTTP loopback hosts are allowed. There is no remote HTTP-provider mode.

Completion request:

```json
{
  "uri": "file:///example.py", "version": 3,
  "position": {"line": 1, "character": 11},
  "mode": "hybrid", "kind": "inline", "explicit": false
}
```

Positions are zero-based UTF-16, exclude CR/LF, and cannot split surrogate pairs.
`kind` defaults to inline. Next Edit uses `kind:"nextEdit"`, `endPosition` and an
optional `instruction`. End must follow start. Selected bytes are bounded by
`min(16384,maxContextBytes/4)`, instruction by `min(2048,maxContextBytes/8)`.
`explicit:true` skips debounce. Modes: local / ide / hybrid.

Result: `{text,version,provider:"local"|"ide",fallback:boolean,elapsedMs:number}`.
elapsedMs measures router/inference time, excluding core debounce, editor
dispatch, context construction and ghost-text rendering. It is not end-to-end
keystroke latency. An empty completed response is allowed and produces no item.

Reverse request parameters:
`{requestId,prompt,languageId,maxTokens,kind:"inline"|"nextEdit"}`.
requestId repeats the envelope ID so the typed TS handler can register custom
cancellation. The TS client translates vscode-jsonrpc's `$/cancelRequest` to
`cancelRequest`; core accepts both. IDE replies use `{text}` or JSON-RPC error.

Updates require increasing versions. A change or close invalidates pending
results immediately. A newer completion on the same document supersedes old
work; different documents can complete out of order. Late replies are ignored.

| Error | Meaning |
| --- | --- |
| -32700 / -32600 / -32601 / -32602 | Parse / envelope / method / parameters |
| -32603 | Invalid provider output / internal error |
| -32000 | Initialize first |
| -32002 | Completion timeout |
| -32003 | IDE unavailable (its short error message is retained) |
| -32004 | Local unavailable / failed stream / server error |
| -32005 | Context or concurrency limit |
| -32800 | Explicit cancellation / configuration change |
| -32801 | Obsolete version / superseded request / changed or closed document |

Reference: [JSON-RPC 2.0](https://www.jsonrpc.org/specification).
