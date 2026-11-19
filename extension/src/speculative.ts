export interface TypingSnapshot {
  uri: string;
  version: number;
  languageId: string;
  text: string;
  offset: number;
}
export interface Prediction<T> { text: string; metadata: T }
export interface TypingResult<T> extends Prediction<T> {
  version: number;
  offset: number;
  speculative: boolean;
}
interface Job<T> {
  origin: TypingSnapshot;
  controller: AbortController;
  id: number;
}
interface Subscriber<T> {
  version: number;
  offset: number;
  signal: AbortSignal;
  resolve(value: TypingResult<T>): void;
  reject(error: unknown): void;
  release(): void;
}
interface State<T> {
  key: string;
  latest: TypingSnapshot;
  jobs: Job<T>[];
  subscribers: Set<Subscriber<T>>;
  ready?: { origin: TypingSnapshot; value: Prediction<T>; expires: number };
  forwarded: number;
  failure?: { id: number; error: unknown };
  idle?: ReturnType<typeof setTimeout>;
}

const cancelled = () => Object.assign(new Error("Request cancelled"), { code: -32800 });

/** Race at most two cloud predictions: the oldest compatible request and one
 * fresh request for the current snapshot. Old output wins only after exact
 * typed-prefix reconciliation; a mismatch never delays the fresh request.
 */
export class SpeculativeCompletion<T> {
  private current: State<T> | undefined;
  private serial = 0;
  private readonly events: Array<Record<string, unknown>> = [];
  shared = 0;
  hits = 0;
  cached = 0;
  misses = 0;
  constructor(private readonly now: () => number = Date.now, private readonly handoffMs = 25) {}

  get status() {
    return { pending: this.current?.jobs.length ?? 0, forwarded: this.current?.forwarded ?? 0, ready: !!this.current?.ready, shared: this.shared, hits: this.hits, cached: this.cached, misses: this.misses, trace: this.events.slice() };
  }
  private trace(event: string, extra: Record<string, unknown> = {}): void {
    this.events.push({ event, version: this.current?.latest.version, offset: this.current?.latest.offset, pending: this.current?.jobs.length, ...extra });
    while (this.events.length > 24) this.events.shift();
  }
  get uri(): string | undefined { return this.current?.latest.uri; }
  matchesCursor(uri: string, version: number, offset: number): boolean {
    const snapshot = this.current?.latest;
    return !!snapshot && snapshot.uri === uri && snapshot.version === version && snapshot.offset === offset;
  }

  advance(snapshot: Omit<TypingSnapshot, "offset">, changes: readonly { rangeOffset: number; rangeLength: number; text: string }[]): boolean {
    const state = this.current;
    const change = changes[0];
    if (!state || snapshot.uri !== state.latest.uri || snapshot.languageId !== state.latest.languageId
      || snapshot.version !== state.latest.version + 1 || changes.length !== 1 || change.rangeLength !== 0
      || change.rangeOffset !== state.latest.offset || !change.text || state.forwarded + change.text.length > 256
      || snapshot.text !== state.latest.text.slice(0, state.latest.offset) + change.text + state.latest.text.slice(state.latest.offset)) {
      if (state) this.trace("reject-edit", { receivedVersion: snapshot.version, changes: changes.length, rangeOffset: change?.rangeOffset, rangeLength: change?.rangeLength, sameDocument: snapshot.uri === state.latest.uri, sameLanguage: snapshot.languageId === state.latest.languageId });
      return false;
    }
    state.latest = { ...snapshot, offset: state.latest.offset + change.text.length };
    state.forwarded += change.text.length;
    this.trace("forward", { characters: change.text.length });
    if (state.ready) {
      const result = this.remainder(state, state.ready.origin, state.ready.value);
      if (!result) { this.cancel(); return false; }
      if (!result.text) state.ready = undefined;
    }
    if (!state.subscribers.size && state.jobs.length) this.idle(state, 750);
    return true;
  }

