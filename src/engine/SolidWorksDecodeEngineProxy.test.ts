import { describe, expect, it, vi } from "vitest";
import type { DecodedModel } from "../common/DecodedModel.js";
import type {
  RequestEnvelope,
  ResponseEnvelope,
  WorkerLike,
} from "../utility/WorkerTransport.js";
import {
  SolidWorksDecodeEngineProxy,
  type SolidWorksDecodeRequest,
} from "./SolidWorksDecodeEngineProxy.js";

class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly posted: {
    readonly envelope: RequestEnvelope<SolidWorksDecodeRequest>;
    readonly transfer: readonly Transferable[];
  }[] = [];

  postMessage(message: unknown, transfer: readonly Transferable[] = []): void {
    this.posted.push({
      envelope: message as RequestEnvelope<SolidWorksDecodeRequest>,
      transfer,
    });
  }

  respond(response: ResponseEnvelope<DecodedModel>): void {
    this.onmessage?.(new MessageEvent("message", { data: response }));
  }
}

const emptyModel: DecodedModel = {
  units: "mm",
  meshes: [],
  tree: [],
  metadata: {},
  diagnostics: [],
};

describe("SolidWorksDecodeEngineProxy", () => {
  it("does not construct a worker until transform is called", () => {
    const createWorker = vi.fn(() => new FakeWorker());
    new SolidWorksDecodeEngineProxy(createWorker);

    expect(createWorker).not.toHaveBeenCalled();
  });

  it("constructs the worker only once, reused across repeated calls", () => {
    const worker = new FakeWorker();
    const createWorker = vi.fn(() => worker);
    const proxy = new SolidWorksDecodeEngineProxy(createWorker);

    const first = proxy.transform(new Uint8Array([1]));
    worker.respond({ id: 0, ok: true, response: emptyModel });
    const second = proxy.transform(new Uint8Array([2]));
    worker.respond({ id: 1, ok: true, response: emptyModel });

    expect(createWorker).toHaveBeenCalledTimes(1);
    return Promise.all([first, second]);
  });

  it("sends the bytes, transferring the buffer", () => {
    const worker = new FakeWorker();
    const proxy = new SolidWorksDecodeEngineProxy(() => worker);
    const bytes = new Uint8Array([1, 2, 3]);

    void proxy.transform(bytes);

    expect(worker.posted[0]?.envelope.request).toEqual({ bytes });
    expect(worker.posted[0]?.transfer).toEqual([bytes.buffer]);
  });

  it("resolves with the DecodedModel the worker responds with", async () => {
    const worker = new FakeWorker();
    const proxy = new SolidWorksDecodeEngineProxy(() => worker);
    const model: DecodedModel = { ...emptyModel, metadata: { part: "cube" } };

    const result = proxy.transform(new Uint8Array([1]));
    worker.respond({ id: 0, ok: true, response: model });

    await expect(result).resolves.toEqual(model);
  });

  it("propagates a worker-reported failure", async () => {
    const worker = new FakeWorker();
    const proxy = new SolidWorksDecodeEngineProxy(() => worker);

    const result = proxy.transform(new Uint8Array([1]));
    worker.respond({ id: 0, ok: false, error: "no-tessdata-found" });

    await expect(result).rejects.toThrow("no-tessdata-found");
  });
});
