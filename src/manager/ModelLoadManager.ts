import { fromBuffer } from "../accessor/BufferSourceAccessor";
import { fromFile } from "../accessor/FileSourceAccessor";
import type { ModelCacheAccessor } from "../accessor/ModelCacheAccessor";
import type { ModelSource } from "../accessor/ModelSource";
import { fromUrl } from "../accessor/UrlSourceAccessor";
import {
  createEmptyDecodedModel,
  type DecodedModel,
} from "../common/DecodedModel";
import type { FormatId } from "../common/FormatId";
import { FormatSniffEngine } from "../engine/FormatSniffEngine";
import { MeshDecodeEngine } from "../engine/MeshDecodeEngine";
import { sha256Hex } from "../utility/HashUtil";
import { ModuleRegistry } from "../utility/ModuleRegistry";

/**
 * The three formats that actually reach a decoder — `'dxf'` sniffs
 * successfully (since slice 1 commit 9) but has no decoder yet, so it can
 * never reach {@link ModelLoadManager.decodeWithCache}.
 */
type CacheableFormatId = "step" | "solidworks" | "stl";

/**
 * A decoder-version component for the cache key (ARCHITECTURE.md section
 * 6a: `cacheKey = hash(file bytes) + decoderName + decoderVersion +
 * optionsHash`). Hand-maintained, not derived from each decoder: the
 * reason a version belongs in the key at all is that a decode-logic fix
 * must invalidate every previously cached result even though nothing
 * about the *file* changed — ARCHITECTURE.md's own example is the
 * SolidWorks decoder going from 3-of-11 to 6-of-11 correct NIST parts in a
 * single change. Only a human bumping this constant when that kind of
 * change lands can guarantee that; nothing about a decoder's own code
 * changes size or shape in a way worth hashing automatically. Bump the
 * relevant entry whenever a decoding Engine's *output* changes for the
 * same input bytes.
 */
const DECODER_VERSIONS: Record<CacheableFormatId, string> = {
  step: "1",
  solidworks: "1",
  stl: "1",
};

/**
 * Matches SPEC.md section 7's full `ModelInput`. `string | URL` route
 * through `fromUrl`, added in this same slice — see `toModelSource` below.
 *
 * Declared here, not its own file: it has exactly one consumer
 * (`ModelLoadManager`) and no external implementer, so a separate file
 * would only create a forbidden Manager-to-Manager self-reference to fix —
 * the same reasoning that colocates `fromBuffer` with its class. See
 * DECISIONS.md.
 */
export type ModelInput =
  ModelSource | File | Blob | ArrayBuffer | Uint8Array | string | URL;

/**
 * How many bytes of a `readRange`-capable source to sniff before the full
 * download finishes — ARCHITECTURE.md section 3's sequence diagram
 * (`readRange(0, 4096)`), which was already checked against every
 * `FormatSniffEngine` signature (all within the first few dozen bytes) when
 * it was drawn.
 */
