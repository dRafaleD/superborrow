import { test } from "node:test";
import * as assert from "node:assert/strict";
import { AntigravityBridge, AntigravityRpc, automaticModel, modelCatalog } from "../src/antigravity";

const response = { response: { models: {
  disabled: { displayName: "Gemini 9 Flash Lite", model: 99, disabled: true },
  internal: { displayName: "Internal", model: 88, isInternal: true },
  tab: { model: 7 },
  "gemini-3.5-flash-lite": { displayName: "Gemini 3.5 Flash Lite", model: 1198 },
  "gemini-4-hydrogen-low": { displayName: "Gemini 4 Hydrogen (Low)", model: 1527 },
  "claude-sonnet-low": { displayName: "Claude Sonnet (Low)", model: 1403 },
} } };

test("native catalog uses actual IDs and deterministically chooses an enabled fast model", () => {
  const models = modelCatalog(response);
  assert.equal(models.length, 4);
  assert.equal(automaticModel(models)?.slug, "gemini-4-hydrogen-low");
  assert.equal(automaticModel(models.filter(model => model.disabled)), undefined);
});

test("pinned native models receive the prompt and cancellation signal through host RPC", async () => {
  const signal = new AbortController().signal;
  const rpc: AntigravityRpc = {
    async getAvailableModels() { return response; },
    async getModelResponse(request, options) {
      assert.equal(request.model, 1403); assert.equal(request.prompt, "complete this");
      assert.equal(options.signal, signal); return { response: "  answer" };
    },
  };
  const bridge = new AntigravityBridge(rpc);
  await bridge.discover(signal, "claude-sonnet-low");
  assert.equal(bridge.label, "Claude Sonnet (Low)");
  assert.deepEqual(await bridge.generate("complete this", signal), { text: "  answer" });
  await assert.rejects(bridge.discover(signal, "disabled"), /unavailable/);
});

test("native adapter does not invent a response for unavailable, cancelled, or incompatible APIs", async () => {
  let calls = 0;
  const rpc: AntigravityRpc = {
    async getAvailableModels() { return response; },
    async getModelResponse() { calls++; throw new Error("Quota exhausted"); },
  };
  const bridge = new AntigravityBridge(rpc);
  await bridge.discover(new AbortController().signal);
  await assert.rejects(bridge.generate("x", new AbortController().signal), /Quota/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(bridge.generate("x", abort.signal), /cancelled/);
  assert.equal(calls, 1);
  assert.throws(() => new AntigravityBridge({} as AntigravityRpc), /incompatible/);
});
