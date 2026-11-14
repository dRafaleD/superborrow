# Superborrow — Phase 1

Rust JSON-RPC bridge for Antigravity IDE / VS Code-compatible editors.

The Windows x64 package bundles the Rust core. In a trusted workspace it starts
automatically and shows **Superborrow: Connected** in the status bar.
Run **Superborrow: Check Bridge** to reconnect and display the connection result.
Diagnostics appear in the **Superborrow** Output channel.

This phase validates the transport only. Real AI completions, FIM context,
model discovery and inline ghost text are planned for subsequent phases.

An optional absolute `superborrow.corePath` overrides the bundled core binary.

Source: https://github.com/dRafaleD/superborrow (private repository).
