#!/usr/bin/env python3
"""Map the true structure of a tessellation stream, word by word.

Earlier passes mistook small integers for coordinates: read as float32, an
integer like 7 becomes a denormal around 1e-44, which slips through any
"is this a plausible coordinate" test that only checks an upper bound.

This classifies every 4-byte word explicitly and prints the run layout, so the
real block boundaries are visible instead of inferred.

Usage: d9-map.py <tess-stream.bin> [min-run]
"""
import pathlib
import struct
import sys

path = pathlib.Path(sys.argv[1])
min_run = int(sys.argv[2]) if len(sys.argv) > 2 else 12
b = path.read_bytes()
n = len(b) // 4
u32 = struct.unpack_from(f"<{n}I", b, 0)
f32 = struct.unpack_from(f"<{n}f", b, 0)


def kind(i):
    u = u32[i]
    f = f32[i]
    if u == 0:
        return "zero"
    if u < 0x10000:                 # small int; as a float this is a denormal
        return "int"
    if f != f:
        return "nan"
    a = abs(f)
    if a < 1e-7:
        return "tiny"               # denormal or near-zero garbage
    if a > 1e6:
        return "big"
    if 0.99 <= a <= 1.0001:
        return "one"
    return "float"


kinds = [kind(i) for i in range(n)]

# Collapse "one" into "float" for run detection; unit-ness is judged per triple.
runs = []
cur = kinds[0]
start = 0
for i in range(1, n):
    k = kinds[i]
    merged = "float" if k in ("float", "one") else k
    prev = "float" if cur in ("float", "one") else cur
    if merged != prev:
        runs.append((prev, start, i))
        cur, start = k, i
runs.append(("float" if cur in ("float", "one") else cur, start, n))

print(f"{path.name}: {len(b):,} bytes, {n:,} words\n")
print(f"{'kind':7s} {'byte':>8s} {'words':>7s}  detail")
for k, s, e in runs:
    ln = e - s
    if ln < min_run:
        continue
    detail = ""
    if k == "float":
        seg = f32[s:e]
        tri = ln // 3
        unit = nz = 0
        for t in range(tri):
            x, y, z = seg[3*t], seg[3*t+1], seg[3*t+2]
            L = (x*x + y*y + z*z) ** 0.5
            if L > 1e-9:
                nz += 1
                if abs(L - 1.0) < 0.02:
                    unit += 1
        pct = unit * 100 // max(1, nz)
        ext = [round((max(seg[a::3]) - min(seg[a::3])) * 1000, 2)
               for a in range(3)] if tri else []
        detail = (f"{tri} triples  unit={pct}%  "
                  f"{'NORMALS' if pct > 85 else 'COORDS'}  extent_mm={ext}")
    elif k == "int":
        seg = u32[s:e]
        detail = f"max={max(seg)}  first={list(seg[:10])}"
    print(f"{k:7s} {s*4:>8d} {ln:>7d}  {detail}")
