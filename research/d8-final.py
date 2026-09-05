#!/usr/bin/env python3
"""D8 final — is a display mesh cached inside SLDPRT files?

Calibrated against a real binary STL (3DBenchy, 225,706 triangles) rather than
a synthetic array. Two corrections came out of that control:

1. MIN_RUN must be about 12 floats, not 36. Real mesh formats interleave
   coordinates with normals and per-record attributes, so contiguous runs are
   short. Binary STL breaks alignment every 50 bytes.
2. Byte alignments must be scored separately. Pooling them lets misaligned
   garbage floats through and destroys the bounding box.

With those fixes the control recovers 3DBenchy's box to within 2 percent.

Usage:
  d8-final.py --control              re-run the STL control
  d8-final.py <cache-dir> [part...]  scan cached SLDPRT streams
"""
import json
import pathlib
import sys

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parent
MIN_RUN = 12
SCALES = {"mm": 1.0, "m->mm": 1000.0, "cm->mm": 10.0, "in->mm": 25.4}
TOL = 0.05
MIN_PTS = 200


def per_alignment(buf, dtype):
    """Robust extent and point count for each byte alignment separately."""
    w = np.dtype(dtype).itemsize
    results = []
    for align in range(w):
        usable = (len(buf) - align) // w * w
        if usable < MIN_RUN * w:
            results.append(None)
            continue
        arr = np.frombuffer(buf, dtype=dtype, count=usable // w, offset=align)
        with np.errstate(invalid="ignore"):
            a = np.abs(arr)
            mask = np.isfinite(arr) & (a < 1e5) & ((arr == 0) | (a > 1e-12))
        pad = np.concatenate(([0], mask.view(np.int8), [0]))
        e = np.diff(pad)
        s = np.flatnonzero(e == 1)
        t = np.flatnonzero(e == -1)
        keep = (t - s) >= MIN_RUN
        chunks = []
        for a0, b0 in zip(s[keep], t[keep]):
            seg = arr[a0:b0]
            seg = seg[: (seg.size // 3) * 3].reshape(-1, 3).astype(np.float64)
            if seg.size:
                chunks.append(seg)
        if not chunks:
            results.append(None)
            continue
        P = np.vstack(chunks)
        lo = np.percentile(P, 0.5, axis=0)
        hi = np.percentile(P, 99.5, axis=0)
        results.append((hi - lo, P.shape[0]))
    return results


def match_scale(span, target):
    want = np.sort(np.asarray(target, float))
    for name, sc in SCALES.items():
        got = np.sort(np.asarray(span, float) * sc)
        ok = True
        for a, b in zip(got, want):
            if b < 1e-6:
                ok = ok and a < 1e-2
                continue
            if b == 0 or abs(a - b) / b > TOL:
                ok = False
                break
        if ok:
            return name
    return None


def match_aspect(span, target, tol=0.10):
    """Scale-invariant shape test.

    Catches a mesh stored in normalised or local coordinates, where the
    absolute size would not match but the proportions still would.
    """
    s = np.sort(np.asarray(span, float))[::-1]
    t = np.sort(np.asarray(target, float))[::-1]
    if s[0] <= 0 or t[0] <= 0:
        return False
    s = s / s[0]
    t = t / t[0]
    for a, b in zip(s[1:], t[1:]):
        if abs(a - b) > tol:
            return False
    return True


if "--control" in sys.argv:
    import struct
    b = (ROOT.parent / "assets" / "mesh" / "3DBenchy.stl").read_bytes()
    ntri = struct.unpack_from("<I", b, 80)[0]
    lo = np.full(3, np.inf)
    hi = np.full(3, -np.inf)
    V = np.frombuffer(b, dtype=np.uint8, count=ntri * 50, offset=84)
    V = V.reshape(ntri, 50)[:, 12:48].copy().view("<f4").reshape(-1, 3)
    target = (V.max(axis=0) - V.min(axis=0)).astype(float)
    print(f"CONTROL 3DBenchy.stl  {ntri:,} triangles  "
          f"true bbox {[round(float(v), 2) for v in target]}")
    hit = False
    for i, r in enumerate(per_alignment(b, "<f4")):
        if r is None:
            continue
        span, n = r
        m = match_scale(span, target)
        if n >= MIN_PTS:
            print(f"  align {i}: {n:>9,} pts  span={[round(float(v),2) for v in span]}"
                  + (f"   MATCH [{m}]" if m else ""))
        hit = hit or bool(m)
    print("CONTROL " + ("PASSED — detector finds a real mesh\n" if hit
                        else "FAILED — do not trust negatives\n"))
    sys.exit(0 if hit else 1)

cache = pathlib.Path(sys.argv[1])
wanted = [a for a in sys.argv[2:] if not a.startswith("-")]
truth = json.loads((ROOT / "d8-truth.json").read_text())

rows = []
for part_dir in sorted(cache.iterdir()):
    if not part_dir.is_dir():
        continue
    key = part_dir.name
    if key not in truth or (wanted and key not in wanted):
        continue
    target = truth[key]["size"]
    tri = truth[key]["triangles"]
    hits = []
    best = (0, None, None, None)
    for f in sorted(part_dir.glob("*.bin")):
        buf = f.read_bytes()
        if len(buf) < 512:
            continue
        for dt, lbl in (("<f4", "f32"), ("<f8", "f64")):
            for ai, r in enumerate(per_alignment(buf, dt)):
                if r is None:
                    continue
                span, n = r
                if n < MIN_PTS:
                    continue
                if n > best[0]:
                    best = (n, f"{f.name} {lbl} a{ai}", span, len(buf))
                m = match_scale(span, target)
                if m:
                    hits.append((f.name, lbl, ai, n, span, m, len(buf)))
                elif n >= tri and match_aspect(span, target):
                    # Right shape, wrong size, and big enough to be the mesh.
                    hits.append((f.name, lbl, ai, n, span, "ASPECT-ONLY",
                                 len(buf)))
    print(f"{key}   target {[round(v,2) for v in target]} mm   "
          f"{tri:,} tri   streams={len(list(part_dir.glob('*.bin')))}")
    if best[1]:
        print(f"   largest cloud: {best[0]:,} pts in {best[1]} "
              f"({best[3]:,}b)  span={[round(float(v),3) for v in best[2]]}")
    for name, lbl, ai, n, span, m, blen in hits[:6]:
        print(f"   *** MATCH {name} {lbl} align{ai} ({blen:,}b)  {n:,} pts  "
              f"span={[round(float(v),3) for v in span]}  [{m}]")
    if not hits:
        print("   no bbox match")
    rows.append((key, tri, best[0], len(hits)))
    print()

print("=== Summary")
print(f"{'part':14s} {'STEP tri':>9s} {'need pts':>9s} {'max cloud':>10s} {'hits':>6s}")
for key, tri, mc, nh in rows:
    print(f"{key:14s} {tri:>9,} {tri:>9,} {mc:>10,} {nh:>6}")
print(f"\nParts with a matching point cloud: {sum(1 for r in rows if r[3])}/{len(rows)}")
