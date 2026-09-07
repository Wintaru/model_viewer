#!/usr/bin/env python3
"""D22 step 1 -- characterise a SolidWorks drawing's Contents/Definition chunk.

WAYFINDER.md's D21 established that a drawing's decodable tessellation cache
(Contents/VBLists) holds the referenced *model's* geometry, not the drawing's,
and that the drawing's own content -- sheets, views, projected edges,
dimensions, the title block -- must therefore live in Contents/Definition:
786,808 bytes decompressed in a 215 KB drawing, against 10,166 bytes for the
same-named chunk in a part, with zero "4,8,2,N" tessellation headers on any
byte alignment.

This script does not decode that chunk. It answers the question that comes
first: does it have visible structure at all, or is the payload encoded again
underneath the container's deflate?

It does. The answer this script produces, against real drawings:

  * The chunk is plain, structured, uncompressed data. Entropy is 3.2 bits
    per byte, 189 of 193 windows fall below 6.0, and 63 percent of the bytes
    are 0x00. Nothing is encoded a second time.
  * It is a self-describing object stream. Every serialised class writes its
    own name in plaintext the first time it appears -- 132 distinct names in
    a small drawing, at ascending offsets, each exactly once.
  * The framing around each name is `FF FF`, then a u16 schema number, then
    a u16 name length, then the name. That matched 132 of 132 names, with no
    exceptions and no near misses. It is the layout Microsoft Foundation
    Classes uses for `CArchive`'s new-class tag, which fits: SolidWorks is a
    Windows MFC application.

The names are the drawing itself, not incidental bookkeeping: moView_c,
moLayer_c / moLayerMgr_c / moLayerMask_c, moDisplayDistanceDim_c and
moDimTolerance_c, moDisplayNote_c and moNoteData_c, moTitleBlockFeature_c,
moCompEdge_c and moEdgeRef_c, gcXhatch_c, moRevisionTable_c, bomTable_c.

What this does NOT establish, stated plainly so the next session does not
assume it: only the class-name framing is confirmed. Whether the rest of the
stream follows MFC's object tagging as well (`0x8000 | index` back-references
to an already-seen class, and object indices for already-serialised objects)
is untested. A naive scan for those tags finds nothing usable, because the
stream is byte-packed rather than aligned, so back-references cannot be found
by scanning at all. Confirming that half needs a real sequential walker that
reads the stream in order from offset 0. That is the next piece of work, and
it is what turns this from "the format is legible" into "the format decodes."

Reported: Shannon entropy whole-file and per window, a byte histogram summary,
the run-length profile of printable ASCII, an inventory of ASCII tokens that
match SolidWorks's own class-name convention, and the class-tag check above.

CONFIDENTIALITY -- read before changing the output.

Real drawings hold customer part numbers, folder paths, user names and title
block text in plaintext. This script must never print a string it read from
the file unless that string matches IDENTIFIER_RE below, which admits only
SolidWorks's own "<Name>_c" / "<Name>_e" type-name convention. Every other
ASCII run is counted and its length recorded, never its content. Do not
relax this to "print anything printable" while debugging. Add a new
whitelist pattern instead, and keep it anchored.

Usage: d22-definition-probe.py <file.SLDDRW> [more files...]
"""

import collections
import math
import pathlib
import re
import sys
import zlib

MARKER = bytes([0x14, 0x00, 0x06, 0x00, 0x08, 0x00])
CHUNK_HEADER_SIZE = 0x1E
MAX_NAME_SIZE = 512
MAX_UNCOMPRESSED_SIZE = 512 * 1024 * 1024
INLINE_F1_THRESHOLD = 65536

TARGET_CHUNK = "Contents/Definition"

# SolidWorks names its serialised types "<Something>_c" (the tessellation work
# in D8 keyed off exactly this: uoTempFaceTessData_c, uoTempBodyTessData_c).
# Anchored at both ends so a customer string that merely contains such a
# substring cannot print. See the confidentiality note above.
IDENTIFIER_RE = re.compile(rb"^[A-Za-z][A-Za-z0-9]{2,63}_[ce]$")

MIN_ASCII_RUN = 4
ENTROPY_WINDOW = 4096

# MFC CArchive writes a class it has not serialised before as this tag, then
# a u16 schema number, then a u16 name length, then the name bytes. A class it
# has already written becomes a short back-reference instead, which is why
# each name appears exactly once.
MFC_NEW_CLASS_TAG = 0xFFFF
CLASS_TAG_PREFIX_BYTES = 6  # tag u16 + schema u16 + name length u16


def rol_byte(byte: int, shift: int) -> int:
    shift &= 7
    return byte if shift == 0 else ((byte << shift) | (byte >> (8 - shift))) & 0xFF


def u32(data: bytes, offset: int) -> int:
    if offset + 4 > len(data):
        return 0
    return int.from_bytes(data[offset : offset + 4], "little")


