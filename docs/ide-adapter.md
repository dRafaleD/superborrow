# IDE model adapter v1

In Antigravity 1.11.0, the built-in extension exports a model RPC client. The
native adapter uses its model catalog and pure model-response method, preserving
the host's authentication. `ideModel: auto` binds it on startup. A selected
`antigravity:<slug>` is restored from configuration. Other VS Code hosts can use
`vscode.lm`; **Select IDE Model** handles their initial selection/consent.
**Inspect Available Models** lists the native catalog as well as portable models.
The implementation does not invoke unknown commands or scrape sessions.

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

The native adapter is checked against the installed host's exported API, which
can change across host versions. It does not create its own authenticated HTTP
client or extract host credentials. The custom adapter contract above is still
available for other provider extensions.
Inspect is metadata-only: model IDs, extension IDs/export property names, and
candidate command IDs. Source content, tokens, credentials and export values
are not printed.
