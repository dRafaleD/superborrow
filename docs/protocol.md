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
| patchDocument | TS → Rust | `{uri,baseVersion,version,start,end,text}` → null |
| closeDocument | TS → Rust | `{uri}` → null |
| requestCompletion | TS → Rust | Completion request → completion result |
| prepareIdeCompletion | TS → Rust | Completion request → `{version,prompt,languageId,maxTokens,kind}`; no inference |
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

Optional `diagnostics` defaults to `[]`. Each entry is
`{position:{line,character},severity:"error"|"warning",message}`. The core rejects
more than eight entries or messages exceeding 512 UTF-8 bytes. Invalid source
positions and starts farther than 32 lines from the requested cursor are ignored
as advisory data that may lag an edit. These optional fields preserve profile v1
compatibility. The prompt byte budget includes instructions and chat framing.

With initialize capability `relatedDocuments:true`, completion requests may also
include `relatedDocuments:[{uri,languageId,version,text}]`. At most four references
are accepted, each at most 65536 UTF-8 bytes, URI at most 4096 bytes and language
identifier at most 64 bytes. They are parsed only for request-scoped symbol
references and never enter persistent document/history storage. A synchronized
document with the same URI takes precedence, including unsaved buffers.
The extension reads only direct relative TS/JS imports inside the canonical
trusted workspace root; no package resolution or recursive scan is performed.
Older cores do not receive this optional field from the extension.


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

When the core advertises `documentPatches`, the client can replace a single
UTF-16 range using `patchDocument`. The range refers to the acknowledged
`baseVersion`. The replacement is limited to 8 KiB and the document size limit
still applies. A missing or mismatched base leaves the document unchanged. The
client sends a full snapshot when coalesced edits skip the patch's base or a
patch is rejected.

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

`capabilities.preparedIdeCompletion:true` advertises the optional prepared path.
The extension synchronizes a snapshot and prepares its prompt inside one
DocumentSync queue operation, so newer updates cannot overtake preparation.
Preparing creates no generation job and does not freeze document updates.
The IDE client owns generation deadlines/cancellation and reconciles typed text
against the immutable prompt snapshot. Older cores without this capability use
`requestCompletion`. Local/Hybrid generation and explicit Next Edit keep their
existing core routing/cancellation semantics.
