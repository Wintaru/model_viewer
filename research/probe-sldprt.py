#!/usr/bin/env python3
"""Structural probe of a modern SLDPRT file.

Question being tested: is the whole file opaque, or are there structured
regions (compressed streams, directories, thumbnails) worth decoding?
"""
import math
import pathlib
import sys
import zlib
from collections import Counter

path = pathlib.Path(sys.argv[1])
data = path.read_bytes()
print(f"{path.name}  {len(data):,} bytes\n")


def entropy(block: bytes) -> float:
    if not block:
        return 0.0
    counts = Counter(block)
    n = len(block)
    return -sum((c / n) * math.log2(c / n) for c in counts.values())


# 1. Entropy profile. 8.0 = indistinguishable from random. Structured or
#    lightly-compressed data sits lower and shows variation between blocks.
BLOCK = 4096
blocks = [entropy(data[i:i + BLOCK]) for i in range(0, len(data), BLOCK)]
print("=== Entropy per 4 KB block")
print(f"  blocks={len(blocks)}  min={min(blocks):.2f}  max={max(blocks):.2f}  "
      f"mean={sum(blocks)/len(blocks):.2f}")
low = [(i, e) for i, e in enumerate(blocks) if e < 7.0]
print(f"  blocks below 7.0 (structured-looking): {len(low)}")
for i, e in low[:12]:
    print(f"    block {i:5d} @ 0x{i*BLOCK:08x}  entropy {e:.2f}")

# Sparkline of the whole file so the layout is visible at a glance.
ramp = " .:-=+*#%@"
step = max(1, len(blocks) // 100)
spark = "".join(
    ramp[min(9, int((blocks[i] / 8.0) * 10))] for i in range(0, len(blocks), step)
)
print(f"\n  layout (low->high entropy): |{spark}|")

# 2. Known container / stream signatures.
print("\n=== Signature scan")
sigs = {
    "OLE2 compound":      b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1",
    "ZIP local header":   b"PK\x03\x04",
    "PNG":                b"\x89PNG\r\n\x1a\n",
    "BMP":                b"BM",
    "JPEG/JFIF":          b"\xff\xd8\xff",
    "Parasolid transmit": b"**ABCDEFGH",
    "Parasolid schema":   b"SCH_",
    "gzip":               b"\x1f\x8b\x08",
}
for name, sig in sigs.items():
    hits = []
    start = 0
    while len(hits) < 5:
        i = data.find(sig, start)
        if i < 0:
            break
        hits.append(i)
        start = i + 1
    print(f"  {name:20s} {len(hits) if hits else 0} hit(s) "
          f"{[hex(h) for h in hits[:5]]}")

# 3. zlib streams. A zlib header is 0x78 followed by one of a few bytes; the
#    real test is whether a decompressor accepts it, so try each candidate.
print("\n=== zlib stream probe (0x78 headers, verified by inflate)")
found = []
for i in range(len(data) - 2):
    if data[i] != 0x78 or data[i + 1] not in (0x01, 0x5E, 0x9C, 0xDA):
        continue
    try:
        obj = zlib.decompressobj()
        out = obj.decompress(data[i:], 200_000)
        if len(out) >= 512:
            found.append((i, len(out), out))
    except zlib.error:
        pass
print(f"  verified zlib streams: {len(found)}")
for off, size, out in found[:10]:
    printable = sum(1 for b in out[:400] if 32 <= b < 127)
    preview = bytes(b if 32 <= b < 127 else 46 for b in out[:70]).decode("ascii")
    print(f"    @0x{off:08x} -> {size:>9,} bytes  "
          f"ascii={printable*100//400:3d}%  |{preview}|")

# 4. Raw deflate (no zlib header). SolidWorks is reported to use this.
print("\n=== raw deflate probe (sampled offsets)")
raw_hits = []
stride = max(1, len(data) // 20000)
for i in range(0, len(data) - 4, stride):
    try:
        out = zlib.decompressobj(-15).decompress(data[i:], 100_000)
        if len(out) >= 2048:
            raw_hits.append((i, len(out), out))
    except zlib.error:
        pass
print(f"  candidate raw-deflate streams: {len(raw_hits)}")
for off, size, out in sorted(raw_hits, key=lambda r: -r[1])[:8]:
    printable = sum(1 for b in out[:400] if 32 <= b < 127)
    preview = bytes(b if 32 <= b < 127 else 46 for b in out[:70]).decode("ascii")
    print(f"    @0x{off:08x} -> {size:>9,} bytes  "
          f"ascii={printable*100//400:3d}%  |{preview}|")

# 5. Head and tail. Directories and indexes often live at one end.
print("\n=== First 96 bytes")
for i in range(0, 96, 16):
    chunk = data[i:i + 16]
    print(f"  {i:08x}  {chunk.hex(' '):<48}  "
          f"{bytes(b if 32 <= b < 127 else 46 for b in chunk).decode('ascii')}")
print("=== Last 96 bytes")
for i in range(len(data) - 96, len(data), 16):
    chunk = data[i:i + 16]
    print(f"  {i:08x}  {chunk.hex(' '):<48}  "
          f"{bytes(b if 32 <= b < 127 else 46 for b in chunk).decode('ascii')}")
