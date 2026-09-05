#!/usr/bin/env python3
"""D9 — pull vertex data out of the cached tessellation streams.

Dumps the TessData streams from a SLDPRT, then reports their structure:
serialised class names in order, and where float arrays sit.

Usage: d9-decode-tess.py <file.SLDPRT> <outdir>
"""
import pathlib
import re
import struct
import sys
import zlib

MAGIC = b"TessData"
# Cap on TOTAL inflated bytes across all nested streams, so a crafted
# file cannot exhaust memory with many small decompression bombs.
MAX_TOTAL_INFLATED = 512 << 20


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


src = pathlib.Path(sys.argv[1])
out = pathlib.Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)

streams = [s for s in collect(src.read_bytes()) if MAGIC in s]
# Drop exact duplicates - the container repeats some streams.
uniq, seen = [], set()
for s in streams:
    h = hash(s)
    if h not in seen:
        seen.add(h)
        uniq.append(s)
uniq.sort(key=len, reverse=True)
print(f"{src.name}: {len(uniq)} unique TessData stream(s)\n")

for n, s in enumerate(uniq):
    p = out / f"tess_{n}.bin"
    p.write_bytes(s)
    print(f"--- tess_{n}.bin  {len(s):,} bytes")

    # MFC CArchive class descriptors: 0xFFFF, then u16 schema, u16 namelen,
    # then the ASCII name. Walk them in order to see the record sequence.
    names = []
    i = 0
    while i < len(s) - 8:
        if s[i] == 0xFF and s[i + 1] == 0xFF:
            ln = struct.unpack_from("<H", s, i + 4)[0]
            if 3 <= ln <= 60 and i + 6 + ln <= len(s):
                cand = s[i + 6:i + 6 + ln]
                if re.fullmatch(rb"[A-Za-z_][A-Za-z0-9_]*", cand):
                    names.append((i, cand.decode()))
                    i += 6 + ln
                    continue
        i += 1
    print(f"    class descriptors ({len(names)}): "
          f"{[nm for _, nm in names][:12]}")

    # Where do float arrays live? Report the longest plausible-coordinate run
    # for each type and alignment.
    for fmt, w, lbl in (("<f", 4, "f32"), ("<d", 8, "f64")):
        best = (0, None, None)
        for align in range(w):
            cnt = (len(s) - align) // w
            if cnt < 30:
                continue
            vals = struct.unpack_from(f"<{cnt}{fmt[1]}", s, align)
            run = 0
            start = 0
            for k, v in enumerate(vals):
                ok = (v == v) and abs(v) < 10.0 and (v == 0.0 or abs(v) > 1e-9)
                if ok:
                    if run == 0:
                        start = k
                    run += 1
                    if run > best[0]:
                        best = (run, align, start)
                else:
                    run = 0
        if best[0] >= 30:
            align, start = best[1], best[2]
            cnt = (len(s) - align) // w
            vals = struct.unpack_from(f"<{cnt}{fmt[1]}", s, align)
            seg = vals[start:start + best[0]]
            print(f"    {lbl} longest run: {best[0]} values @ byte "
                  f"{align + start * w}  "
                  f"range [{min(seg):.5f}, {max(seg):.5f}]")
            print(f"      first 9: {[round(v, 5) for v in seg[:9]]}")
