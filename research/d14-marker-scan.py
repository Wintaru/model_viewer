#!/usr/bin/env python3
"""D14 — read a modern SolidWorks file's real container structure directly,
instead of the blind byte-by-byte inflate scan d9-decode.py's own driver
(and the shipped src/utility/SolidWorksContainerUtil.ts, before D14) used.

WAYFINDER.md's D13 found no published spec exists for this container
format. This is a from-scratch port of the closest working prior art:
openswx's ParseModernFormat (libopenswx/src/internal/modern_parser.cc, MIT,
github.com/schwitters/openswx) — read directly from its source via `gh api`,
not taken secondhand from its README.

Chunk layout (chunk starts 4 bytes before the marker):

    byte 0x00   4 bytes   file-specific, not used here
    byte 0x04   6 bytes   marker: 14 00 06 00 08 00
    byte 0x0a   1 byte    section type, not used here
    byte 0x0b   3 bytes   file-specific, not used here
    byte 0x0e   u32 LE    f1 -- >= 65536 means this chunk carries inline data
    byte 0x12   u32 LE    compressed size
    byte 0x16   u32 LE    uncompressed size
    byte 0x1a   u32 LE    stream name length, in bytes
    byte 0x1e   variable  the name, ROL-ciphered (key = byte 7 of the file)
    ...         variable  raw-deflate compressed data (inline chunks only)

Validated against all 11 NIST SLDPRT fixtures this repo ships (see
research/README.md) plus real customer SLDPRT/SLDDRW files (DECISIONS.md's
D14 entry, gitignored, not run by this script's own committed defaults):
every one parses in 2-95 milliseconds and lands its tessellation cache in
exactly one chunk -- named "Contents/DisplayLists" for a part,
"Contents/VBLists" for a drawing -- versus 45-60 seconds (SLDPRT) to several
minutes or an outright hang (SLDDRW) for the scan this replaces.

Usage: d14-marker-scan.py <file.SLDPRT|file.SLDDRW> [more files...]
"""
import pathlib
import sys
import time
import zlib

MARKER = bytes([0x14, 0x00, 0x06, 0x00, 0x08, 0x00])
CHUNK_HEADER_SIZE = 0x1E
MAX_NAME_SIZE = 512
# Matches SolidWorksContainerUtil.ts's MAX_UNCOMPRESSED_BYTES.
MAX_UNCOMPRESSED_SIZE = 512 * 1024 * 1024
INLINE_F1_THRESHOLD = 65536
TESS_DATA_MAGIC = b"TessData"


def rol_byte(b: int, shift: int) -> int:
    shift &= 7
    if shift == 0:
        return b
    return ((b << shift) | (b >> (8 - shift))) & 0xFF


def rol_decode(data: bytes, key: int) -> bytes:
    return bytes(rol_byte(b, key) for b in data)


def is_valid_stream_name(name_bytes: bytes) -> bool:
    return len(name_bytes) > 0 and all(0x20 <= b < 0x80 for b in name_bytes)


def u32(data: bytes, offset: int) -> int:
    if offset + 4 > len(data):
        return 0
    return int.from_bytes(data[offset : offset + 4], "little")


def parse_modern_format(data: bytes):
    """Yields (name, chunk_start, compressed_size, uncompressed_size,
    decompressed_or_None) for every inline chunk found."""
    if len(data) < 8:
        return
    key = data[7]
    search_pos = 0
    n = len(data)
    while True:
        marker_pos = data.find(MARKER, search_pos)
        if marker_pos == -1:
            break
        if marker_pos < 4:
            search_pos = marker_pos + 1
            continue
        si = marker_pos - 4
        if si + CHUNK_HEADER_SIZE > n:
            search_pos = marker_pos + 1
            continue
        f1 = u32(data, si + 0x0E)
        csz = u32(data, si + 0x12)
        usz = u32(data, si + 0x16)
        nsz = u32(data, si + 0x1A)
        # Caps the declared *uncompressed* size, matching the shipped
        # src/utility/SolidWorksContainerUtil.ts -- not compressed size,
        # since that's what actually bounds the memory a decompress call
        # can allocate.
        if nsz > MAX_NAME_SIZE or usz > MAX_UNCOMPRESSED_SIZE:
            search_pos = marker_pos + 1
            continue
        name_start = si + CHUNK_HEADER_SIZE
        name_end = name_start + nsz
        if name_end > n:
            search_pos = marker_pos + 1
            continue
        raw_name = rol_decode(data[name_start:name_end], key)
        if not is_valid_stream_name(raw_name):
            search_pos = marker_pos + 1
            continue
        name = raw_name.decode("ascii", "replace")
        is_inline = f1 >= INLINE_F1_THRESHOLD
        if not is_inline or csz == 0:
            search_pos = marker_pos + len(MARKER)
            continue
        data_start = name_end
        data_end = data_start + csz
        if data_end > n:
            search_pos = marker_pos + 1
            continue
        try:
            decompressed = zlib.decompressobj(-15).decompress(
                data[data_start:data_end], usz
            )
        except zlib.error:
            decompressed = None
        if decompressed is None or len(decompressed) != usz:
            # Matches the shipped TS: retreat by one byte rather than
            # trusting the same unverified header's csz to skip forward.
            search_pos = marker_pos + 1
            continue
        yield (name, si, csz, usz, decompressed)
        search_pos = data_end


def scan(path: pathlib.Path) -> None:
    data = path.read_bytes()
    start = time.time()
    chunks = list(parse_modern_format(data))
    elapsed = time.time() - start
    tess_chunks = [c for c in chunks if c[4] is not None and TESS_DATA_MAGIC in c[4]]
    print(
        f"{path.name}: {len(data):,} bytes, {elapsed * 1000:.1f}ms, "
        f"{len(chunks)} chunk(s), {len(tess_chunks)} containing TessData"
    )
    for name, si, csz, usz, decompressed in chunks:
        has_tess = decompressed is not None and TESS_DATA_MAGIC in decompressed
        dec_len = len(decompressed) if decompressed is not None else -1
        marker = " <-- TessData" if has_tess else ""
        print(
            f"    {name!r:40s} chunk_start=0x{si:08x} csz={csz:>10,} "
            f"usz={usz:>10,} decompressed={dec_len:>10,}{marker}"
        )


if len(sys.argv) < 2:
    print(__doc__)
    sys.exit(1)
for arg in sys.argv[1:]:
    p = pathlib.Path(arg)
    if p.exists():
        scan(p)
    else:
        print(f"not found: {arg}")
