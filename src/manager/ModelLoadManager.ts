import { fromBuffer } from "../accessor/BufferSourceAccessor";
import { fromFile } from "../accessor/FileSourceAccessor";
import type { ModelSource } from "../accessor/ModelSource";
import {
  createEmptyDecodedModel,
  type DecodedModel,
} from "../common/DecodedModel";
import { FormatSniffEngine } from "../engine/FormatSniffEngine";
import { MeshDecodeEngine } from "../engine/MeshDecodeEngine";
import { ModuleRegistry } from "../utility/ModuleRegistry";

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
 * What `ModuleRegistry`'s `"step"` loader must resolve to. Matches
 * `MeshDecodeEngine`/`OcctDecodeEngine`/`OcctDecodeEngineProxy`'s own
 * `transform` shape, but declared independently rather than imported from
 * any of them — a test's fake decoder, or a caller building their own
 * registry, needs no import of `OcctDecodeEngineProxy` (and the real
 * `Worker` it would try to construct) at all.
 */
export interface StepDecoder {
  transform(bytes: Uint8Array): Promise<DecodedModel>;
}

/**
 * Configures how `'step'`-sniffed bytes get decoded. A plain string is the
 * common case — the OCCT wasm asset's URL, used to build a lazy registry
 * that imports `OcctDecodeEngineProxy` on first use (SPEC.md section 10
 * slice 2, ARCHITECTURE.md section 3). Passing an already-built
 * `ModuleRegistry` directly is how a test substitutes a fake decoder
 * without touching the real proxy or the `Worker` it constructs — the same
 * "accepts injected engines" pattern `sniffer`/`meshDecoder` already use,
 * just shaped as a union instead of a second constructor parameter,
 * because unlike those two this one has no parameterless real default:
 * see `WasmAssetAccessor`'s doc comment for why no URL is guessed.
 */
export type StepDecoderConfig = string | ModuleRegistry<"step", StepDecoder>;

/**
 * What `ModuleRegistry`'s `"solidworks"` loader must resolve to. Same shape
 * as `StepDecoder` — matches `SolidWorksDecodeEngineProxy`'s own
 * `transform`, declared independently for the same reason: a fake decoder
 * in a test, or a caller building their own registry, needs no import of
 * the real proxy (and the `Worker` it would construct).
 */
export interface SolidWorksDecoder {
  transform(bytes: Uint8Array): Promise<DecodedModel>;
}

/**
 * The whole public surface for loading, per SPEC.md section 3: ask an
 * Accessor for bytes, ask the sniffer Engine what the format is, resolve
 * the decoder for that format, run it.
 *
 * `'stl'` is still dispatched eagerly and directly, not through
 * `ModuleRegistry` — a known gap against ARCHITECTURE.md section 4's
 * target shape (every format behind a dynamic import), logged in
 * REVIEW-BACKLOG.md rather than fixed here, to keep this change to the one
 * concern it's actually about.
 */
export class ModelLoadManager {
  private readonly stepDecoders:
    ModuleRegistry<"step", StepDecoder> | undefined;

  constructor(
    private readonly sniffer: FormatSniffEngine = new FormatSniffEngine(),
    private readonly meshDecoder: MeshDecodeEngine = new MeshDecodeEngine(),
    stepDecoders?: StepDecoderConfig,
    // Unlike `stepDecoders`, this has a real default: SolidWorksDecodeEngine
    // needs no wasm asset or other per-instance configuration, so there's
    // nothing a real caller would ever need to supply — only a test
    // overrides this, to inject a fake decoder.
    private readonly solidWorksDecoders: ModuleRegistry<
      "solidworks",
      SolidWorksDecoder
    > = createSolidWorksDecoders(),
  ) {
    this.stepDecoders =
      typeof stepDecoders === "string"
        ? createOcctStepDecoders(stepDecoders)
        : stepDecoders;
  }

  async load(input: ModelInput): Promise<DecodedModel> {
    const source = toModelSource(input);
    const bytes = await source.read();
    const format = this.sniffer.transform(bytes);

    if (format === "stl") {
      return this.meshDecoder.transform(bytes);
    }
    if (format === "step") {
      if (this.stepDecoders === undefined) {
        return createEmptyDecodedModel({
          severity: "error",
          code: "occt-decoder-not-configured",
          message:
            "Recognized this as a step file, but no STEP/IGES decoder is configured on this ModelLoadManager — pass the OCCT wasm asset's URL as the third constructor argument. See ARCHITECTURE.md section 4.",
        });
      }
      // Deliberately not caught here, unlike every other exit from load():
      // a rejected `get("step")` means the decoder chunk failed to import
      // (or the registry's own loader threw), which is this manager's
      // setup failing, not something about the file being decoded — the
      // same distinction OcctDecodeEngine.ts draws between a per-file
      // decode diagnostic and a rejected engine-setup failure.
      const decoder = await this.stepDecoders.get("step");
      return decoder.transform(bytes);
    }
    if (format === "solidworks") {
      // No "not configured" branch, unlike `step` above: `solidWorksDecoders`
      // always has a real default, so this is never unusable for a real
      // caller. Same reasoning as `step`'s comment for why a rejected
      // `get` is left uncaught here.
      const decoder = await this.solidWorksDecoders.get("solidworks");
      return decoder.transform(bytes);
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

/**
 * Builds the real, lazy `'step'` decoder registry: `OcctDecodeEngineProxy`
 * is dynamically imported (and, once resolved, reused) only the first time
 * a STEP file is actually opened, per D10's lazy format registry. Not
 * exported for direct use elsewhere — `ModelLoadManager`'s constructor is
 * the one place this needs building.
 */
function createOcctStepDecoders(
  occtWasmUrl: string,
): ModuleRegistry<"step", StepDecoder> {
  return new ModuleRegistry({
    step: () =>
      import("../engine/OcctDecodeEngineProxy").then(
        (module) => new module.OcctDecodeEngineProxy(occtWasmUrl),
      ),
  });
}

/**
 * Builds the real, lazy `'solidworks'` decoder registry — same D10 lazy
 * format registry as `createOcctStepDecoders`, but with no URL to accept:
 * `SolidWorksDecodeEngineProxy` takes no configuration at all.
 */
function createSolidWorksDecoders(): ModuleRegistry<
  "solidworks",
  SolidWorksDecoder
> {
  return new ModuleRegistry({
    solidworks: () =>
      import("../engine/SolidWorksDecodeEngineProxy").then(
        (module) => new module.SolidWorksDecodeEngineProxy(),
      ),
  });
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