  run(snapshot: TypingSnapshot, key: string, signal: AbortSignal, work: (origin: TypingSnapshot, signal: AbortSignal) => Promise<Prediction<T>>): Promise<TypingResult<T>> {
    if (signal.aborted) return Promise.reject(cancelled());
    let state = this.current;
    if (!state || state.key !== key || !this.same(state.latest, snapshot)) {
      this.trace("replace-session", { keyChanged: state?.key !== key, requestedVersion: snapshot.version, requestedOffset: snapshot.offset });
      this.cancel("snapshot or model context changed");
      state = { key, latest: snapshot, jobs: [], subscribers: new Set(), forwarded: 0 };
      this.current = state;
    }
    if (state.idle) { clearTimeout(state.idle); state.idle = undefined; }
    if (state.ready) {
      const ready = state.ready;
      const result = ready.expires > this.now() ? this.remainder(state, ready.origin, ready.value) : undefined;
      if (result) { this.cached++; return Promise.resolve(result); }
      state.ready = undefined;
    }
    if (!state.jobs.length) state.forwarded = 0;
    const selected = state;
    const promise = new Promise<TypingResult<T>>((resolve, reject) => {
      const abort = () => { subscriber.release(); this.trace("caller-abort", { requestedVersion: snapshot.version, subscribers: selected.subscribers.size }); reject(cancelled()); if (!selected.subscribers.size && selected.jobs.length) this.idle(selected, selected.forwarded ? 750 : this.handoffMs); };
      const subscriber: Subscriber<T> = { version: snapshot.version, offset: snapshot.offset, signal, resolve, reject,
        release: () => { signal.removeEventListener("abort", abort); selected.subscribers.delete(subscriber); } };
      selected.subscribers.add(subscriber);
      signal.addEventListener("abort", abort, { once: true });
    });
    if (state.jobs.some(job => this.same(job.origin, snapshot))) this.shared++;
    else {
      // Retain the oldest prediction; replace only the newer speculative job.
      if (state.jobs.length === 2) { const previous = state.jobs.pop()!; previous.controller.abort(); }
      const job: Job<T> = { origin: snapshot, controller: new AbortController(), id: ++this.serial };
      state.failure = undefined;
      state.jobs.push(job);
      this.trace("start", { id: job.id });
      void Promise.resolve().then(() => {
        if (job.controller.signal.aborted) throw cancelled();
        return work(job.origin, job.controller.signal);
      }).then(value => this.finished(selected, job, value), error => this.failed(selected, job, error));
    }
    return promise;
  }

  private same(a: TypingSnapshot, b: TypingSnapshot): boolean {
    return a.uri === b.uri && a.version === b.version && a.offset === b.offset && a.languageId === b.languageId && a.text === b.text;
  }
  private remainder(state: State<T>, origin: TypingSnapshot, value: Prediction<T>): TypingResult<T> | undefined {
    const typed = state.latest.text.slice(origin.offset, state.latest.offset);
    if (!value.text.startsWith(typed)) return undefined;
    return { ...value, text: value.text.slice(typed.length), version: state.latest.version, offset: state.latest.offset, speculative: origin.version !== state.latest.version };
  }
  private finished(state: State<T>, job: Job<T>, value: Prediction<T>): void {
    if (this.current !== state || job.controller.signal.aborted || !state.jobs.includes(job)) return;
    state.jobs = state.jobs.filter(item => item !== job);
    const result = this.remainder(state, job.origin, value);
    // A fully consumed old prediction must not suppress a useful fresh one.
    if (!result || (result.speculative && !result.text)) {
      this.trace("miss", { id: job.id, originVersion: job.origin.version });
      this.misses++;
      if (!state.jobs.length) this.rejectSubscribers(state, state.failure?.error ?? cancelled());
      return;
    }
    if (result.speculative) this.hits++;
    this.trace("win", { id: job.id, originVersion: job.origin.version, speculative: result.speculative });
    if (state.idle) { clearTimeout(state.idle); state.idle = undefined; }
    state.ready = { origin: job.origin, value, expires: this.now() + (value.text ? 15000 : 2000) };
    for (const other of state.jobs) other.controller.abort();
    state.jobs = [];
    for (const subscriber of [...state.subscribers]) {
      subscriber.release();
      if (subscriber.signal.aborted || subscriber.version !== result.version || subscriber.offset !== result.offset) subscriber.reject(cancelled());
      else subscriber.resolve(result);
    }
  }
  private failed(state: State<T>, job: Job<T>, error: unknown): void {
    if (this.current !== state || job.controller.signal.aborted || !state.jobs.includes(job)) return;
    state.jobs = state.jobs.filter(item => item !== job);
    if (!state.failure || job.id > state.failure.id) state.failure = { id: job.id, error };
    this.trace("failure", { id: job.id, code: (error as { code?: number })?.code });
    if (!state.jobs.length) this.rejectSubscribers(state, state.failure.error);
  }
  private rejectSubscribers(state: State<T>, error: unknown): void {
    for (const subscriber of [...state.subscribers]) { subscriber.release(); subscriber.reject(error); }
  }
  private idle(state: State<T>, ms: number): void {
    if (state.idle) clearTimeout(state.idle);
    state.idle = setTimeout(() => { if (this.current === state && !state.subscribers.size) this.cancel("no callers"); }, ms);
  }
  cancel(reason = "context changed"): void {
    const state = this.current;
    if (state) this.trace("cancel", { reason });
    this.current = undefined;
    if (!state) return;
    if (state.idle) clearTimeout(state.idle);
    for (const job of state.jobs) job.controller.abort();
    this.rejectSubscribers(state, cancelled());
  }
}
