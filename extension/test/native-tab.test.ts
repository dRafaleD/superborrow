import { test } from "node:test";
import * as assert from "node:assert/strict";
import { NativeTabControl, NativeTabSync } from "../src/native-tab";

test("native Tab coordination changes only tabEnabled and supports restoration", async () => {
  let current = 2;
  let row: { value: string; eTag: string } | undefined;
  const updates: unknown[] = [];
  const sync: NativeTabSync = {
    TabPreferences: { async getTabEnabled() { return current; } },
    async subscribe(topic) {
      assert.equal(topic, "uss-tabPreferences");
      return { getState: () => row ? { tabEnabled: row, untouched: { value: "private-other-setting", eTag: "12" } } : {} };
    },
    async pushUpdate(update) {
      updates.push(update);
      assert.equal(update.topicName, "uss-tabPreferences");
      assert.equal(update.appliedUpdate.key, "tabEnabled");
      assert.deepEqual(Object.keys(update.appliedUpdate), ["key", "newRow"]);
      current = Buffer.from(update.appliedUpdate.newRow.value, "base64")[1];
      row = { value: update.appliedUpdate.newRow.value, eTag: "5" };
    },
  };
  const control = new NativeTabControl(sync);
  await control.set(1); assert.equal(await control.get(), 1);
  await control.set(1); assert.equal(updates.length, 1);
  await control.set(2); assert.equal(await control.get(), 2); assert.equal(updates.length, 2);
});

test("unknown native preference encoding fails without writing", async () => {
  let writes = 0;
  const control = new NativeTabControl({
    TabPreferences: { async getTabEnabled() { return 2; } },
    async subscribe() { return { getState: () => ({ tabEnabled: { value: Buffer.from([8, 1]).toString("base64"), eTag: "2" } }) }; },
    async pushUpdate() { writes++; },
  });
  await assert.rejects(control.set(1), /encoding changed/);
  await assert.rejects(control.set(0), /OFF\/ON/);
  assert.equal(writes, 0);
});
