#!/usr/bin/env python3
"""Recursively inflate nested streams inside a SLDPRT file.

The container turns out to be layered: outer raw-deflate streams hold
length-prefixed zlib blocks, which hold more data again. This walks down until
nothing further inflates, then reports what was found at the bottom.
"""
import collections
import pathlib
import sys
import zlib

path = pathlib.Path(sys.argv[1])
out_dir = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else None
MIN_OUT = 256
MAX_DEPTH = 6


def inflate_all(buf: bytes):
    """Yield (offset, consumed, inflated) for every stream found in buf.

    Tries zlib-wrapped first (cheap header test), then bare deflate.
    """
    i = 0
    while i < len(buf) - 8:
        got = None
        # zlib-wrapped: 0x78 + level byte, and the 2-byte header must be
        # divisible by 31 (the format's own checksum on the header).
        if buf[i] == 0x78 and ((buf[i] << 8) | buf[i + 1]) % 31 == 0:
            try:
                obj = zlib.decompressobj()
                out = obj.decompress(buf[i:], 32 << 20)
                if len(out) >= MIN_OUT:
                    got = (len(buf) - i - len(obj.unused_data), out)
            except zlib.error:
                pass
        if got is None:
            try:
                obj = zlib.decompressobj(-15)
                out = obj.decompress(buf[i:], 32 << 20)
                if len(out) >= MIN_OUT:
                    consumed = len(buf) - i - len(obj.unused_data)
                    if consumed > 16:
                        got = (consumed, out)
            except zlib.error:
                pass
        if got:
            yield (i, got[0], got[1])
            i += got[0]
        else:
            i += 1


found = collections.Counter()
parasolid_blobs = []
leaves = []


def walk(buf: bytes, depth: int, label: str):
    if depth > MAX_DEPTH:
        return
    children = list(inflate_all(buf))
    if not children:
        leaves.append((label, buf))
        return
    for n, (off, csize, out) in enumerate(children):
        tag = f"{label}/{n}@0x{off:x}"
        kind = "binary"
        if out.startswith(b"PS") and b"TRANSMIT FILE" in out[:200]:
            kind = "PARASOLID"
            parasolid_blobs.append((tag, out))
        elif out[:8] == b"\x89PNG\r\n\x1a\n":
            kind = "PNG"
        elif out[:2] == b"BM":
            kind = "BMP"
        elif out[:5] == b"<?xml":
            kind = "XML"
        found[kind] += 1
        print(f"{'  ' * depth}{tag}  {csize:,} -> {len(out):,}  {kind}")
        walk(out, depth + 1, tag)


data = path.read_bytes()
print(f"{path.name}  {len(data):,} bytes\n")
walk(data, 0, "root")

print(f"\n=== Totals by kind: {dict(found)}")
print(f"=== Parasolid streams found: {len(parasolid_blobs)}")
for tag, blob in parasolid_blobs:
    header = blob[:120].decode("ascii", "replace").replace("\n", " ")
    print(f"    {tag}  {len(blob):,} bytes  |{header[:100]}|")

if out_dir and parasolid_blobs:
    out_dir.mkdir(parents=True, exist_ok=True)
    for n, (_tag, blob) in enumerate(parasolid_blobs):
        (out_dir / f"parasolid_{n:03d}.x_t").write_bytes(blob)
    print(f"\nWrote {len(parasolid_blobs)} Parasolid streams to {out_dir}/")