def parse_modern_format(data: bytes):
    """Yields (name, decompressed_or_None) for every inline chunk.

    A trimmed copy of research/d14-marker-scan.py's parser. The duplication
    between research scripts is deliberate, so each stays runnable alone --
    see REVIEW-BACKLOG.md.
    """
    if len(data) < 8:
        return
    key = data[7]
    pos = 0
    while True:
        marker = data.find(MARKER, pos)
        if marker == -1:
            return
        if marker < 4:
            pos = marker + 1
            continue
        start = marker - 4
        f1 = u32(data, start + 0x0E)
        compressed_size = u32(data, start + 0x12)
        uncompressed_size = u32(data, start + 0x16)
        name_size = u32(data, start + 0x1A)
        if (
            name_size == 0
            or name_size > MAX_NAME_SIZE
            or uncompressed_size > MAX_UNCOMPRESSED_SIZE
        ):
            pos = marker + 1
            continue
        name_start = start + CHUNK_HEADER_SIZE
        raw_name = data[name_start : name_start + name_size]
        decoded_name = bytes(rol_byte(b, key) for b in raw_name)
        if not decoded_name or not all(0x20 <= b < 0x80 for b in decoded_name):
            pos = marker + 1
            continue
        payload = None
        if f1 >= INLINE_F1_THRESHOLD and compressed_size > 0:
            body = data[name_start + name_size :][:compressed_size]
            try:
                payload = zlib.decompressobj(-15).decompress(body, uncompressed_size)
            except zlib.error:
                payload = None
        yield decoded_name.decode("ascii"), payload
        pos = marker + 1


def entropy(buf: bytes) -> float:
    """Shannon entropy in bits per byte. 8.0 means indistinguishable from
    random, which is what compressed or encrypted data looks like."""
    if not buf:
        return 0.0
    counts = collections.Counter(buf)
    total = len(buf)
    return -sum(
        (n / total) * math.log2(n / total) for n in counts.values()
    )


def ascii_runs(buf: bytes):
    """Every run of >= MIN_ASCII_RUN printable bytes, as (offset, bytes)."""
    runs = []
    start = None
    for i, byte in enumerate(buf):
        if 0x20 <= byte < 0x7F:
            if start is None:
                start = i
        elif start is not None:
            if i - start >= MIN_ASCII_RUN:
                runs.append((start, buf[start:i]))
            start = None
    if start is not None and len(buf) - start >= MIN_ASCII_RUN:
        runs.append((start, buf[start:]))
    return runs


def describe(path: pathlib.Path) -> None:
    data = path.read_bytes()
    chunk = None
    for name, payload in parse_modern_format(data):
        if name == TARGET_CHUNK and payload is not None:
            chunk = payload
            break
    if chunk is None:
        print(f"{path.suffix}: no readable {TARGET_CHUNK} chunk")
        return

    print(f"=== {path.suffix}, container {len(data):,} bytes")
    print(f"    {TARGET_CHUNK}: {len(chunk):,} bytes decompressed")

    whole = entropy(chunk)
    windows = [
        entropy(chunk[i : i + ENTROPY_WINDOW])
        for i in range(0, len(chunk), ENTROPY_WINDOW)
    ]
    low = sum(1 for e in windows if e < 6.0)
    print(
        f"    entropy: {whole:.2f} bits/byte whole; "
        f"{len(windows)} windows of {ENTROPY_WINDOW}, "
        f"min {min(windows):.2f}, max {max(windows):.2f}, "
        f"{low} below 6.0"
    )

    counts = collections.Counter(chunk)
    zero_share = counts[0] / len(chunk)
    distinct = len(counts)
    print(
        f"    bytes: {distinct} distinct values, "
        f"0x00 is {zero_share * 100:.1f}% of the chunk"
    )

    runs = ascii_runs(chunk)
    identifiers = collections.Counter()
    other_lengths = collections.Counter()
    for _, run in runs:
        if IDENTIFIER_RE.match(run):
            identifiers[run.decode("ascii")] += 1
        else:
            other_lengths[len(run)] += 1
    other_total = sum(other_lengths.values())
    print(
        f"    ascii runs >= {MIN_ASCII_RUN}: {len(runs)} total, "
        f"{sum(identifiers.values())} match the type-name pattern, "
        f"{other_total} do not (content not printed)"
    )
    if other_total:
        longest = max(other_lengths)
        print(f"    non-matching run lengths: longest {longest} bytes")

    tagged, schemas = check_class_tags(chunk, runs)
    print(
        f"    class tags: {tagged} of {sum(identifiers.values())} names carry "
        f"'FFFF <schema> <length>' immediately before them; "
        f"schema numbers seen: {sorted(schemas)}"
    )
    for token, n in sorted(identifiers.items()):
        print(f"        {n:>3} x {token}")


def check_class_tags(chunk: bytes, runs) -> tuple[int, set[int]]:
    """How many type names are framed the way MFC writes a new class?

    Returns the count that match and the set of schema numbers seen. A name
    that matches here is not a string that happens to look like a type name --
    it is a class the stream declares, at a position the framing predicts.
    """
    matched = 0
    schemas: set[int] = set()
    for offset, run in runs:
        if not IDENTIFIER_RE.match(run):
            continue
        if offset < CLASS_TAG_PREFIX_BYTES:
            continue
        tag = int.from_bytes(chunk[offset - 6 : offset - 4], "little")
        schema = int.from_bytes(chunk[offset - 4 : offset - 2], "little")
        declared_length = int.from_bytes(chunk[offset - 2 : offset], "little")
        if tag == MFC_NEW_CLASS_TAG and declared_length == len(run):
            matched += 1
            schemas.add(schema)
    return matched, schemas


if len(sys.argv) < 2:
    print(__doc__)
    sys.exit(1)
for arg in sys.argv[1:]:
    target = pathlib.Path(arg)
    if target.exists():
        describe(target)
    else:
        print(f"not found: {arg}")
