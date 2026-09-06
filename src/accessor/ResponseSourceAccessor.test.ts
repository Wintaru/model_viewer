import { describe, expect, it } from "vitest";
import { fromResponse } from "./ResponseSourceAccessor";

describe("fromResponse", () => {
  it("reads back the same bytes given a successful Response", async () => {
    const response = new Response(new Uint8Array([1, 2, 3, 4]));

    const source = fromResponse(response);

    expect(await source.read()).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("rejects when the Response is not ok", async () => {
    const response = new Response(null, {
      status: 404,
      statusText: "Not Found",
    });

    const source = fromResponse(response);

    await expect(source.read()).rejects.toThrow(
      "Response passed to fromResponse was not ok: 404 Not Found",
    );
  });

  it("reports byteLength from the Content-Length header when present", () => {
    const response = new Response(new Uint8Array(5), {
      headers: { "content-length": "5" },
    });

    const source = fromResponse(response);

    expect(source.byteLength).toBe(5);
  });

  it("leaves byteLength undefined when Content-Length is absent", () => {
    // The undici Response built above sets Content-Length itself from a
    // known-length body; a streamed Response with no explicit header is
    // the case this test means to cover.
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
      }),
    );

    const source = fromResponse(response);

    expect(source.byteLength).toBeUndefined();
  });

  it("takes the explicit name when given", () => {
    const source = fromResponse(new Response(null), "part.stp");

    expect(source.name).toBe("part.stp");
  });

  it("leaves name undefined when none is given", () => {
    const source = fromResponse(new Response(null));

    expect(source.name).toBeUndefined();
  });

  it("does not implement readRange or stream", () => {
    const source = fromResponse(new Response(null));

    expect("readRange" in source).toBe(false);
    expect("stream" in source).toBe(false);
  });
});
