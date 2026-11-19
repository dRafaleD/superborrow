interface Job<T> {
  key: string;
  controller: AbortController;
  promise: Promise<T>;
  users: Set<symbol>;
  idle?: ReturnType<typeof setTimeout>;
}

function cancelled(): Error {
  return Object.assign(new Error("Request cancelled"), { code: -32800 });
}

/** One inference shared by callers at the same document snapshot and cursor.
 * Each caller can cancel independently. A short handoff window lets the editor
 * replace its token without restarting the identical remote request.
 */
export class InflightCompletion<T> {
  private current: Job<T> | undefined;
  shared = 0;

  run(key: string, signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(cancelled());
    let job = this.current;
    if (!job || job.key !== key || job.controller.signal.aborted) {
      this.cancel();
      const controller = new AbortController();
      job = { key, controller, users: new Set(), promise: Promise.resolve().then(() => {
        if (controller.signal.aborted) throw cancelled();
        return work(controller.signal);
      }).finally(() => {
        if (job!.idle) clearTimeout(job!.idle);
        if (this.current === job) this.current = undefined;
      }) };
      this.current = job;
    } else {
      this.shared++;
      if (job.idle) { clearTimeout(job.idle); job.idle = undefined; }
    }
    const selected = job;
    const user = Symbol();
    selected.users.add(user);
    return new Promise<T>((resolve, reject) => {
      const release = () => {
        signal.removeEventListener("abort", abort);
        selected.controller.signal.removeEventListener("abort", superseded);
        selected.users.delete(user);
      };
      const superseded = () => { release(); reject(cancelled()); };
      const abort = () => {
        release();
        reject(cancelled());
        if (!selected.users.size && this.current === selected) {
          selected.idle = setTimeout(() => {
            if (!selected.users.size && this.current === selected) this.cancel();
          }, 25);
        }
      };
      signal.addEventListener("abort", abort, { once: true });
      selected.controller.signal.addEventListener("abort", superseded, { once: true });
      selected.promise.then(value => {
        release();
        if (signal.aborted || selected.controller.signal.aborted) reject(cancelled());
        else resolve(value);
      }, error => { release(); reject(error); });
    });
  }

  cancel(): void {
    const job = this.current;
    this.current = undefined;
    if (job?.idle) clearTimeout(job.idle);
    job?.controller.abort();
  }
}
