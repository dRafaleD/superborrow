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

test("catalog model switching performs no extra discovery and invalid selection cannot reuse an old model", async () => {
  let discoveries = 0;
  const seen: number[] = [];
  const rpc: AntigravityRpc = {
    async getAvailableModels() { discoveries++; return response; },
    async getModelResponse(request) { seen.push(request.model); return { response: "x" }; },
  };
  const bridge = new AntigravityBridge(rpc);
  const signal = new AbortController().signal;
  await bridge.discover(signal);
  await bridge.generate("a", signal);
  bridge.select("claude-sonnet-low");
  await bridge.generate("b", signal);
  assert.deepEqual(seen, [1527, 1403]);
  assert.equal(discoveries, 1);
  assert.throws(() => bridge.select("disabled"), /unavailable/);
  await assert.rejects(bridge.generate("c", signal), /not been initialized/);
  assert.equal(seen.length, 2);
});

test("automatic completion excludes specialized models and prefers low-reasoning fallback variants", () => {
  const models = modelCatalog({ response: { models: {
    image: { displayName: 'Gemini Flash Image', model: 1 },
    orchestrator: { displayName: 'Orchestrator', model: 2 },
    'flash-high': { displayName: 'Gemini Flash (High)', model: 3 },
    'flash-medium': { displayName: 'Gemini Flash (Medium)', model: 4 },
    'flash-low': { displayName: 'Gemini Flash (Low)', model: 5 },
    'flash-lite': { displayName: 'Gemini Flash Lite', model: 6 },
    'sonnet-low': { displayName: 'Claude Sonnet (Low)', model: 7 },
  } } });
  assert.equal(automaticModel(models)?.slug, 'sonnet-low');
  assert.equal(automaticModel(models.filter(model => model.slug !== 'sonnet-low'))?.slug, 'flash-low');
  assert.equal(automaticModel(models.filter(model => /image|orchestrator/.test(model.slug))), undefined);
});

test("a catalog containing only specialized models never sends an automatic completion prompt", async () => {
  let requests = 0;
  const bridge = new AntigravityBridge({
    async getAvailableModels() { return { response: { models: { image: { displayName: 'Flash Image', model: 1 } } } }; },
    async getModelResponse() { requests++; return { response: 'not code' }; },
  });
  const signal = new AbortController().signal;
  await assert.rejects(bridge.discover(signal), /enabled text model/);
  await assert.rejects(bridge.generate('complete', signal), /not been initialized/);
  assert.equal(requests, 0);
  // Explicit pinning remains a user choice; auto never silently changes it.
  bridge.select('image');
  assert.equal(bridge.slug, 'image');
});
