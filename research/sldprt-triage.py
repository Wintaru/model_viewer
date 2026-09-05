#!/usr/bin/env python3
"""One-shot triage of any SolidWorks file (.SLDPRT, .SLDASM, .SLDDRW).

Answers, for a file we have never seen before:
  - which container generation it uses (pre-2014 OLE2, or the chunked format)
  - which SolidWorks version wrote it
  - whether a cached display mesh is present (the D8 finding)
  - whether Parasolid B-rep streams are present
  - what else is in there (previews, XML properties, PMI classes)

Usage: sldprt-triage.py <file> [more files...]

Standard library only. No numpy needed.
"""
import pathlib
import re
import sys
import zlib

# Cap on TOTAL inflated bytes across all nested streams.
MAX_TOTAL_INFLATED = 512 << 20

OLE2 = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
# Bytes per triangle in the tessellation stream, measured over the 9-part NIST
# corpus (range 61 to 138). Used only for a rough estimate.
BYTES_PER_TRI = 90


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


def collect(buf, depth=0, out=None, budget=None):
    if out is None:
        out = []
    if depth > 5:
        return out
    if budget is None:
        budget = [MAX_TOTAL_INFLATED]
    kids = list(inflate_all(buf, budget))
    if not kids:
        out.append(buf)
        return out
    for k in kids:
        out.append(k)
        collect(k, depth + 1, out, budget)
    return out


def utf16_strings(blob, minlen=4):
    """SolidWorks stores many names as UTF-16LE, invisible to a byte scan."""
    try:
        text = blob.decode("utf-16-le", errors="ignore")
    except Exception:
        return []
    return re.findall(r"[\x20-\x7e]{%d,}" % minlen, text)


def triage(path):
    data = path.read_bytes()
    print(f"\n{'=' * 72}\n{path.name}   {len(data):,} bytes\n{'=' * 72}")

    if data[:8] == OLE2:
        print("container : OLE2 compound file (SolidWorks 2013 or earlier)")
        print("            The old reverse-engineering notes apply to this one.")
        print("            Use an OLE2 reader (python 'olefile') to walk streams.")
        return
    print(f"container : chunked format (SolidWorks 2014+)   "
          f"header={data[:8].hex()}")

    streams = collect(data)
    total = sum(len(s) for s in streams)
    print(f"streams   : {len(streams)} inflated, {total:,} bytes "
          f"({total / max(1, len(data)):.1f}x the file size)")

    tess, para, pngs, xmls = [], [], 0, 0
    versions, gtol = set(), set()
    for s in streams:
        if b"TessData" in s:
            tess.append(s)
        if s.startswith(b"PS") and b"TRANSMIT FILE" in s[:200]:
            para.append(s)
        if s[:8] == b"\x89PNG\r\n\x1a\n":
            pngs += 1
        if s[:5] == b"<?xml":
            xmls += 1
        for m in re.findall(rb"modeller version (\d+)", s[:400]):
            versions.add(f"Parasolid {m.decode()}")
        for tok in utf16_strings(s[:4000], 4):
            if re.fullmatch(r"20\d\d", tok):
                versions.add(f"SolidWorks {tok}")
        for m in re.findall(rb"mo[A-Za-z]*Gtol[A-Za-z]*_c", s):
            gtol.add(m.decode())

    print(f"version   : {', '.join(sorted(versions)) or 'not identified'}")

    print("\n--- cached display mesh (the D8 question)")
    if tess:
        big = max(tess, key=len)
        names = sorted(set(
            m.decode() for s in tess
            for m in re.findall(rb"uo[A-Za-z]*Tess[A-Za-z]*_c", s)))
        print(f"  PRESENT — {len(tess)} stream(s), largest {len(big):,} bytes")
        print(f"  classes: {', '.join(names) or 'TessData (unnamed)'}")
        print(f"  rough triangle estimate: ~{len(big) // BYTES_PER_TRI:,} "
              f"(at {BYTES_PER_TRI} bytes/triangle, measured range 61-138)")
        print("  => a viewer can use this. No Parasolid parsing needed.")
    else:
        print("  ABSENT — no TessData stream found.")
        print("  => this file would need the Parasolid path (see below).")
        print("     Worth knowing WHY: different version, or graphics data")
        print("     not saved. Compare against a file that does have it.")

    print("\n--- Parasolid B-rep")
    if para:
        for p in para:
            kind = p[:80].decode("ascii", "replace")
            kind = ("partition" if "partition" in kind
                    else "deltas" if "deltas" in kind else "plain")
            print(f"  {len(p):>9,} bytes   {kind}")
    else:
        print("  none found")

    print(f"\n--- other content")
    print(f"  PNG previews : {pngs}")
    print(f"  XML streams  : {xmls}")
    if gtol:
        print(f"  PMI classes  : {', '.join(sorted(gtol))}")


if len(sys.argv) < 2:
    print(__doc__)
    sys.exit(1)
for arg in sys.argv[1:]:
    p = pathlib.Path(arg)
    if p.exists():
        triage(p)
    else:
        print(f"not found: {arg}")
