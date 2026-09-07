import {
  createEmptyDecodedModel,
  type DecodedModel,
} from "../common/DecodedModel.js";
import type { Diagnostic } from "../common/Diagnostic.js";
import { tessellateArc } from "../utility/ArcTessellationUtil.js";

/** One `code`/`value` pair from ASCII DXF's flat group-code stream. */
interface DxfToken {
  readonly code: number;
  readonly value: string;
}

/**
 * One `ENTITIES`-section entity, with every field it carried grouped by
 * group code in encounter order. A code can repeat (`LWPOLYLINE`'s `10`/`20`
 * once per vertex), so each code maps to a list, not a single value.
 */
interface DxfEntityTokens {
  readonly type: string;
  readonly fields: ReadonlyMap<number, string[]>;
}

interface DecodedEntityGeometry {
  /** Flat x,y pairs, already scaled to millimetres. */
  readonly points: Float32Array;
  readonly closed: boolean;
  readonly hadIgnoredBulge: boolean;
}

interface LayerAccumulator {
  positions: number[];
  indices: number[];
}

const SECTION_MARKER = "SECTION";
const SECTION_END_MARKER = "ENDSEC";
const HEADER_SECTION = "HEADER";
const ENTITIES_SECTION = "ENTITIES";
const INSUNITS_VARIABLE = "$INSUNITS";
const LAYER_CODE = 8;
const DEFAULT_LAYER_NAME = "0";
const LWPOLYLINE_CLOSED_FLAG_BIT = 1;

/**
 * Segments for a full 360° circle; an `ARC`'s segment count scales down
 * from this by its actual sweep (see `decodeArc`). No real DXF file exists
 * anywhere in this repository or the NIST corpus to measure an ideal value
 * against (SPEC.md section 10, slice 6), so this is a plausible fixed
 * constant, not a measured one — cheap to change later.
 */
const CIRCLE_SEGMENTS = 64;
const DEGREES_PER_CIRCLE = 360;

/**
 * `$INSUNITS` values this decoder converts to millimetres, DXF's own
 * enumeration (1 = inches, 4 = millimetres). Every other value — a real
 * unit this decoder doesn't yet handle, or the header variable missing
 * entirely — falls back to "assumed millimetres" with a diagnostic, the
 * same posture `MeshDecodeEngine`'s `units-assumed-mm` already established
 * for binary STL. Extend this table if a real drawing needs another unit;
 * nothing about the decoder's structure changes to add one.
 */
const UNIT_SCALE_TO_MM: Readonly<Record<number, number>> = {
  1: 25.4,
  4: 1,
};

/**
 * ASCII DXF bytes to a {@link DecodedModel}. Handles `LINE`, `CIRCLE`,
 * `ARC` and `LWPOLYLINE` (straight segments only — see below) — the common
 * line-drawing primitives, matching the "smallest useful, defer the rest"
 * discipline every prior slice used. One {@link DecodedMesh} per DXF layer
 * (group code 8), `topology: 'lines'`, named after the layer — see D6's
 * refinement in WAYFINDER.md for why layer visibility needs no dedicated
 * field beyond `name`.
 *
 * **Deliberately out of scope, tracked rather than guessed at:**
 * - `LWPOLYLINE` bulge (a curved segment) is decoded as straight and
 *   flagged — needs a real sample file to verify a conversion against.
 *   https://github.com/Wintaru/model_viewer/issues/3
 * - `INSERT` block references, and everything inside `BLOCKS`/`TABLES`, are
 *   not expanded — counted as a skipped entity type like `TEXT`/`DIMENSION`.
 *   https://github.com/Wintaru/model_viewer/issues/4
 *
 * Never fails silently: a file with no `ENTITIES` section, or one whose
 * entities are all unsupported or malformed, still returns a valid
 * `DecodedModel` carrying a diagnostic that says so — the same posture
 * `OcctDecodeEngine`'s `diagnostics` field exists to enforce project-wide.
 */
