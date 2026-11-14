# IDE model adapter v1

The preferred route is `vscode.lm`. If Antigravity does not expose its chat
models through that API, inspect **Antigravity Tab: Inspect Available Models**.
An internal model's presence in the UI does not prove that extensions can use it.
The implementation does not invoke unknown internal commands or scrape sessions.

An installed extension can opt into this public contract:

```typescript
import * as vscode from "vscode";

export function activate() {
  return {
    superborrowCompletionProvider: {
      version: 1 as const,
      async generateCompletion(
        params: {
          requestId: string;
          prompt: string;
          languageId: string;
          maxTokens: number;
          kind: "inline" | "nextEdit";
        },
        cancellation: vscode.CancellationToken
      ): Promise<{ text: string }> {
        // Delegate to your own supported model API and observe cancellation.
        // Return only proposed code. Do not apply editor changes here.
        throw new Error("Implement using your supported model service");
      }
    }
  };
}
```

Configure `superborrow.ideAdapterExtension` to its extension ID, then run
**Select IDE Model**. Only that explicitly configured extension is activated for
adapter discovery. The adapter is responsible for its model's consent, token
budget and streaming resource cleanup. The bridge enforces response bounds and
cancellation at the JSON-RPC boundary even if the adapter ignores cancellation.

No adapter for an undocumented Antigravity private service is claimed to work.
Inspect is metadata-only: model IDs, extension IDs/export property names, and
candidate command IDs. Source content, tokens, credentials and export values
are not printed.
