import type { ModelSource } from "./ModelSource.js";

/**
 * A {@link ModelSource} over a `File` or `Blob`. Built with {@link fromFile}
 * — kept in this file for the same reason as `BufferSourceAccessor`: a
 * standalone `fromFile.ts` importing this class would be a forbidden
 * Accessor-to-Accessor edge.
 *
 * `readRange`/`stream` are not implemented here, even though `Blob.slice()`
 * could support them cheaply — deferred until the sniff-first path actually
 * uses a `readRange`-capable source, which needs `UrlSourceAccessor` /
 * `ResponseSourceAccessor` (SPEC.md section 10, slice 4), not commit 11's
 * `ModelLoadManager`. Rather than guess at behaviour nothing consumes yet.
 */
export class FileSourceAccessor implements ModelSource {
  readonly name?: string;
  readonly byteLength: number;
  private readonly file: File | Blob;

  constructor(file: File | Blob, name?: string) {
    this.file = file;
    this.byteLength = file.size;
    const resolvedName = name ?? (file instanceof File ? file.name : undefined);
    if (resolvedName !== undefined) {
      this.name = resolvedName;
    }
  }

  // No `signal` parameter: Blob/File's `arrayBuffer()` has no standard
  // cancellation hook to forward it to.
  async read(): Promise<Uint8Array> {
    return new Uint8Array(await this.file.arrayBuffer());
  }
}

/**
 * Wrap a `File` or `Blob` as a {@link ModelSource}. When `name` is omitted,
 * a `File`'s own `name` is used; a plain `Blob` has none, so `name` is left
 * unset.
 */
export function fromFile(file: File | Blob, name?: string): ModelSource {
  return new FileSourceAccessor(file, name);
}
