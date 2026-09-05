#!/usr/bin/env python3
"""Verify the tessellation decoder against independent ground truth.

Each NIST part exists both as a SLDPRT and as a STEP file. The STEP files were
read with OCCT and their bounding boxes recorded in d8-truth.json. If the
decoder is correct, geometry pulled out of the SolidWorks file must match the
box measured from the STEP twin.

This is the check that separates "it drew something" from "it drew the part".

Usage: d9-verify.py
"""
import json
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent
SW = ROOT.parent / "assets" / "solidworks"
truth = json.loads((ROOT / "d8-truth.json").read_text())

print(f"{'part':14s} {'STEP bbox (mm)':>26s} {'SLDPRT bbox (mm)':>26s} "
      f"{'tris':>6s}  match")
rows = []
for f in sorted(SW.glob("*.SLDPRT")):
    key = f.name.split("_asme")[0]
    if key not in truth:
        continue
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tmp:
        out = pathlib.Path(tmp.name)
    r = subprocess.run(
        [sys.executable, str(ROOT / "d9-decode.py"), str(f), str(out)],
        capture_output=True, text=True)
    if r.returncode != 0 or not out.exists() or out.stat().st_size < 10:
        print(f"{key:14s} {'-':>26s} {'DECODE FAILED':>26s}")
        rows.append((key, False))
        out.unlink(missing_ok=True)
        continue
    got = json.loads(out.read_text())
    out.unlink(missing_ok=True)

    want = sorted(truth[key]["size"], reverse=True)
    have = sorted(got["bboxMm"], reverse=True)
    ok = all(abs(a - b) <= max(0.5, 0.02 * b) for a, b in zip(have, want))
    rows.append((key, ok))
    print(f"{key:14s} "
          f"{' x '.join(f'{v:7.2f}' for v in want):>26s} "
          f"{' x '.join(f'{v:7.2f}' for v in have):>26s} "
          f"{got['triangleCount']:>6,}  {'YES' if ok else 'no'}")

good = sum(1 for _, ok in rows if ok)
print(f"\n{good}/{len(rows)} parts match their STEP bounding box "
      f"within 2 percent")
