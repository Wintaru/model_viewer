#!/usr/bin/env python3
"""Build a single self-contained HTML viewer around extracted geometry.

The JSON is inlined rather than fetched, because a page opened from file://
cannot fetch a sibling file. One file, double-click, done.

Usage: build-demo.py <mesh.json> <out.html>
"""
import json
import pathlib
import sys

mesh = json.loads(pathlib.Path(sys.argv[1]).read_text())
out = pathlib.Path(sys.argv[2])

HTML = """<title>SLDPRT Viewer (proof of concept)</title>
<style>
  :root {
    --bg: #f6f6f4; --panel: #ffffff; --ink: #16181d; --muted: #5c6270;
    --line: #d9dbe0; --accent: #2f6fed;
  }
  :root:not([data-theme="light"]) { }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #14161a; --panel: #1c1f25; --ink: #e8eaed; --muted: #9aa1ad;
      --line: #2c3038; --accent: #6ea0ff;
    }
  }
  :root[data-theme="dark"] {
    --bg: #14161a; --panel: #1c1f25; --ink: #e8eaed; --muted: #9aa1ad;
    --line: #2c3038; --accent: #6ea0ff;
  }
  * { box-sizing: border-box; }
  body { background: var(--bg); color: var(--ink);
         font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  header { padding: 14px 18px; border-bottom: 1px solid var(--line);
           background: var(--panel); }
  h1 { margin: 0 0 2px; font-size: 15px; letter-spacing: -0.01em; }
  .sub { color: var(--muted); font-size: 12.5px; }
  .wrap { display: grid; grid-template-columns: 1fr 260px; gap: 0;
          height: calc(100vh - 62px); }
  @media (max-width: 720px) {
    .wrap { grid-template-columns: 1fr; height: auto; }
    #view { height: 62vh; }
  }
  #view { position: relative; background:
          radial-gradient(circle at 50% 40%, rgba(127,127,127,.10), transparent 70%); }
  canvas { display: block; width: 100%; height: 100%; }
  aside { border-left: 1px solid var(--line); background: var(--panel);
          padding: 16px; overflow: auto; }
  .k { color: var(--muted); font-size: 11.5px; text-transform: uppercase;
       letter-spacing: .06em; margin: 14px 0 4px; }
  .v { font: 12.5px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
       word-break: break-word; }
  button { font: inherit; padding: 6px 10px; border: 1px solid var(--line);
           background: var(--bg); color: var(--ink); border-radius: 7px;
           cursor: pointer; margin: 0 6px 6px 0; }
  button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
  .hint { position: absolute; left: 12px; bottom: 10px; color: var(--muted);
          font-size: 11.5px; }
  .warn { margin-top: 16px; padding: 9px 11px; border-radius: 8px;
          border: 1px solid var(--line); color: var(--muted); font-size: 12px; }
</style>

<header>
  <h1>SLDPRT &rarr; browser, with no SolidWorks and no Parasolid</h1>
  <div class="sub">Geometry read from the tessellation cache inside the native file.</div>
</header>

<div class="wrap">
  <div id="view"><div class="hint">drag to orbit &middot; scroll to zoom</div></div>
  <aside>
    <div class="k">Source file</div>
    <div class="v" id="src"></div>
    <div class="k">Vertices / triangles</div><div class="v" id="nv"></div>
    <div class="k">Bounding box</div><div class="v" id="bb"></div>
    <div class="k">Display</div>
    <button id="bSolid" aria-pressed="true">Solid</button>
    <button id="bWire" aria-pressed="false">Wireframe</button>
    <button id="bPts" aria-pressed="false">Points</button>
    <div class="warn">Read directly from the tessellation cache inside the
      SLDPRT. Faces are stored as triangle strips and are rebuilt here.</div>
  </aside>
</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
<script>
const MESH = __MESH__;

document.getElementById('src').textContent = MESH.source;
document.getElementById('nv').textContent =
  MESH.vertexCount.toLocaleString() + ' / ' +
  (MESH.triangleCount || 0).toLocaleString();
document.getElementById('bb').textContent =
  MESH.bboxMm.map(v => v.toFixed(2)).join(' x ') + ' mm';

const host = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({antialias: true, alpha: true});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
host.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);

const geom = new THREE.BufferGeometry();
geom.setAttribute('position',
  new THREE.Float32BufferAttribute(MESH.vertices, 3));
if (MESH.indices && MESH.indices.length) {
  geom.setIndex(MESH.indices);
}
if (MESH.normals && MESH.normals.length === MESH.vertices.length) {
  geom.setAttribute('normal',
    new THREE.Float32BufferAttribute(MESH.normals, 3));
} else {
  geom.computeVertexNormals();
}
geom.computeBoundingSphere();

const solid = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({
  color: 0x9aa3b2, metalness: 0.25, roughness: 0.55,
  side: THREE.DoubleSide, flatShading: true}));
const wire = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({
  color: 0x2f6fed, wireframe: true}));
const pts = new THREE.Points(geom, new THREE.PointsMaterial({
  color: 0x2f6fed, size: 0.9}));
wire.visible = false; pts.visible = false;
scene.add(solid, wire, pts);

scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const key = new THREE.DirectionalLight(0xffffff, 0.85);
key.position.set(1, 1.4, 1); scene.add(key);
const fill = new THREE.DirectionalLight(0xffffff, 0.35);
fill.position.set(-1, -0.6, -0.8); scene.add(fill);

const R = geom.boundingSphere ? geom.boundingSphere.radius : 50;
const Q = new URLSearchParams(location.search);
let yaw = parseFloat(Q.get('yaw') ?? '0.7');
let pitch = parseFloat(Q.get('pitch') ?? '0.5');
let dist = R * parseFloat(Q.get('zoom') ?? '3.2');
function place() {
  camera.position.set(
    dist * Math.cos(pitch) * Math.sin(yaw),
    dist * Math.sin(pitch),
    dist * Math.cos(pitch) * Math.cos(yaw));
  camera.lookAt(0, 0, 0);
}
// Hand-rolled orbit: OrbitControls ships as a separate file and this is
// three lines of pointer maths.
let drag = null;
renderer.domElement.addEventListener('pointerdown', e => {
  drag = {x: e.clientX, y: e.clientY};
  renderer.domElement.setPointerCapture(e.pointerId);
});
addEventListener('pointerup', () => { drag = null; });
addEventListener('pointermove', e => {
  if (!drag) return;
  yaw -= (e.clientX - drag.x) * 0.01;
  pitch = Math.max(-1.5, Math.min(1.5, pitch + (e.clientY - drag.y) * 0.01));
  drag = {x: e.clientX, y: e.clientY};
  place();
});
renderer.domElement.addEventListener('wheel', e => {
  e.preventDefault();
  dist = Math.max(R * 0.4, Math.min(R * 12, dist * (1 + Math.sign(e.deltaY) * 0.1)));
  place();
}, {passive: false});

function fit() {
  const w = host.clientWidth, h = host.clientHeight || 420;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
addEventListener('resize', fit);

const modes = {bSolid: solid, bWire: wire, bPts: pts};
for (const id of Object.keys(modes)) {
  document.getElementById(id).addEventListener('click', () => {
    for (const [k, obj] of Object.entries(modes)) {
      const on = k === id;
      obj.visible = on;
      document.getElementById(k).setAttribute('aria-pressed', String(on));
    }
  });
}

fit(); place();
(function loop() { requestAnimationFrame(loop); renderer.render(scene, camera); })();
</script>
"""

# json.dumps does not escape "<", so a filename containing "</script>" would
# close the tag and turn the rest of the page into markup.
payload = json.dumps(mesh).replace("<", "\\u003c")
out.write_text(HTML.replace("__MESH__", payload))
print(f"wrote {out} ({out.stat().st_size:,} bytes)")
print(f"open with: open {out}")
