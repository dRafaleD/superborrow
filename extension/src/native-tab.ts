/** Narrow use of the host's exported state API: only the tabEnabled row.
 * Wire layout inspected in Antigravity 1.107 / host extension 1.11.0:
 * unified_state_sync.Primitive.int32_value = field 2; OFF=1, ON=2.
 */
export interface NativeTabSync {
  TabPreferences: { getTabEnabled(): Promise<number> };
  subscribe(topic: "uss-tabPreferences"): Promise<{ getState(): Partial<Record<string, { value: string; eTag: string | bigint }>> }>;
  pushUpdate(update: { topicName: "uss-tabPreferences"; appliedUpdate: { key: "tabEnabled"; newRow: { value: string; eTag: string } } }): Promise<void>;
}

export class NativeTabControl {
  constructor(private readonly sync: NativeTabSync) {
    if (typeof sync?.TabPreferences?.getTabEnabled !== "function" || typeof sync?.subscribe !== "function" || typeof sync?.pushUpdate !== "function") throw new Error("This Antigravity host cannot coordinate its native Tab provider");
  }
  get(): Promise<number> { return this.sync.TabPreferences.getTabEnabled(); }
  async set(value: number): Promise<void> {
    if (value !== 1 && value !== 2) throw new Error("Only native Tab OFF/ON values are supported");
    const current = await this.get();
    if (current === value) return;
    const state = await this.sync.subscribe("uss-tabPreferences");
    const row = state.getState().tabEnabled;
    if (row) {
      const bytes = Buffer.from(row.value, "base64");
      if (bytes.length !== 2 || bytes[0] !== 0x10 || ![0, 1, 2].includes(bytes[1])) throw new Error("Antigravity Tab preference encoding changed; no setting was modified");
      if ((bytes[1] || 2) !== current) throw new Error("Native Tab preference changed concurrently; retry the command");
    }
    await this.sync.pushUpdate({ topicName: "uss-tabPreferences", appliedUpdate: {
      key: "tabEnabled", newRow: { value: Buffer.from([0x10, value]).toString("base64"), eTag: String(row?.eTag ?? "0") },
    } });
    for (let attempt = 0; attempt < 20; attempt++) {
      if (await this.get() === value) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("Antigravity did not confirm the native Tab preference update");
  }
}
