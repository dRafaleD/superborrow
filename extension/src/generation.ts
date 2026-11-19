export const cancelled = () => Object.assign(new Error("Request cancelled"), { code: -32800 });

export async function withDeadline<T>(signal: AbortSignal, timeoutMs: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (signal.aborted) throw cancelled();
  const controller = new AbortController();
  let timeout = false;
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timeout = true; controller.abort(); }, timeoutMs);
  let stopped!: () => void;
  const interruption = new Promise<never>((_, reject) => {
    stopped = () => reject(timeout ? Object.assign(new Error("Completion timed out"), { code: -32002 }) : cancelled());
    controller.signal.addEventListener("abort", stopped, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(() => { if (controller.signal.aborted) throw cancelled(); return work(controller.signal); }), interruption]); }
  finally {
    clearTimeout(timer); signal.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", stopped); controller.abort();
  }
}

export function debounce(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(cancelled());
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(cancelled()); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
