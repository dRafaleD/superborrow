import { test } from "node:test";
import * as assert from "node:assert/strict";
import { nearbyDiagnostics } from "../src/diagnostics";

const diagnostic = (line: number, severity: number, message = "issue") => ({ severity, message, range: { start: { line, character: 2 }, end: { line, character: 4 } } });

test("diagnostic context selects nearby actionable messages deterministically and caps output", () => {
  const values = [diagnostic(10, 2, "info"), diagnostic(10, 3, "hint"), diagnostic(1000, 0, "distant"), diagnostic(12, 0, "near"), diagnostic(10, 1, "at cursor warning"), diagnostic(10, 0, "at cursor error")];
  assert.deepEqual(nearbyDiagnostics(values, 10).map(value => value.message), ["at cursor error", "at cursor warning", "near"]);
  assert.deepEqual(nearbyDiagnostics(values, 10), nearbyDiagnostics(values.slice().reverse(), 10));
  assert.equal(nearbyDiagnostics(Array.from({ length: 20 }, (_, index) => diagnostic(index, 0)), 0).length, 8);
});

test("diagnostic messages respect the UTF-8 cap without malformed Unicode", () => {
  const value = nearbyDiagnostics([diagnostic(0, 0, "😀".repeat(200))], 0)[0];
  assert.equal(Buffer.byteLength(value.message), 512);
  assert.equal(value.message, "😀".repeat(128));
  assert.equal(nearbyDiagnostics([diagnostic(0, 0, "bad\uD800")], 0)[0].message, "bad�");
});

test("editor Position getters are serialized as protocol coordinates", () => {
  class Position {
    constructor(private readonly _line: number, private readonly _character: number) {}
    get line() { return this._line; }
    get character() { return this._character; }
  }
  const value = nearbyDiagnostics([{ severity: 0, message: "issue", range: { start: new Position(3, 4), end: new Position(3, 8) } }], 3)[0];
  assert.equal(JSON.stringify(value.position), '{"line":3,"character":4}');
});
