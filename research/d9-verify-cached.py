#!/usr/bin/env python3
"""Verify the decoder against STEP ground truth, using cached streams.

Same check as d9-verify.py, but reads the streams already extracted by
d8-extract-cache.py instead of re-inflating each SLDPRT. The inflate is the
slow part; this turns a many-minute run into seconds.

Each NIST part exists as both a SLDPRT and a STEP file. The STEP bounding
boxes in d8-truth.json were measured independently with OCCT. If the decoder
is right, the SolidWorks geometry must land on the same box.

Usage: d9-verify-cached.py <cache-dir>
"""
import importlib.util
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent

# Reuse decode_stream from the decoder rather than copying it, so this cannot
# drift away from what actually produced the render.
spec = importlib.util.spec_from_loader("d9", loader=None)
mod = importlib.util.module_from_spec(spec)
src = (ROOT / "d9-decode.py").read_text().split('src = pathlib.Path')[0]
exec(compile(src, "d9-decode.py", "exec"), mod.__dict__)
decode_stream = mod.decode_stream

cache = pathlib.Path(sys.argv[1])
truth = json.loads((ROOT / "d8-truth.json").read_text())

print(f"{'part':14s} {'STEP bbox (mm)':>27s} {'SLDPRT bbox (mm)':>27s} "
      f"{'tris':>6s}  match")
rows = []
for d in sorted(cache.iterdir()):
    if not d.is_dir() or d.name not in truth:
        continue
    V, N, T = [], [], []
    for f in sorted(d.glob("*.bin")):
        blob = f.read_bytes()
        if b"TessData" not in blob:
            continue
        v, n, t = decode_stream(blob)
        base = len(V) // 3
        V.extend(v)
        N.extend(n)
        T.extend(x + base for x in t)
    want = sorted(truth[d.name]["size"], reverse=True)
    if not V:
        print(f"{d.name:14s} {' x '.join(f'{v:7.2f}' for v in want):>27s} "
              f"{'NO GEOMETRY':>27s}")
        rows.append((d.name, False))
        continue
    xs, ys, zs = V[0::3], V[1::3], V[2::3]
    have = sorted([(max(a) - min(a)) * 1000 for a in (xs, ys, zs)],
                  reverse=True)
    ok = all(abs(a - b) <= max(0.5, 0.02 * b) for a, b in zip(have, want))
    rows.append((d.name, ok))
    print(f"{d.name:14s} "
          f"{' x '.join(f'{v:7.2f}' for v in want):>27s} "
          f"{' x '.join(f'{v:7.2f}' for v in have):>27s} "
          f"{len(T)//3:>6,}  {'YES' if ok else 'no'}")

good = sum(1 for _, ok in rows if ok)
print(f"\n{good}/{len(rows)} parts match their STEP bounding box within "
      f"2 percent (or 0.5 mm)")
