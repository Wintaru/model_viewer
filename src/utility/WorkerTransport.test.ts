import { describe, expect, it } from "vitest";
import {
  WorkerTransport,
  type ResponseEnvelope,
  type WorkerLike,
} from "./WorkerTransport.js";

interface Posted {
  readonly message: unknown;
  readonly transfer: readonly Transferable[];
}

class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly posted: Posted[] = [];

  postMessage(message: unknown, transfer: readonly Transferable[] = []): void {
    this.posted.push({ message, transfer });
  }

  respond(response: ResponseEnvelope<unknown>): void {
    this.onmessage?.(new MessageEvent("message", { data: response }));
  }

  crash(message: string): void {
    this.onerror?.(new ErrorEvent("error", { message }));
  }

  corrupt(): void {
    this.onmessageerror?.(new MessageEvent("messageerror"));
  }
}

describe("WorkerTransport", () => {
  it("resolves a request with the response the worker posts back", async () => {
    const worker = new FakeWorker();
    const transport = new WorkerTransport<string, number>(worker);

    const result = transport.request("decode me");
    worker.respond({ id: 0, ok: true, response: 42 });

    await expect(result).resolves.toBe(42);
  });

  it("rejects when the worker reports failure", async () => {
    const worker = new FakeWorker();
    const transport = new WorkerTransport<string, number>(worker);

    const result = transport.request("decode me");
    worker.respond({ id: 0, ok: false, error: "bad geometry" });

    await expect(result).rejects.toThrow("bad geometry");
  });

  it("correlates concurrent requests, even answered out of order", async () => {
    const worker = new FakeWorker();
    const transport = new WorkerTransport<string, string>(worker);

    const first = transport.request("first");
    const second = transport.request("second");
    worker.respond({ id: 1, ok: true, response: "second's answer" });
    worker.respond({ id: 0, ok: true, response: "first's answer" });

    await expect(first).resolves.toBe("first's answer");
    await expect(second).resolves.toBe("second's answer");
  });

  it("passes the transfer list through to the worker's postMessage", () => {
    const worker = new FakeWorker();
    const transport = new WorkerTransport<Uint8Array, unknown>(worker);
    const bytes = new Uint8Array([1, 2, 3]);

    void transport.request(bytes, [bytes.buffer]);

    expect(worker.posted[0]?.transfer).toEqual([bytes.buffer]);
  });

  it("ignores a response whose id matches no pending request", async () => {
    const worker = new FakeWorker();
    const transport = new WorkerTransport<string, string>(worker);

    const pending = transport.request("first");
    worker.respond({ id: 99, ok: true, response: "for nobody" });
    worker.respond({ id: 0, ok: true, response: "first's answer" });

    await expect(pending).resolves.toBe("first's answer");
  });

  it("rejects every pending request when the worker crashes", async () => {
    const worker = new FakeWorker();
    const transport = new WorkerTransport<string, string>(worker);

    const first = transport.request("first");
    const second = transport.request("second");
    worker.crash("out of memory");

    await expect(first).rejects.toThrow("out of memory");
    await expect(second).rejects.toThrow("out of memory");
  });

  it("rejects every pending request when the worker sends an undeserializable message", async () => {
    const worker = new FakeWorker();
    const transport = new WorkerTransport<string, string>(worker);

    const pending = transport.request("first");
    worker.corrupt();

    await expect(pending).rejects.toThrow(
      "the worker sent a message that could not be deserialized",
    );
  });

  it("ignores a message with no usable id instead of throwing", async () => {
    const worker = new FakeWorker();
    const transport = new WorkerTransport<string, string>(worker);

    const pending = transport.request("first");
    worker.onmessage?.(new MessageEvent("message", { data: null }));
    worker.onmessage?.(
      new MessageEvent("message", { data: "not an envelope" }),
    );
    worker.respond({ id: 0, ok: true, response: "first's answer" });

    await expect(pending).resolves.toBe("first's answer");
  });

  it("rejects a request made after the worker already crashed, instead of hanging", async () => {
    const worker = new FakeWorker();
    const transport = new WorkerTransport<string, string>(worker);

    worker.crash("out of memory");
    const afterCrash = transport.request("too late");

    await expect(afterCrash).rejects.toThrow("out of memory");
    expect(worker.posted).toHaveLength(0);
  });
});
