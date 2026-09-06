import type { ModelSource } from "./ModelSource";

/**
 * A {@link ModelSource} over a `Response` the host already obtained — SPEC.md
 * section 7's `fromResponse`. Built with {@link fromResponse}, kept in this
 * file for the same reason as every other built-in source: a standalone
 * `fromResponse.ts` importing this class would itself be a forbidden
 * Accessor-to-Accessor edge (see DECISIONS.md).
 *
 * `readRange`/`stream` are not implemented, matching `BufferSourceAccessor`'s
 * reasoning rather than `FileSourceAccessor`'s deferred-until-proven one: the
 * request that produced this `Response` already went out, with no Range
 * header, before this constructor ever runs, so there is no smaller request
 * left to make. A caller who wants the sniff-first fast path
 * (ARCHITECTURE.md section 3) needs `UrlSourceAccessor` instead, which
 * controls the request from the start.
 */
export class ResponseSourceAccessor implements ModelSource {
  readonly name?: string;
  readonly byteLength?: number;
  private readonly response: Response;

  constructor(response: Response, name?: string) {
    this.response = response;
    if (name !== undefined) {
      this.name = name;
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > 0) {
      this.byteLength = contentLength;
    }
  }

  async read(): Promise<Uint8Array> {
    if (!this.response.ok) {
      throw new Error(
        `Response passed to fromResponse was not ok: ${this.response.status} ${this.response.statusText}`,
      );
    }
    return new Uint8Array(await this.response.arrayBuffer());
  }
}

/** Wrap a `Response` the host already obtained as a {@link ModelSource}. */
export function fromResponse(response: Response, name?: string): ModelSource {
  return new ResponseSourceAccessor(response, name);
}
