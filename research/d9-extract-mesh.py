#!/usr/bin/env python3
"""D9 — extract renderable geometry from the cached tessellation streams.

Key structural observation: vertex and normal arrays appear as adjacent pairs
of EQUAL length. Normals are easy to identify with certainty, because their
triples have unit length. So rather than guess which blocks are coordinates by
magnitude, we find the normal blocks first and then take the equally sized
block immediately before each one as its vertex block.

That rule is far more robust than a magnitude heuristic, which mislabels
planar faces (where one axis is constant) and small features.

Usage: d9-extract-mesh.py <file.SLDPRT> <out.json>
"""
import json
import math
import pathlib
import struct
import sys
import zlib

MAGIC = b"TessData"
# Cap on TOTAL inflated bytes across all nested streams, so a crafted
# file cannot exhaust memory with many small decompression bombs.
MAX_TOTAL_INFLATED = 512 << 20
WIN = 15                     # values per window: 5 triples
MIN_NORMALS = 45             # values; 15 triples


def inflate_all(buf, budget=None):
    """Yield every inflatable stream in buf.

    Two things worth knowing. First, the scan uses a memoryview: slicing bytes
    at every offset copies the whole remaining buffer each time, which is
    O(n^2) and was the real reason these scans took minutes. Second, `budget`
    caps TOTAL inflated output across all streams, because a per-stream cap
    alone does not stop a file holding a thousand small zlib bombs.
    """
    mv = memoryview(buf)
    i, n = 0, len(buf)
    while i < n - 8:
        got = None
        if buf[i] == 0x78 and ((buf[i] << 8) | buf[i + 1]) % 31 == 0:
            try:
                o = zlib.decompressobj()
                d = o.decompress(mv[i:], 64 << 20)
                if len(d) >= 256:
                    got = (n - i - len(o.unused_data), d)
            except zlib.error:
                pass
        if got is None:
            try:
                o = zlib.decompressobj(-15)
                d = o.decompress(mv[i:], 64 << 20)
                if len(d) >= 256:
                    c = n - i - len(o.unused_data)
                    if c > 16:
                        got = (c, d)
            except zlib.error:
                pass
        if got:
            if budget is not None:
                budget[0] -= len(got[1])
                if budget[0] < 0:
                    return
            yield got[1]
            i += got[0]
        else:
            i += 1


def collect(buf, depth=0, acc=None, budget=None):
    if acc is None:
        acc = []
    if depth > 5:
        return acc
    if budget is None:
        budget = [MAX_TOTAL_INFLATED]
    kids = list(inflate_all(buf, budget))
    if not kids:
        acc.append(buf)
        return acc
    for k in kids:
        acc.append(k)
        collect(k, depth + 1, acc, budget)
    return acc


def is_normal_window(vals, s, n):
    """True when the triples in vals[s:s+n] are mostly unit length."""
    unit = nz = 0
    for i in range(s, s + n - 2, 3):
        x, y, z = vals[i], vals[i + 1], vals[i + 2]
        if x != x or y != y or z != z:
            return False
        L = math.sqrt(x * x + y * y + z * z)
        if L > 1e-9:
            nz += 1
            if abs(L - 1.0) < 0.02:
                unit += 1
    return nz > 0 and unit / nz > 0.85


def plausible_coords(vals, s, n, limit=2.0):
    for i in range(s, s + n):
        v = vals[i]
        if v != v or abs(v) > limit:
            return False
    return True