const SNIFF_PREFIX_BYTES = 4096;

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
 *
 * When a `ModelCacheAccessor` is supplied, a decode result is cached under
 * a key derived from the file's content hash, the format, and a
 * hand-maintained decoder version — see {@link decodeWithCache}.
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
    // No real default, same as ModelSource itself: the library has no
    // idea what storage a host has, so caching is opt-in per instance
    // rather than on by default with nowhere real to write to.
    private readonly cache?: ModelCacheAccessor,
  ) {
    this.stepDecoders =
      typeof stepDecoders === "string"
        ? createOcctStepDecoders(stepDecoders)
        : stepDecoders;
  }

  async load(input: ModelInput): Promise<DecodedModel> {
    const source = toModelSource(input);

    if (source.readRange === undefined) {
      const bytes = await source.read();
      return this.decode(this.sniffer.transform(bytes), Promise.resolve(bytes));
    }

    // Sniffing a small prefix here means the format — and so which lazy
    // decoder chunk `decode` below needs — is known before the full
    // download finishes, so the two can run concurrently instead of back
    // to back (ARCHITECTURE.md section 3). `decode` starts that decoder's
    // resolution immediately, ahead of the `source.read()` it awaits here.
    const prefix = await source.readRange(0, SNIFF_PREFIX_BYTES);
    const sniffedFromPrefix = this.sniffer.transform(prefix);
    if (sniffedFromPrefix !== undefined) {
      return this.decode(sniffedFromPrefix, source.read());
    }
    // A short prefix can't identify every format — a binary STL's only
    // signature is a triangle count at offset 80 that must make the total
    // file length add up (FormatSniffEngine.ts), so a binary STL bigger
    // than the prefix sniffs as `undefined` here even though the whole
    // file would sniff fine. Falling back to a full read-then-sniff, same
    // as a source with no `readRange` at all, keeps this path from
    // rejecting a file this library actually supports (REVIEW-BACKLOG.md).
    const bytes = await source.read();
    return this.decode(this.sniffer.transform(bytes), Promise.resolve(bytes));
  }

  private async decode(
    format: FormatId | undefined,
    bytesPromise: Promise<Uint8Array>,
  ): Promise<DecodedModel> {
    if (format === "step") {
      // Started immediately, before `bytesPromise` below is awaited, so it
      // runs alongside the rest of the download rather than only starting
      // once that download has already finished — the whole point of the
      // sniff-first path in `load` above. Harmless when `bytesPromise` is
      // already resolved (the no-`readRange` path): the import just starts
      // a microtask later than it possibly could have.
      const decoderPromise = this.stepDecoders?.get("step");
      // A rejected `decoderPromise` sits unhandled for as long as
      // `bytesPromise` below is still in flight — a real gap on a slow
      // download racing a failed chunk fetch, not a hypothetical: Node
      // treats an unhandled rejection as fatal by default. This extra
      // `.catch` only marks it handled; the `await decoderPromise` further
      // down still sees and propagates the real rejection.
      markSettled(decoderPromise);
      const bytes = await bytesPromise;
      if (decoderPromise === undefined) {
        return createEmptyDecodedModel({
          severity: "error",
          code: "occt-decoder-not-configured",
          message:
            "Recognized this as a step file, but no STEP/IGES decoder is configured on this ModelLoadManager — pass the OCCT wasm asset's URL as the third constructor argument. See ARCHITECTURE.md section 4.",
        });
      }
      // Deliberately not caught here, unlike every other exit from decode():
      // a rejected `get("step")` means the decoder chunk failed to import
      // (or the registry's own loader threw), which is this manager's
      // setup failing, not something about the file being decoded — the
      // same distinction OcctDecodeEngine.ts draws between a per-file
      // decode diagnostic and a rejected engine-setup failure.
      const decoder = await decoderPromise;
      return this.decodeWithCache("step", bytes, () =>
        decoder.transform(bytes),
      );
    }
    if (format === "solidworks") {
      // No "not configured" branch, unlike `step` above: `solidWorksDecoders`
      // always has a real default, so this is never unusable for a real
      // caller. Same reasoning as `step`'s comment for why a rejected
      // `get` is left uncaught here.
      const decoderPromise = this.solidWorksDecoders.get("solidworks");
      // Same unhandled-rejection gap as the `step` branch above, and the
      // same fix.
      markSettled(decoderPromise);
      const bytes = await bytesPromise;
      const decoder = await decoderPromise;
      return this.decodeWithCache("solidworks", bytes, () =>
        decoder.transform(bytes),
      );
    }
    if (format === "stl") {
      const bytes = await bytesPromise;
      return this.decodeWithCache("stl", bytes, () =>
        this.meshDecoder.transform(bytes),
      );
    }
    if (format === undefined) {
      await bytesPromise;
      return createEmptyDecodedModel({
        severity: "error",
        code: "unrecognized-format",
        message: "Could not identify the file format from its bytes.",
      });
    }
    await bytesPromise;
    return createEmptyDecodedModel({
      severity: "error",
      code: "unsupported-format",
      message: `Recognized this as a ${format} file, but no decoder for it exists in this version.`,
    });
  }

  /**
   * The check-cache, decode-on-a-miss, store-the-result policy
   * ARCHITECTURE.md section 6a assigns to this Manager — the
   * `ModelCacheAccessor` Accessor only moves a `DecodedModel` in and out
   * of whatever storage the host chose.
   *
   * No etag pre-download fast path (ARCHITECTURE.md section 6a's "One
   * wrinkle"): none of the four built-in sources set `etag` yet, so the
   * cache key can only be computed from a content hash of bytes already
   * in hand. That still skips the expensive part on a repeat load — the
   * decode itself — even though the download already happened.
   */
  private async decodeWithCache(
    format: CacheableFormatId,
    bytes: Uint8Array,
    // MeshDecodeEngine.transform() is synchronous (unlike the step/
    // solidworks proxies' transform(), which cross a Worker); `| Promise`
    // lets one helper serve both without forcing the synchronous one to
    // wrap itself for no reason.
    decode: () => DecodedModel | Promise<DecodedModel>,
  ): Promise<DecodedModel> {
    if (this.cache === undefined) {
      return decode();
    }
    const key = `${await sha256Hex(bytes)}:${format}:${DECODER_VERSIONS[format]}`;
    const cached = await this.cache.load(key);
    if (cached !== undefined) {
      return cached;
    }
    const model = await decode();
    // Not awaited: ModelCacheAccessor.store's own doc comment says a
    // failed store must not fail the load that produced `model`, and the
    // caller has no reason to wait on a cache write either — the `.catch`
    // below (attached synchronously, before this function returns) is only
    // there to keep a rejection from being reported as unhandled, the same
    // shape `markSettled` already uses for the decoder-import promises.
    this.cache.store(key, model).catch(() => {
      // Intentionally empty: see comment above.
    });
    return model;
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

/**
 * Attaches a no-op rejection handler to `promise`, without consuming its
 * settled value — so a later, real `await` of the same promise still sees
 * and propagates a rejection normally. Exists only to prevent an unhandled
 * rejection from being reported (fatally, in Node) while some *other*
 * promise is awaited first — see `decode`'s two call sites.
 */
function markSettled(promise: Promise<unknown> | undefined): void {
  promise?.catch(() => {
    // Intentionally empty: see doc comment above.
  });
}

function toModelSource(input: ModelInput): ModelSource {
  if (input instanceof ArrayBuffer || input instanceof Uint8Array) {
    return fromBuffer(input);
  }
  if (input instanceof Blob) {
    return fromFile(input);
  }
  if (typeof input === "string" || input instanceof URL) {
    return fromUrl(input);
  }
  return input;
}
