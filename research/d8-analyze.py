#!/usr/bin/env python3
"""Analyse cached streams for coordinate data matching a known part bbox.

Usage: d8-analyze.py <stream-dir> <part-key>
"""
import json
import pathlib
import sys

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parent
MIN_RUN = 36
SCALES = {"mm": 1.0, "m->mm": 1000.0, "cm->mm": 10.0, "in->mm": 25.4}
TOL = 0.03

stream_dir = pathlib.Path(sys.argv[1])
key = sys.argv[2]
truth = json.loads((ROOT / "d8-truth.json").read_text())
target = truth[key]["size"]


def runs_of(mask, minlen):
    if mask.size == 0:
        return []
    padded = np.concatenate(([0], mask.view(np.int8), [0]))
    e = np.diff(padded)
    s = np.flatnonzero(e == 1)
    t = np.flatnonzero(e == -1)
    keep = (t - s) >= minlen
    return list(zip(s[keep], t[keep]))


def cloud(buf, dtype):
    w = np.dtype(dtype).itemsize
    lo, hi = np.full(3, np.inf), np.full(3, -np.inf)
    total = 0
    longest = 0
    for align in range(w):
        usable = (len(buf) - align) // w * w
        if usable < MIN_RUN * w:
            continue
        arr = np.frombuffer(buf, dtype=dtype, count=usable // w, offset=align)
        with np.errstate(invalid="ignore"):
            a = np.abs(arr)
            mask = np.isfinite(arr) & (a < 1e5) & ((arr == 0) | (a > 1e-12))
        for s, t in runs_of(mask, MIN_RUN):
            longest = max(longest, int(t - s))
            seg = arr[s:t]
            seg = seg[: (seg.size // 3) * 3].reshape(-1, 3).astype(np.float64)
            if seg.size:
                lo = np.minimum(lo, seg.min(axis=0))
                hi = np.maximum(hi, seg.max(axis=0))
                total += seg.shape[0]
    return (None, 0, 0) if total == 0 else (hi - lo, total, longest)


def match(span):
    want = np.sort(np.asarray(target, float))
    for name, sc in SCALES.items():
        got = np.sort(np.asarray(span, float) * sc)
        ok = True
        for a, b in zip(got, want):
            if b < 1e-6:
                ok = ok and a < 1e-2
                continue
            if abs(a - b) / b > TOL:
                ok = False
                break
        if ok:
            return name
    return None


print(f"part {key}   target bbox {[round(v, 2) for v in target]} mm")
print(f"streams in {stream_dir}: {len(list(stream_dir.glob('*.bin')))}\n")
rows = []
for f in sorted(stream_dir.glob("*.bin")):
    buf = f.read_bytes()
    for dt, lbl in (("<f4", "f32"), ("<f8", "f64")):
        span, n, longest = cloud(buf, dt)
        if span is None or n < 60:
            continue
        m = match(span)
        rows.append((f.name, lbl, len(buf), n, longest, span, m))

rows.sort(key=lambda r: -r[3])
print(f"{'stream':28s} {'ty':4s} {'bytes':>9s} {'points':>8s} {'run':>7s}  span (mm-ish)")
for name, lbl, blen, n, longest, span, m in rows[:20]:
    flag = f"  <<< MATCH [{m}]" if m else ""
    print(f"{name:28s} {lbl:4s} {blen:>9,} {n:>8,} {longest:>7,}  "
          f"{[round(float(v), 3) for v in span]}{flag}")

hits = [r for r in rows if r[6]]
print(f"\nbbox matches: {len(hits)}")
