/**
 * Anything that can produce the bytes of a model file. Sources are a
 * volatile edge (ARCHITECTURE.md section 2), so this contract is
 * deliberately public and open: the library knows how to read bytes, and
 * must never know where they live. See SPEC.md section 7.
 */
export interface ModelSource {
  /** Filename, when known. A hint for format detection and diagnostics. */
  readonly name?: string;
  /**
   * A strong identity from the storage layer, when one exists (an ETag or
   * version id). Lets the cache be checked before the file is downloaded.
   */
  readonly etag?: string;
  /** Total size in bytes, when known. Enables progress reporting. */
  readonly byteLength?: number;

  /** Read the whole file. The only required method. */
  read(signal?: AbortSignal): Promise<Uint8Array>;

  /**
   * Read part of the file, when the source can. Lets the loader sniff the
   * format from a small prefix and start the decoder's lazy import in
   * parallel with the rest of the download — SPEC.md section 7, "Sniff
   * first, when the source allows it".
   */
  readRange?(
    start: number,
    end: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;

  /** Stream the file, when the source can. Enables progress on large reads. */
  stream?(signal?: AbortSignal): ReadableStream<Uint8Array>;
}
