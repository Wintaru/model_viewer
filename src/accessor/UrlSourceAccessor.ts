import type { ModelSource } from "./ModelSource";

/**
 * A bare `fetch` reference, called later as `this.fetchImpl(...)`, invokes
 * the native function with the wrong receiver — browsers that brand-check
 * `fetch`'s `this` throw "Illegal invocation" (see `WasmAssetAccessor`'s
 * identical fix, and REVIEW-BACKLOG.md's slice-2 planning entry). Wrapping
 * it in a plain function keeps the call inside a normal function body, so
 * `fetch` is always invoked as itself regardless of how `fetchImpl` is
 * later called.
 */
const defaultFetch: typeof globalThis.fetch = (input, init) =>
  fetch(input, init);

/** SPEC.md section 7's `UrlSourceInit`. */
export interface UrlSourceInit {
  /** Inject authentication, retry, or a proxy. Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: HeadersInit;
  readonly name?: string;
}

/**
 * A {@link ModelSource} over a URL — SPEC.md section 7's `fromUrl`. Built
 * with {@link fromUrl}, kept in this file for the same reason as every other
 * built-in source (see DECISIONS.md).
 *
 * This is where a signed URL from Supabase Storage, S3 or Azure Blob enters
 * the library: `fetch` is a narrow, injectable knob for attaching an
 * `Authorization` header or a retrying transport, not a general extension
 * mechanism (ARCHITECTURE.md section 5) — the library never holds a token.
 *
 * Implements `readRange` over an HTTP `Range` request — the capability that
 * unlocks ARCHITECTURE.md section 3's sniff-first fast path: the loader
 * reads a small prefix to identify the format before the full file has
 * finished downloading.
 */
export class UrlSourceAccessor implements ModelSource {
  readonly name?: string;
  private readonly url: string | URL;
  private readonly fetchImpl: typeof globalThis.fetch;
  // Typed with the `| undefined` spelled out, not as an optional (`?`)
  // property: exactOptionalPropertyTypes (tsconfig.json) forbids assigning
  // `undefined` to an optional property, which `init.headers` may well be.
  private readonly headers: HeadersInit | undefined;

  constructor(url: string | URL, init: UrlSourceInit = {}) {
    this.url = url;
    this.fetchImpl = init.fetch ?? defaultFetch;
    this.headers = init.headers;
    if (init.name !== undefined) {
      this.name = init.name;
    }
  }

  async read(signal?: AbortSignal): Promise<Uint8Array> {
    const response = await this.fetchImpl(
      this.url,
      this.requestInit(signal, this.headers),
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Failed to fetch ${String(this.url)}: ${response.status} ${response.statusText}`,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  /**
   * Requests only `[start, end)` over HTTP `Range`. A compliant server
   * answers `206 Partial Content` with exactly those bytes. Some proxies
   * and CDNs strip the `Range` header instead of honoring it and answer
   * `200` with the whole body — detected here and sliced locally, so the
   * `[start, end)` contract holds either way rather than silently handing
   * back more bytes than the caller asked for.
   */
  async readRange(
    start: number,
    end: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const headers = new Headers(this.headers);
    headers.set("range", `bytes=${start}-${end - 1}`);
    const response = await this.fetchImpl(
      this.url,
      this.requestInit(signal, headers),
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Failed to fetch ${String(this.url)}: ${response.status} ${response.statusText}`,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return response.status === 206 ? bytes : bytes.subarray(start, end);
  }

  // exactOptionalPropertyTypes rejects `{ headers: undefined }` /
  // `{ signal: undefined }` against RequestInit's own optional properties,
  // so this only sets a key at all when there's a real value for it.
  private requestInit(
    signal: AbortSignal | undefined,
    headers: HeadersInit | undefined,
  ): RequestInit {
    const init: RequestInit = {};
    if (headers !== undefined) {
      init.headers = headers;
    }
    if (signal !== undefined) {
      init.signal = signal;
    }
    return init;
  }
}

/**
 * Wrap a URL as a {@link ModelSource}. Works identically for a signed
 * Supabase Storage, S3 or Azure Blob URL — see SPEC.md section 7's
 * "anything else: implement the interface" examples.
 */
export function fromUrl(url: string | URL, init?: UrlSourceInit): ModelSource {
  return new UrlSourceAccessor(url, init);
}
