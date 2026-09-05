import type { ModelSource } from "./ModelSource";

/**
 * A {@link ModelSource} over bytes already in memory. Built with
 * {@link fromBuffer} — kept in this file, not a separate one, because a
 * standalone `fromBuffer.ts` importing this class would itself be a
 * forbidden Accessor-to-Accessor edge (see DECISIONS.md).
 */
export class BufferSourceAccessor implements ModelSource {
  readonly name?: string;
  readonly byteLength: number;
  private readonly bytes: Uint8Array;

  constructor(bytes: ArrayBuffer | Uint8Array, name?: string) {
    this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.byteLength = this.bytes.byteLength;
    if (name !== undefined) {
      this.name = name;
    }
  }

  read(): Promise<Uint8Array> {
    return Promise.resolve(this.bytes);
  }
}

/**
 * Wrap bytes already in memory as a {@link ModelSource}. `readRange` and
 * `stream` are deliberately not implemented: the whole buffer is already
 * resident, so there is no partial-read cost to avoid.
 *
 * A `Uint8Array` passed in is stored and returned by reference, not copied —
 * mutating it after the call, or mutating what `read()` returns, changes
 * what every later `read()` call sees. Pass a fresh array if that matters.
 */
export function fromBuffer(
  bytes: ArrayBuffer | Uint8Array,
  name?: string,
): ModelSource {
  return new BufferSourceAccessor(bytes, name);
}
