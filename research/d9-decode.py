#!/usr/bin/env python3
"""D9 — decode SolidWorks cached tessellation into triangles.

Record layout, recovered by inspection from SolidWorks 2018 and 2020 files:

    u32  4, 8, 2, N          marker, then N = number of triangle strips
    u32  size[0..N-1]        vertices in each strip; these sum to TOTAL
    u32  a, b, 2, TOTAL      tail, ending with the vertex total
    f32  TOTAL * 3           vertex positions, metres
    f32  TOTAL * 3           per-vertex normals

Three things that are easy to get wrong, each of which cost a debugging round:

1. Runs are triangle STRIPS, not fans. Fanning a run from its first vertex
   collapses a cylindrical hole wall onto a point, so every hole renders as a
   cone.
2. Headers are not always 4-byte aligned. Reading the stream only as
   word-aligned u32 misses every header in some files, and the symptom is a
   scan reporting no rejections at all, because it never saw a candidate.
3. Small integers look like coordinates. As float32 the integer 7 is a denormal
   near 1e-44, so any plausible-coordinate test that checks only an upper bound
   will accept index arrays as vertices.

Verified against independent ground truth: 6 of 11 NIST parts reproduce the
bounding box measured from their STEP twin with OCCT. See research/d9-verify-cached.py.

The "normals" this script writes to its output JSON are the file's own
scanned per-vertex values, unmodified -- useful for inspecting the raw
format. WAYFINDER.md's D18: the shipped SolidWorksDecodeEngine.ts no longer
uses these at all, having found them to carry more than one distinct
defect; it regenerates every normal from the decoded triangle geometry
instead. This is a deliberate, documented divergence, not drift -- nothing
that reads this script's JSON output depends on its normals matching the
shipped engine's.

Usage: d9-decode.py <file.SLDPRT> <out.json>
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
MAX_LOOPS = 20000


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


def decode_stream(blob, verbose=False):
    """Return (vertices, normals, triangles) recovered from one stream.

    Scans all four byte alignments. Tessellation blocks do not always begin on
    a 4-byte boundary, and reading the stream only as word-aligned u32 misses
    them completely: in several NIST parts every header sat at a byte offset
    that was not a multiple of 4, so the scan saw nothing at all.
    """
    # Gather candidates from every alignment, then keep a non-overlapping set.
    # The same block can be detected at more than one alignment, and a false
    # positive often overlaps a real block; accepting both inflates the model.
    cands = []
    for align in range(4):
        cands.extend(_scan(blob, align, verbose))

    # Prefer larger blocks: a genuine tessellation block is big, and a
    # coincidental match is usually small.
    cands.sort(key=lambda c: -(c[1] - c[0]))
    claimed = []
    kept = []
    for c in cands:
        s, e = c[0], c[1]
        if any(s < ce and cs < e for cs, ce in claimed):
            continue
        claimed.append((s, e))
        kept.append(c)
    kept.sort(key=lambda c: c[0])

    verts, norms, tris = [], [], []
    for _s, _e, vf, nf, sizes in kept:
        base = len(verts) // 3
        verts.extend(vf)
        norms.extend(nf)
        off = base
        for sz in sizes:
            for k in range(sz - 2):
                if k % 2 == 0:
                    tris.extend([off + k, off + k + 1, off + k + 2])
                else:
                    tris.extend([off + k + 1, off + k, off + k + 2])
            off += sz
    return verts, norms, tris


def _scan(blob, align, verbose=False):
    """Return candidate tessellation blocks found at one byte alignment.

    Each block is (byte_start, byte_end, vertices, normals, strip_sizes).
    """
    body = blob[align:]
    words = len(body) // 4
    if words < 16:
        return []
    u = struct.unpack_from(f"<{words}I", body, 0)
    blocks = []

    i = 0
    while i < words - 8:
        # The "4, 8, 2" prefix is load-bearing. Detecting the header by its
        # shape alone (a count, sizes, their sum) matched far more often by
        # accident than on purpose, and verification fell from 3/11 to 1/11.
        # Keep the literal marker.
        if not (u[i] == 4 and u[i + 1] == 8 and u[i + 2] == 2):
            i += 1
            continue
        n_loops = u[i + 3]
        if not (1 <= n_loops <= MAX_LOOPS) or i + 4 + n_loops + 4 > words:
            i += 1
            continue
        sizes = u[i + 4:i + 4 + n_loops]
        if any(s < 3 or s > 100000 for s in sizes):
            i += 1
            continue
        total = sum(sizes)

        # The tail ends with the vertex total, preceded by a literal 2
        # ("a, b, 2, TOTAL"). The literal is load-bearing, not optional:
        # matching on `total` alone finds the wrong word whenever a block's
        # own vertex count happens to equal `a` (observed: total == 12,
        # coinciding with the tail's own leading constant), silently
        # shifting every position/normal float that follows -- see the
        # matching comment on SolidWorksDecodeEngine.ts's
        # findWordAfterTotalMarker.
        tail = i + 4 + n_loops
        pos = None
        for k in range(tail + 1, min(tail + 8, words)):
            if u[k - 1] == 2 and u[k] == total:
                pos = k + 1
                break
        if pos is None:
            i += 1
            continue

        need = total * 3
        if pos + need * 2 > words:
            i += 1
            continue

        vf = struct.unpack_from(f"<{need}f", body, pos * 4)
        nf = struct.unpack_from(f"<{need}f", body, (pos + need) * 4)

        # Sanity: positions must be real coordinates, normals unit length.
        # Tolerance 0.05 -> 0.5: a real filleted-bend strip on a real
        # customer part had only ~half its normals within 0.05 of unit
        # length (smoothly blended along the curve, 0.66-1.21 measured) --
        # "occasional", the original assumption, was wrong. See the matching
        # comment on SolidWorksDecodeEngine.ts's UNIT_NORMAL_TOLERANCE.
        if any(v != v or abs(v) > 100.0 for v in vf):
            i += 1
            continue
        unit = ok = 0
        for t in range(0, total):
            x, y, z = nf[3 * t], nf[3 * t + 1], nf[3 * t + 2]
            L = math.sqrt(x * x + y * y + z * z)
            if L > 1e-9:
                ok += 1
                if abs(L - 1.0) < 0.5:
                    unit += 1
        if ok == 0 or unit / ok < 0.8:
            i += 1
            continue

        # Record the absolute byte span this block occupies, so overlapping
        # detections from other alignments can be discarded by the caller.
        # Triangle building happens there, once the winners are chosen.
        blocks.append((i * 4 + align, (pos + need * 2) * 4 + align,
                       vf, nf, list(sizes)))
        if verbose:
            print(f"    header @{i*4+align} (align {align}): {n_loops} loops, "
                  f"{total} verts, {sum(s - 2 for s in sizes)} triangles")
        i = pos + need * 2
    return blocks


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

V, N, T = [], [], []
for idx, blob in enumerate(sorted(uniq, key=len, reverse=True)):
    v, n, t = decode_stream(blob, verbose=True)
    print(f"  stream {idx} ({len(blob):,}b): {len(v)//3:,} verts, "
          f"{len(t)//3:,} triangles")
    base = len(V) // 3
    V.extend(v)
    N.extend(n)
    T.extend(x + base for x in t)

nv, nt = len(V) // 3, len(T) // 3
print(f"\nTOTAL: {nv:,} vertices, {nt:,} triangles")
if nt == 0:
    sys.exit("no triangles decoded")

xs, ys, zs = V[0::3], V[1::3], V[2::3]
bbox = [max(a) - min(a) for a in (xs, ys, zs)]
centre = [(max(a) + min(a)) / 2 for a in (xs, ys, zs)]
print(f"bbox: {[round(v*1000, 2) for v in bbox]} mm  "
      f"({[round(v*39.3701, 3) for v in bbox]} in)")

out_v = []
for i in range(nv):
    out_v.extend([round((V[3*i+a] - centre[a]) * 1000, 4) for a in range(3)])

dst.write_text(json.dumps({
    "source": src.name,
    "units": "mm",
    "vertexCount": nv,
    "triangleCount": nt,
    "bboxMm": [round(v * 1000, 3) for v in bbox],
    "vertices": out_v,
    "normals": [round(v, 4) for v in N],
    "indices": T,
}))
print(f"wrote {dst} ({dst.stat().st_size:,} bytes)")