export class DxfDecodeEngine {
  transform(bytes: Uint8Array): DecodedModel {
    const { tokens, malformedLineCount } = tokenize(
      new TextDecoder().decode(bytes),
    );
    const entities = extractEntities(tokens);
    if (entities === undefined) {
      return createEmptyDecodedModel({
        severity: "error",
        code: "invalid-dxf",
        message:
          "No ENTITIES section found — this does not look like a valid DXF file.",
      });
    }

    const scale = resolveUnitScale(tokens);
    const layers = new Map<string, LayerAccumulator>();
    const skippedByType = new Map<string, number>();
    const malformedByType = new Map<string, number>();
    let ignoredBulgeCount = 0;

    for (const entity of entities) {
      const geometry = decodeEntityGeometry(entity, scale.factor);
      if (geometry === undefined) {
        const counts = isSupportedEntityType(entity.type)
          ? malformedByType
          : skippedByType;
        counts.set(entity.type, (counts.get(entity.type) ?? 0) + 1);
        continue;
      }
      const layerName =
        firstValue(entity.fields, LAYER_CODE) ?? DEFAULT_LAYER_NAME;
      addPolyline(
        getLayer(layers, layerName),
        geometry.points,
        geometry.closed,
      );
      if (geometry.hadIgnoredBulge) {
        ignoredBulgeCount++;
      }
    }

    const diagnostics: Diagnostic[] = [];
    if (malformedLineCount > 0) {
      diagnostics.push(malformedLinesDiagnostic(malformedLineCount));
    }
    if (!scale.known) {
      diagnostics.push(unitsAssumedDiagnostic(scale.rawInsunits));
    }
    if (skippedByType.size > 0) {
      diagnostics.push(
        entityCountDiagnostic(
          "unsupported-entities-skipped",
          "entities of unsupported types were skipped",
          skippedByType,
        ),
      );
    }
    if (malformedByType.size > 0) {
      diagnostics.push(
        entityCountDiagnostic(
          "malformed-entities-skipped",
          "entities of a supported type were missing required fields and were skipped",
          malformedByType,
        ),
      );
    }
    if (ignoredBulgeCount > 0) {
      diagnostics.push(ignoredBulgeDiagnostic(ignoredBulgeCount));
    }
    if (layers.size === 0) {
      diagnostics.unshift({
        severity: "error",
        code: "no-supported-entities",
        message:
          "No LINE, CIRCLE, ARC or LWPOLYLINE entities were found to decode.",
      });
    }

    const meshes = [...layers.entries()].map(([name, accumulator]) =>
      buildMesh(name, accumulator),
    );
    return {
      units: "mm",
      meshes,
      tree: [{ meshIndices: meshes.map((_, index) => index), children: [] }],
      metadata: {},
      diagnostics,
    };
  }
}

interface TokenizeResult {
  readonly tokens: DxfToken[];
  /**
   * Lines that landed in a code-line position but didn't parse as one.
   * Group codes and values always alternate one-per-line, so once this
   * happens every later pairing in the file is shifted by one line —
   * a stray blank or malformed line desynchronizes everything after it,
   * not just the one pair it's part of. Reported so a caller sees that the
   * file may be corrupted rather than silently decoding a desynchronized
   * stream as if it were valid.
   */
  readonly malformedLineCount: number;
}

function tokenize(text: string): TokenizeResult {
  const lines = text.split(/\r\n|\r|\n/);
  const tokens: DxfToken[] = [];
  let malformedLineCount = 0;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const codeText = lines[i]?.trim();
    const value = lines[i + 1]?.trim();
    if (codeText === undefined || codeText === "" || value === undefined) {
      continue;
    }
    const code = Number.parseInt(codeText, 10);
    if (Number.isNaN(code)) {
      malformedLineCount++;
      continue;
    }
    tokens.push({ code, value });
  }
  return { tokens, malformedLineCount };
}

/** The token index right after a `0 SECTION` / `2 <name>` pair, or undefined. */
function findSectionStart(
  tokens: readonly DxfToken[],
  name: string,
): number | undefined {
  for (let i = 0; i + 1 < tokens.length; i++) {
    const marker = tokens[i];
    const sectionName = tokens[i + 1];
    if (
      marker?.code === 0 &&
      marker.value === SECTION_MARKER &&
      sectionName?.code === 2 &&
      sectionName.value === name
    ) {
      return i + 2;
    }
  }
  return undefined;
}

function extractEntities(
  tokens: readonly DxfToken[],
): DxfEntityTokens[] | undefined {
  const start = findSectionStart(tokens, ENTITIES_SECTION);
  if (start === undefined) {
    return undefined;
  }
  const entities: DxfEntityTokens[] = [];
  let current: { type: string; fields: Map<number, string[]> } | undefined;
  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) {
      break;
    }
    if (token.code === 0) {
      if (current !== undefined) {
        entities.push(current);
      }
      if (token.value === SECTION_END_MARKER) {
        break;
      }
      current = { type: token.value, fields: new Map() };
      continue;
    }
    if (current === undefined) {
      continue;
    }
    const values = current.fields.get(token.code);
    if (values === undefined) {
      current.fields.set(token.code, [token.value]);
    } else {
      values.push(token.value);
    }
  }
  return entities;
}

interface UnitScale {
  readonly factor: number;
  readonly known: boolean;
  readonly rawInsunits: number | undefined;
}

