import { fromBuffer } from "../accessor/BufferSourceAccessor";
import { fromFile } from "../accessor/FileSourceAccessor";
import type { ModelSource } from "../accessor/ModelSource";
import {
  createEmptyDecodedModel,
  type DecodedModel,
} from "../common/DecodedModel";
import { FormatSniffEngine } from "../engine/FormatSniffEngine";
import { MeshDecodeEngine } from "../engine/MeshDecodeEngine";

/**
 * What {@link ModelLoadManager.load} accepts. Narrower than SPEC.md section
 * 7's full `ModelInput` (`| string | URL`): those two variants need
 * `fromUrl`, which doesn't exist until slice 4. Widen this type when it
 * does, rather than accepting them now and failing at runtime.
 *
 * Declared here, not its own file: it has exactly one consumer
 * (`ModelLoadManager`) and no external implementer, so a separate file
 * would only create a forbidden Manager-to-Manager self-reference to fix —
 * the same reasoning that colocates `fromBuffer` with its class. See
 * DECISIONS.md.
 */
export type ModelInput = ModelSource | File | Blob | ArrayBuffer | Uint8Array;

/**
 * The whole public surface for loading, per SPEC.md section 3: ask an
 * Accessor for bytes, ask the sniffer Engine what the format is, resolve
 * the decoder for that format, run it.
 *
 * Calls Engines directly. `ModuleRegistry`, `WorkerTransport` and the
 * Engine worker-proxies (ARCHITECTURE.md section 3) arrive in slice 2 —
 * until then every decode runs synchronously on the caller's thread, and
 * every recognized format that isn't `'stl'` (the only decoder that exists
 * yet) reports `unsupported-format` rather than being dispatched anywhere.
 */
export class ModelLoadManager {
  constructor(
    private readonly sniffer: FormatSniffEngine = new FormatSniffEngine(),
    private readonly meshDecoder: MeshDecodeEngine = new MeshDecodeEngine(),
  ) {}

  async load(input: ModelInput): Promise<DecodedModel> {
    const source = toModelSource(input);
    const bytes = await source.read();
    const format = this.sniffer.transform(bytes);

    if (format === "stl") {
      return this.meshDecoder.transform(bytes);
    }
    if (format === undefined) {
      return createEmptyDecodedModel({
        severity: "error",
        code: "unrecognized-format",
        message: "Could not identify the file format from its bytes.",
      });
    }
    return createEmptyDecodedModel({
      severity: "error",
      code: "unsupported-format",
      message: `Recognized this as a ${format} file, but no decoder for it exists in this version.`,
    });
  }
}

function toModelSource(input: ModelInput): ModelSource {
  if (input instanceof ArrayBuffer || input instanceof Uint8Array) {
    return fromBuffer(input);
  }
  if (input instanceof Blob) {
    return fromFile(input);
  }
  return input;
}
