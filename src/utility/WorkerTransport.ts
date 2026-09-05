/**
 * The slice of the DOM `Worker` surface a transport needs — a structural
 * type rather than the real `Worker` class, so a test can hand in an
 * in-process fake without a real browser Worker existing. A real `Worker`
 * instance satisfies this without change.
 */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: readonly Transferable[]): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror?: ((event: MessageEvent<unknown>) => void) | null;
}

/** The wire shape `WorkerTransport.request` sends. */
export interface RequestEnvelope<TRequest> {
  readonly id: number;
  readonly request: TRequest;
}

/**
 * The wire shape a worker-side listener replies with — `ok: true` on
 * success, `ok: false` with a plain string on failure (an `Error` does not
 * survive the structured clone algorithm with its prototype intact, so the
 * message is all a worker can hand back).
 */
export type ResponseEnvelope<TResponse> =
  | { readonly id: number; readonly ok: true; readonly response: TResponse }
  | { readonly id: number; readonly ok: false; readonly error: string };

/**
 * Generic request/response correlation over a `Worker`, per ARCHITECTURE.md
 * section 3: "the worker is transport, not a layer." One instance pairs
 * with one worker running one Engine, matching the diagram's 1:1
 * `WorkerTransport` — worker-side Engine relationship, so this is generic
 * over a single request/response pair rather than per-call. Carries no
 * dependency on `Common` or any other layer, keeping it a leaf Utility.
 *
 * A worker crash or a message the structured clone algorithm can't
 * deserialize (`onerror` / `onmessageerror`) rejects every request still
 * waiting, rather than leaving its promise hanging forever — the same
 * "never let a caller wait on a channel we already know is broken"
 * reasoning `ModuleRegistry` applies to a failed import.
 */
export class WorkerTransport<TRequest, TResponse> {
  private nextId = 0;
  private failure: Error | undefined;
  private readonly pending = new Map<
    number,
    {
      resolve: (response: TResponse) => void;
      reject: (error: unknown) => void;
    }
  >();

  constructor(private readonly worker: WorkerLike) {
    worker.onmessage = (event) => this.handleMessage(event);
    worker.onerror = (event) => this.fail(new Error(event.message));
    worker.onmessageerror = () =>
      this.fail(
        new Error("the worker sent a message that could not be deserialized"),
      );
  }

  /**
   * A worker that has already crashed or sent an undeserializable message
   * isn't coming back — nothing left in this transport can turn that into
   * a resolution or a rejection for a request made afterwards, unlike
   * `ModuleRegistry`'s retryable network fetch. So once `failure` is set,
   * every later call rejects immediately instead of posting into the void
   * and waiting on a response that will never arrive.
   */
  request(
    request: TRequest,
    transfer: readonly Transferable[] = [],
  ): Promise<TResponse> {
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    const id = this.nextId++;
    return new Promise<TResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const envelope: RequestEnvelope<TRequest> = { id, request };
      this.worker.postMessage(envelope, transfer);
    });
  }

  private handleMessage(event: MessageEvent<unknown>): void {
    const envelope = event.data;
    if (
      envelope === null ||
      typeof envelope !== "object" ||
      !("id" in envelope)
    ) {
      return;
    }
    const { id } = envelope;
    if (typeof id !== "number") {
      return;
    }
    const waiting = this.pending.get(id);
    if (waiting === undefined) {
      return;
    }
    this.pending.delete(id);
    const response = envelope as ResponseEnvelope<TResponse>;
    if (response.ok) {
      waiting.resolve(response.response);
    } else {
      waiting.reject(new Error(response.error));
    }
  }

  private fail(error: Error): void {
    this.failure = error;
    for (const waiting of this.pending.values()) {
      waiting.reject(error);
    }
    this.pending.clear();
  }
}