function resolveUnitScale(tokens: readonly DxfToken[]): UnitScale {
  const rawInsunits = findInsunits(tokens);
  const factor =
    rawInsunits === undefined ? undefined : UNIT_SCALE_TO_MM[rawInsunits];
  return {
    factor: factor ?? 1,
    known: factor !== undefined,
    rawInsunits,
  };
}

function findInsunits(tokens: readonly DxfToken[]): number | undefined {
  const start = findSectionStart(tokens, HEADER_SECTION);
  if (start === undefined) {
    return undefined;
  }
  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) {
      break;
    }
    if (token.code === 0 && token.value === SECTION_END_MARKER) {
      break;
    }
    if (token.code === 9 && token.value === INSUNITS_VARIABLE) {
      const valueToken = tokens[i + 1];
      if (valueToken?.code === 70) {
        const parsed = Number.parseInt(valueToken.value, 10);
        return Number.isNaN(parsed) ? undefined : parsed;
      }
    }
  }
  return undefined;
}

function isSupportedEntityType(type: string): boolean {
  return (
    type === "LINE" ||
    type === "CIRCLE" ||
    type === "ARC" ||
    type === "LWPOLYLINE"
  );
}

function decodeEntityGeometry(
  entity: DxfEntityTokens,
  scale: number,
): DecodedEntityGeometry | undefined {
  switch (entity.type) {
    case "LINE":
      return decodeLine(entity, scale);
    case "CIRCLE":
      return decodeCircle(entity, scale);
    case "ARC":
      return decodeArc(entity, scale);
    case "LWPOLYLINE":
      return decodeLwPolyline(entity, scale);
    default:
      return undefined;
  }
}

function decodeLine(
  entity: DxfEntityTokens,
  scale: number,
): DecodedEntityGeometry | undefined {
  const x1 = firstNumber(entity.fields, 10);
  const y1 = firstNumber(entity.fields, 20);
  const x2 = firstNumber(entity.fields, 11);
  const y2 = firstNumber(entity.fields, 21);
  if (
    x1 === undefined ||
    y1 === undefined ||
    x2 === undefined ||
    y2 === undefined
  ) {
    return undefined;
  }
  return {
    points: new Float32Array([x1 * scale, y1 * scale, x2 * scale, y2 * scale]),
    closed: false,
    hadIgnoredBulge: false,
  };
}

function decodeCircle(
  entity: DxfEntityTokens,
  scale: number,
): DecodedEntityGeometry | undefined {
  const centerX = firstNumber(entity.fields, 10);
  const centerY = firstNumber(entity.fields, 20);
  const radius = firstNumber(entity.fields, 40);
  if (centerX === undefined || centerY === undefined || radius === undefined) {
    return undefined;
  }
  const points = tessellateArc(
    centerX * scale,
    centerY * scale,
    radius * scale,
    0,
    2 * Math.PI,
    CIRCLE_SEGMENTS,
  );
  return { points, closed: false, hadIgnoredBulge: false };
}

function decodeArc(
  entity: DxfEntityTokens,
  scale: number,
): DecodedEntityGeometry | undefined {
  const centerX = firstNumber(entity.fields, 10);
  const centerY = firstNumber(entity.fields, 20);
  const radius = firstNumber(entity.fields, 40);
  const startDeg = firstNumber(entity.fields, 50);
  const endDeg = firstNumber(entity.fields, 51);
  if (
    centerX === undefined ||
    centerY === undefined ||
    radius === undefined ||
    startDeg === undefined ||
    endDeg === undefined
  ) {
    return undefined;
  }
  // DXF arcs always sweep counterclockwise from start to end. When end
  // isn't strictly greater than start, the arc crosses 0deg/360deg (or, in
  // the exact-equality case, is a full circle) — add a full turn so the
  // sweep tessellateArc walks is always positive, per its own documented
  // contract (it does not normalize this itself).
  const sweepDeg =
    endDeg <= startDeg
      ? endDeg + DEGREES_PER_CIRCLE - startDeg
      : endDeg - startDeg;
  const segments = Math.max(
    1,
    Math.round((CIRCLE_SEGMENTS * sweepDeg) / DEGREES_PER_CIRCLE),
  );
  const startRad = (startDeg * Math.PI) / 180;
  const endRad = startRad + (sweepDeg * Math.PI) / 180;
  const points = tessellateArc(
    centerX * scale,
    centerY * scale,
    radius * scale,
    startRad,
    endRad,
    segments,
  );
  return { points, closed: false, hadIgnoredBulge: false };
}

