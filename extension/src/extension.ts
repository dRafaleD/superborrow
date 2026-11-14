import * as vscode from "vscode";
import * as path from "node:path";
import { existsSync } from "node:fs";
import { ResponseError } from "vscode-jsonrpc/node";
import { CoreBridge } from "./bridge";

let bridge: CoreBridge | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Superborrow");
  context.subscriptions.push(output);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10);
  status.command = "superborrow.checkBridge";
  status.tooltip = "Superborrow Phase 1: Rust bridge status. Click to reconnect.";
  context.subscriptions.push(status);
  let connecting: Promise<void> | undefined;
  const connect = async (notify: boolean): Promise<void> => {
    if (!vscode.workspace.isTrusted) return;
    status.text = "$(sync~spin) Superborrow";
    status.show();
    const document = vscode.window.activeTextEditor?.document;
    try {
      bridge?.dispose();
      const configured = vscode.workspace.getConfiguration("superborrow").get<string>("corePath", "");
      if (configured && !path.isAbsolute(configured)) throw new Error("corePath must be absolute");
      const name = process.platform === "win32" ? "superborrow-core.exe" : "superborrow-core";
      const bundled = path.join(context.extensionPath, "bin", name);
      const binary = configured || (existsSync(bundled) ? bundled : path.resolve(context.extensionPath, "..", "core-rust", "target", "debug", name));
      bridge = new CoreBridge(binary, async () => {
        output.appendLine("Reverse-RPC requestIdeModel received successfully.");
        throw new ResponseError(-32004, "IDE model adapter is planned for phase 4");
      }, (line) => output.appendLine(line));
      const info = await bridge.initialize();
      output.appendLine(`Connected: protocol ${info.protocolVersion}, phase ${info.phase}`);
      if (document) {
        await bridge.updateDocument({ uri: document.uri.toString(), version: document.version, languageId: document.languageId, text: document.getText() });
      }
      status.text = "$(plug) Superborrow: Connected";
      if (notify) void vscode.window.showInformationMessage("Superborrow: Rust bridge connected (phase 1).");
    } catch (error) {
      bridge?.dispose();
      bridge = undefined;
      output.appendLine(String(error));
      status.text = "$(warning) Superborrow: Disconnected";
      if (notify) void vscode.window.showErrorMessage(`Superborrow: ${String(error)}`);
    }
  };
  const start = (notify: boolean): Promise<void> => {
    connecting ??= connect(notify).finally(() => { connecting = undefined; });
    return connecting;
  };
  context.subscriptions.push(vscode.commands.registerCommand("superborrow.checkBridge", () => start(true)));
  void start(false);
  context.subscriptions.push({ dispose: () => bridge?.dispose() });
}

export async function deactivate(): Promise<void> {
  await bridge?.shutdown();
  bridge = undefined;
}