def extract(blob):
    cnt = len(blob) // 4
    if cnt < 60:
        return [], []
    vals = struct.unpack_from(f"<{cnt}f", blob, 0)

    # Mark normal-looking windows, aligned to triples.
    flags = []
    for s in range(0, cnt - WIN, WIN):
        flags.append((s, is_normal_window(vals, s, WIN)))

    # Merge into normal blocks.
    blocks = []
    start = None
    for s, isn in flags:
        if isn and start is None:
            start = s
        elif not isn and start is not None:
            blocks.append((start, s))
            start = None
    if start is not None:
        blocks.append((start, cnt))

    pairs = []
    for ns, ne in blocks:
        length = ne - ns
        if length < MIN_NORMALS:
            continue
        vs = ns - length                       # equal-length block before it
        if vs < 0:
            continue
        if vs % 3:                             # keep triple alignment
            continue
        if not plausible_coords(vals, vs, length):
            continue
        # Reject the case where the "vertex" block is itself normals.
        if is_normal_window(vals, vs, min(WIN, length)):
            continue
        seg = vals[vs:vs + length]
        extent = max(max(seg[a::3]) - min(seg[a::3]) for a in range(3))
        pairs.append((extent, seg, vals[ns:ne]))

    if not pairs:
        return [], []

    # A part is one object, so its face blocks share a scale. Drop blocks whose
    # extent is far from the median - those are stray non-geometry floats that
    # happened to sit next to a unit-vector run.
    extents = sorted(p[0] for p in pairs)
    median = extents[len(extents) // 2] or 1e-6
    verts, norms = [], []
    for extent, seg, nrm in pairs:
        if extent > median * 12:
            continue
        verts.extend(seg)
        norms.extend(nrm)
    return verts, norms


src = pathlib.Path(sys.argv[1])
dst = pathlib.Path(sys.argv[2])
streams = [s for s in collect(src.read_bytes()) if MAGIC in s]
uniq, seen = [], set()
for s in streams:
    h = hash(s)
    if h not in seen:
        seen.add(h)
        uniq.append(s)
print(f"{src.name}: {len(uniq)} unique TessData stream(s)")

all_v, all_n = [], []
for i, blob in enumerate(sorted(uniq, key=len, reverse=True)):
    v, n = extract(blob)
    print(f"  stream {i} ({len(blob):,}b): {len(v)//3:,} vertices, "
          f"{len(n)//3:,} normals")
    all_v.extend(v)
    all_n.extend(n)

nv = len(all_v) // 3
print(f"\ntotal vertices: {nv:,}   normals: {len(all_n)//3:,}")
if nv == 0:
    sys.exit("no geometry found")


def clip_outliers(v, n):
    """Drop triples that sit far outside the interquartile range.

    A handful of stray floats survive block classification and would otherwise
    stretch the bounding box by an order of magnitude.
    """
    cnt = len(v) // 3
    keep = [True] * cnt
    for a in range(3):
        col = sorted(v[a::3])
        q1 = col[cnt // 4]
        q3 = col[(3 * cnt) // 4]
        iqr = max(q3 - q1, 1e-9)
        lo, hi = q1 - 4 * iqr, q3 + 4 * iqr
        for i in range(cnt):
            if not (lo <= v[3 * i + a] <= hi):
                keep[i] = False
    ov, on = [], []
    for i in range(cnt):
        if keep[i]:
            ov.extend(v[3 * i:3 * i + 3])
            if 3 * i + 3 <= len(n):
                on.extend(n[3 * i:3 * i + 3])
    return ov, on


all_v, all_n = clip_outliers(all_v, all_n)
dropped = nv - len(all_v) // 3
nv = len(all_v) // 3
print(f"after outlier clip: {nv:,} vertices ({dropped} dropped)")

xs, ys, zs = all_v[0::3], all_v[1::3], all_v[2::3]
bbox = [max(a) - min(a) for a in (xs, ys, zs)]
centre = [(max(a) + min(a)) / 2 for a in (xs, ys, zs)]
print(f"bbox: {[round(v*1000, 2) for v in bbox]} mm  "
      f"({[round(v*39.3701, 3) for v in bbox]} in)")

out_v = []
for i in range(nv):
    out_v.extend([round((all_v[3*i+a] - centre[a]) * 1000, 4) for a in range(3)])

dst.write_text(json.dumps({
    "source": src.name,
    "units": "mm",
    "vertexCount": nv,
    "bboxMm": [round(v * 1000, 3) for v in bbox],
    "vertices": out_v,
    "normals": [round(v, 4) for v in all_n],
}))
print(f"wrote {dst} ({dst.stat().st_size:,} bytes)")