function decodeLwPolyline(
  entity: DxfEntityTokens,
  scale: number,
): DecodedEntityGeometry | undefined {
  const xs = entity.fields.get(10);
  const ys = entity.fields.get(20);
  if (
    xs === undefined ||
    ys === undefined ||
    xs.length < 2 ||
    xs.length !== ys.length
  ) {
    return undefined;
  }
  const points = new Float32Array(xs.length * 2);
  for (let i = 0; i < xs.length; i++) {
    const x = Number.parseFloat(xs[i] ?? "");
    const y = Number.parseFloat(ys[i] ?? "");
    if (Number.isNaN(x) || Number.isNaN(y)) {
      return undefined;
    }
    points[i * 2] = x * scale;
    points[i * 2 + 1] = y * scale;
  }
  const flags = firstNumber(entity.fields, 70);
  const closed =
    flags !== undefined && (flags & LWPOLYLINE_CLOSED_FLAG_BIT) !== 0;
  // Bulge (group code 42) turns the segment following a vertex into an
  // arc — issue #4 (WAYFINDER.md D6 follow-up). Every vertex is decoded as
  // a straight segment regardless; this only detects whether any bulge was
  // present, to report it rather than silently drop it.
  const bulges = entity.fields.get(42) ?? [];
  const hadIgnoredBulge = bulges.some(
    (value) => Number.parseFloat(value) !== 0,
  );
  return { points, closed, hadIgnoredBulge };
}

function firstValue(
  fields: ReadonlyMap<number, string[]>,
  code: number,
): string | undefined {
  return fields.get(code)?.[0];
}

function firstNumber(
  fields: ReadonlyMap<number, string[]>,
  code: number,
): number | undefined {
  const value = firstValue(fields, code);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseFloat(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function getLayer(
  layers: Map<string, LayerAccumulator>,
  name: string,
): LayerAccumulator {
  let layer = layers.get(name);
  if (layer === undefined) {
    layer = { positions: [], indices: [] };
    layers.set(name, layer);
  }
  return layer;
}

/** Appends an open (or, if `closed`, self-closing) polyline's line segments
 * to `layer`, in the same flat positions/indices shape every LINE, CIRCLE,
 * ARC and LWPOLYLINE ultimately reduces to. */
function addPolyline(
  layer: LayerAccumulator,
  points: Float32Array,
  closed: boolean,
): void {
  const base = layer.positions.length / 3;
  const vertexCount = points.length / 2;
  for (let i = 0; i < vertexCount; i++) {
    layer.positions.push(points[i * 2] ?? 0, points[i * 2 + 1] ?? 0, 0);
  }
  for (let i = 0; i < vertexCount - 1; i++) {
    layer.indices.push(base + i, base + i + 1);
  }
  if (closed && vertexCount > 2) {
    layer.indices.push(base + vertexCount - 1, base);
  }
}

function buildMesh(name: string, accumulator: LayerAccumulator) {
  const positions = new Float32Array(accumulator.positions);
  return {
    positions,
    // A line has no meaningful normal — zero-filled to keep the field
    // required and uniform rather than making every consumer handle an
    // optional one. See DecodedMesh's doc comment.
    normals: new Float32Array(positions.length),
    indices: new Uint32Array(accumulator.indices),
    faces: [],
    name,
    topology: "lines" as const,
  };
}

function unitsAssumedDiagnostic(rawInsunits: number | undefined): Diagnostic {
  return {
    severity: "warning",
    code: "units-assumed-mm",
    message:
      rawInsunits === undefined
        ? "DXF file carries no $INSUNITS header variable. Values are reported as millimetres by assumption, not measurement."
        : `DXF $INSUNITS value ${rawInsunits} is not one this decoder converts (only inches and millimetres are). Values are reported as millimetres by assumption, not measurement.`,
  };
}

/** Shared shape for both `skippedByType` and `malformedByType` — same
 * "N entities: TYPE(count), TYPE(count)" wording either way. */
function entityCountDiagnostic(
  code: string,
  reason: string,
  countsByType: ReadonlyMap<string, number>,
): Diagnostic {
  const total = [...countsByType.values()].reduce((sum, n) => sum + n, 0);
  const breakdown = [...countsByType.entries()]
    .map(([type, count]) => `${type}(${count})`)
    .join(", ");
  return {
    severity: "warning",
    code,
    message: `${total} ${reason}: ${breakdown}.`,
  };
}

function malformedLinesDiagnostic(count: number): Diagnostic {
  return {
    severity: "warning",
    code: "malformed-group-code-lines",
    message: `${count} line(s) in the file did not look like a valid DXF group code and were skipped. Group codes and values always alternate one per line, so this may mean the rest of the file was read out of alignment — treat the result with caution.`,
  };
}

function ignoredBulgeDiagnostic(count: number): Diagnostic {
  return {
    severity: "warning",
    code: "lwpolyline-bulge-ignored",
    message: `${count} LWPOLYLINE segment(s) with a nonzero bulge were decoded as straight lines (https://github.com/Wintaru/model_viewer/issues/3).`,
  };
}
