#!/usr/bin/env python3
"""Exhaustive raw-deflate scan of a SLDPRT file.

Raw deflate carries no magic number, so the only way to find streams is to
attempt an inflate at every byte offset and keep what succeeds. wbits=-15
tells zlib to skip the 2-byte zlib header and treat the input as a bare
deflate bitstream.
"""
import pathlib
import sys
import zlib

path = pathlib.Path(sys.argv[1])
out_dir = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else None
data = path.read_bytes()
MIN_OUT = 1024

print(f"{path.name}  {len(data):,} bytes  (scanning every offset)\n")

streams = []
i = 0
while i < len(data) - 8:
    try:
        obj = zlib.decompressobj(-15)
        out = obj.decompress(data[i:], 8 << 20)
        if len(out) >= MIN_OUT:
            consumed = len(data) - i - len(obj.unused_data)
            if consumed > 16:
                streams.append((i, consumed, out))
                i += consumed
                continue
    except zlib.error:
        pass
    i += 1

total_in = sum(s[1] for s in streams)
total_out = sum(len(s[2]) for s in streams)
print(f"=== {len(streams)} raw-deflate streams")
print(f"    compressed {total_in:,} bytes ({total_in*100//len(data)}% of file)")
print(f"    inflated   {total_out:,} bytes (ratio {total_out/max(1,total_in):.2f}x)\n")


def describe(blob: bytes) -> str:
    if blob.startswith(b"PS") and b"TRANSMIT FILE" in blob[:200]:
        return "*** PARASOLID TRANSMIT ***"
    if blob[:2] == b"BM":
        return "BMP preview"
    if blob[:8] == b"\x89PNG\r\n\x1a\n":
        return "PNG"
    sample = blob[:600]
    nul = sum(1 for j in range(1, len(sample), 2) if sample[j] == 0)
    if nul > len(sample) // 4:
        txt = sample.decode("utf-16-le", errors="replace")
        txt = "".join(c for c in txt if c.isprintable())[:70]
        return f"UTF-16: {txt!r}"
    printable = sum(1 for b in sample if 32 <= b < 127 or b in (9, 10, 13))
    if printable > len(sample) * 0.8:
        return f"ASCII: {sample[:70].decode('ascii', 'replace')!r}"
    # Surface any embedded readable tokens as a hint to structure.
    toks, cur = [], b""
    for b in blob[:4000]:
        if 32 <= b < 127:
            cur += bytes([b])
        else:
            if len(cur) >= 6:
                toks.append(cur.decode())
            cur = b""
    return f"binary; tokens={toks[:6]}" if toks else "binary"


for off, csize, blob in streams:
    print(f"  @0x{off:08x}  {csize:>8,} -> {len(blob):>10,}  {describe(blob)}")

if out_dir:
    out_dir.mkdir(parents=True, exist_ok=True)
    for n, (off, _c, blob) in enumerate(streams):
        ext = ".x_t" if blob.startswith(b"PS") else (
            ".bmp" if blob[:2] == b"BM" else ".bin")
        (out_dir / f"raw{n:03d}_0x{off:08x}{ext}").write_bytes(blob)
    print(f"\nWrote {len(streams)} streams to {out_dir}/")
