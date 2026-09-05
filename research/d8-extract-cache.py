#!/usr/bin/env python3
"""Extract every nested stream from each SLDPRT once, and cache to disk.

The recursive inflate is the expensive step, not the analysis: it attempts a
decompress at every byte offset, then recurses into whatever it finds. Doing
it once and caching means later analysis passes are effectively free.

Usage: d8-extract-cache.py <cache-dir>
"""
import pathlib
import sys
import time
import zlib

# Cap on TOTAL inflated bytes across all nested streams.
MAX_TOTAL_INFLATED = 512 << 20

ROOT = pathlib.Path(__file__).resolve().parent
SW_DIR = ROOT.parent / "assets" / "solidworks"
CACHE = pathlib.Path(sys.argv[1])


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


def collect(buf, depth, out, budget=None):
    if depth > 5:
        return
    if budget is None:
        budget = [MAX_TOTAL_INFLATED]
    kids = list(inflate_all(buf, budget))
    if not kids:
        out.append(buf)
        return
    for k in kids:
        out.append(k)
        collect(k, depth + 1, out, budget)


for f in sorted(SW_DIR.glob("*.SLDPRT")):
    key = f.name.split("_asme")[0]
    d = CACHE / key
    if d.exists() and any(d.iterdir()):
        print(f"{key}: cached, skipping", flush=True)
        continue
    d.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    streams = []
    collect(f.read_bytes(), 0, streams)
    for n, s in enumerate(streams):
        (d / f"{n:04d}.bin").write_bytes(s)
    print(f"{key}: {len(streams)} streams, "
          f"{sum(len(s) for s in streams):,} bytes, "
          f"{time.time()-t0:.1f}s", flush=True)

print("done", flush=True)
