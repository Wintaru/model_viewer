import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Mesh,
  MeshStandardMaterial,
  SRGBColorSpace,
  type Material,
} from "three";
import type { DecodedMesh, DecodedModel, SceneNode } from "../common";

/** Plain mid-grey. Used whenever a mesh or face carries no CAD colour. */
const DEFAULT_COLOR = 0x9a9a9a;

/**
 * The `/three` entry point (SPEC.md section 7a). A pure, stateless transform
 * from the renderer-agnostic {@link DecodedModel} to a three.js scene graph.
 * Kept out of the package root so a caller doing headless work — thumbnails,
 * measurement, export — never pulls in three.js (D10, SPEC.md section 8).
 */
export function toThree(model: DecodedModel): Group {
  const meshes = model.meshes.map(buildMesh);
  const root = new Group();
  for (const node of model.tree) {
    root.add(buildNode(node, meshes));
  }
  return root;
}

function buildNode(node: SceneNode, meshes: readonly Mesh[]): Group {
  const group = new Group();
  if (node.name !== undefined) {
    group.name = node.name;
  }
  if (node.transform !== undefined) {
    // SceneNode.transform is column-major (DECISIONS.md), which is exactly
    // how three.js stores Matrix4.elements — no transpose needed. Set the
    // matrix directly rather than decomposing into position/quaternion/
    // scale: decompose() silently discards shear by forcing the nearest
    // orthogonal TRS approximation, and nothing guarantees a CAD assembly
    // transform is shear-free. matrixAutoUpdate off tells three.js to
    // render from this matrix as given, rather than recomputing it from
    // position/quaternion/scale (which we never set).
    group.matrix.fromArray(node.transform);
    group.matrixAutoUpdate = false;
  }
  for (const meshIndex of node.meshIndices) {
    const mesh = meshes[meshIndex];
    if (mesh === undefined) {
      throw new RangeError(
        `SceneNode references mesh index ${meshIndex}, but the model has ${meshes.length} mesh(es).`,
      );
    }
    group.add(mesh.clone());
  }
  for (const child of node.children) {
    group.add(buildNode(child, meshes));
  }
  return group;
}

function buildMesh(mesh: DecodedMesh): Mesh {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(mesh.positions, 3));
  geometry.setAttribute("normal", new BufferAttribute(mesh.normals, 3));
  geometry.setIndex(new BufferAttribute(mesh.indices, 1));

  const object = new Mesh(geometry, buildMaterials(mesh, geometry));
  if (mesh.name !== undefined) {
    object.name = mesh.name;
  }
  return object;
}

function buildMaterials(
  mesh: DecodedMesh,
  geometry: BufferGeometry,
): Material | Material[] {
  if (mesh.faces.length === 0) {
    return materialFor(mesh.color);
  }

  // FaceRange carries the original CAD face identity (ARCHITECTURE.md
  // section 7, D3). A three.js geometry group per face preserves it: on a
  // raycast hit, `intersection.face.materialIndex` indexes both the
  // material array below and `faceIds`, recovering the real `FaceRange.id`.
  const faceIds: number[] = [];
  const materials: Material[] = [];
  mesh.faces.forEach((face, materialIndex) => {
    geometry.addGroup(face.start, face.count, materialIndex);
    faceIds.push(face.id);
    materials.push(materialFor(face.color ?? mesh.color));
  });
  geometry.userData.faceIds = faceIds;
  return materials;
}

function materialFor(color: DecodedMesh["color"]): Material {
  if (color === undefined) {
    return new MeshStandardMaterial({ color: DEFAULT_COLOR });
  }
  // DecodedMesh.color/FaceRange.color are sRGB, matching how CAD/STEP
  // presentation colour is authored — not three.js's own working colour
  // space. Color.setRGB's positional (r, g, b) constructor shorthand
  // assumes the *working* space (linear) with no conversion, which
  // silently over-brightens anything but 0 or 1; setRGB's explicit
  // colorSpace argument does the sRGB-to-linear conversion three.js's
  // renderer needs. See DECISIONS.md.
  return new MeshStandardMaterial({
    color: new Color().setRGB(color[0], color[1], color[2], SRGBColorSpace),
  });
}
