import type { DecodedMesh } from "../common/DecodedMesh";
import {
  createEmptyDecodedModel,
  type DecodedModel,
} from "../common/DecodedModel";
import type { Diagnostic } from "../common/Diagnostic";
import { startsWithAsciiCaseInsensitive } from "../utility/AsciiUtil";
import {
  readFixedRecordCount,
  type FixedRecordLayout,
} from "../utility/BinaryLayoutUtil";

const STL_LAYOUT: FixedRecordLayout = { headerSize: 80, recordSize: 50 };
const RECORD_COUNT_FIELD_SIZE = 4;
const VERTICES_PER_TRIANGLE = 3;
const FLOATS_PER_VERTEX = 3;

/**
 * Bytes to a {@link DecodedModel}. Only binary STL is parsed by hand —
 * see ARCHITECTURE.md section 2 and SPEC.md section 10 for why hand-parsing
 * avoids an Engine depending on three.js, and REVIEW-BACKLOG.md for why
 * ASCII STL and every other mesh format (OBJ, PLY, glTF, 3MF) are not yet
 * covered.
 *
 * The layout-consistency check this needs (does the declared triangle
 * count make the total length add up) is shared with `FormatSniffEngine`
 * through `BinaryLayoutUtil` — genuinely domain-free (it only knows "header,
 * then a count, then N fixed-size records"), unlike the STL-specific sizes
 * each caller supplies. See DECISIONS.md.
 */
export class MeshDecodeEngine {
  transform(bytes: Uint8Array): DecodedModel {
    // Binary layout checked first, deliberately the opposite order from
    // FormatSniffEngine: a binary STL's 80-byte header is arbitrary and
    // some exporters put literal "solid ..." text in it, so checking ASCII
    // first here would misclassify a real binary file as unsupported ASCII.
    const triangleCount = readFixedRecordCount(bytes, STL_LAYOUT);
    if (triangleCount !== undefined) {
      return decodeBinaryStl(bytes, triangleCount);
    }
    if (startsWithAsciiCaseInsensitive(bytes, "solid")) {
      return createEmptyDecodedModel({
        severity: "error",
        code: "ascii-stl-unsupported",
        message:
          "This looks like ASCII STL, which is not yet supported — only binary STL decodes in this version.",
      });
    }
    return createEmptyDecodedModel({
      severity: "error",
      code: "invalid-stl",
      message: "Bytes do not match a supported STL layout.",
    });
  }
}

function decodeBinaryStl(
  bytes: Uint8Array,
  triangleCount: number,
): DecodedModel {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vertexCount = triangleCount * VERTICES_PER_TRIANGLE;
  const positions = new Float32Array(vertexCount * FLOATS_PER_VERTEX);
  const normals = new Float32Array(vertexCount * FLOATS_PER_VERTEX);
  const indices = new Uint32Array(vertexCount);

  let offset = STL_LAYOUT.headerSize + RECORD_COUNT_FIELD_SIZE;
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const nx = view.getFloat32(offset, true);
    const ny = view.getFloat32(offset + 4, true);
    const nz = view.getFloat32(offset + 8, true);
    offset += 12;

    for (let corner = 0; corner < VERTICES_PER_TRIANGLE; corner++) {
      const vertexIndex = triangle * VERTICES_PER_TRIANGLE + corner;
      const base = vertexIndex * FLOATS_PER_VERTEX;
      positions[base] = view.getFloat32(offset, true);
      positions[base + 1] = view.getFloat32(offset + 4, true);
      positions[base + 2] = view.getFloat32(offset + 8, true);
      normals[base] = nx;
      normals[base + 1] = ny;
      normals[base + 2] = nz;
      indices[vertexIndex] = vertexIndex;
      offset += 12;
    }

    offset += 2; // attribute byte count — unused
  }

  const mesh: DecodedMesh = {
    positions,
    normals,
    indices,
    // Binary STL is a flat list of independent triangles with no CAD face
    // structure at all, unlike OCCT's brep_faces or SolidWorks's strips
    // (SPEC.md section 6) — reporting a fabricated single "face" covering
    // the whole mesh would claim an identity that isn't there.
    faces: [],
  };

  return {
    units: "mm",
    meshes: [mesh],
    tree: [{ meshIndices: [0], children: [] }],
    metadata: {},
    diagnostics: [unitsAssumedDiagnostic()],
  };
}

function unitsAssumedDiagnostic(): Diagnostic {
  return {
    severity: "warning",
    code: "units-assumed-mm",
    message:
      "STL carries no unit information. Values are reported as millimetres by assumption, not measurement.",
  };
}
