#!/usr/bin/env python3
"""D22 step 2 -- locate real records in a drawing's Contents/Definition chunk
by searching for values whose true answer is already known.

Step 1 (d22-definition-probe.py) found the chunk names all of its own classes,
which suggested a parser was close. It is not. MFC's CArchive delegates each
object's body to that class's own Serialize method and never records an
object's length, so no reader can skip an object whose layout it does not
already know. One unknown class stops a sequential walk permanently.

This script takes the other route. Instead of walking the stream, it anchors
on values it can verify independently, then examines what surrounds them.

Ground truth comes from the PDF that ships beside each real drawing. Every
decimal number printed on the sheet is a number SolidWorks itself wrote, so
finding that exact number as a float in the chunk locates a real field. A
decoy control runs alongside: each true value is multiplied by a random
factor between 1.11 and 1.93 and searched for the same way. Real values hit
and decoys do not, which is what separates a located field from a coincidence.

Measured on two real drawings: 3 of 7 and 2 of 5 PDF numbers found as written,
4 of 7 and 1 of 5 found again after conversion from inches to metres, and
0 of 7 and 0 of 5 decoys found in any unit. No false positives at all.

Following one hit produced the first record structure seen in this chunk:
26 records at a fixed 612-byte stride, of which 423 of the 612 byte positions
hold the same value in every record. The varying positions include a long
`#.#.#.#.` run, which is the signature of UTF-16 text -- a fixed-width
description field. That array sits under moHoleWizardInfo_c, so it is hole
standards data rather than the views and dimensions this project actually
wants. It is a proof of the method, not the payload.

CONFIDENTIALITY -- read before changing the output.

The values this script searches for come from a customer's drawing and are
customer data. It prints byte offsets, strides, counts and hit or miss, and
it must never print a value, a string, or a byte from either the PDF or the
chunk. The layout map prints one character per byte position saying only
whether that position varies between records. Keep it that way.

Usage: d22-value-locate.py <file.SLDDRW> [more files...]
       Each drawing needs a PDF of the same name beside it.
"""

import bisect
import collections
import importlib.util
import pathlib
import random
import re
import struct
import subprocess
import sys

_PROBE = pathlib.Path(__file__).with_name("d22-definition-probe.py")
_spec = importlib.util.spec_from_file_location("d22_probe", _PROBE)
probe = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(probe)

DECIMAL_RE = re.compile(r"\d+\.\d+")
MIN_VALUE, MAX_VALUE = 0.001, 1000.0
INCHES_TO_METRES = 0.0254
F64_TOLERANCE = 1e-9
F32_TOLERANCE = 1e-6
DECOY_LOW, DECOY_HIGH = 1.11, 1.93
DECOY_SEED = 11
MIN_STRIDE_RUN = 4  # a stride is only a record array if it repeats this often
# A real record is a template: most of its bytes say the same thing in every
# instance, and only its fields vary. The genuine array found this way holds
# 423 constant positions out of 612, or 69 percent. A stride that matched by
# chance holds 15 out of 2,472, or 0.6 percent. Anything below this threshold
# is coincidence, not a record.
MIN_CONSTANT_FRACTION = 0.20


def pdf_numbers(pdf: pathlib.Path) -> list[float]:
    """Every decimal number printed on the sheet, deduplicated and sorted."""
    text = subprocess.run(
        ["pdftotext", "-q", str(pdf), "-"], capture_output=True, text=True
    ).stdout
    values = {float(t) for t in DECIMAL_RE.findall(text)}
    return sorted(v for v in values if MIN_VALUE < v < MAX_VALUE)


def float_index(chunk: bytes) -> tuple[list[float], list[float]]:
    """Every float64 and float32 in the chunk, at every byte offset, sorted.

    Sorted so a search becomes a bisect instead of a rescan. The stream is
    byte-packed, so a value can begin at any offset, not only a multiple of
    four -- reading only aligned offsets misses most of them.
    """
    f64 = sorted(
        v
        for o in range(len(chunk) - 8)
        for v in [struct.unpack_from("<d", chunk, o)[0]]
        if MIN_VALUE * 1e-3 < abs(v) < MAX_VALUE * 1e3
    )
    f32 = sorted(
        v
        for o in range(len(chunk) - 4)
        for v in [struct.unpack_from("<f", chunk, o)[0]]
        if MIN_VALUE * 1e-3 < abs(v) < MAX_VALUE * 1e3
    )
    return f64, f32


def present(sorted_values: list[float], target: float, tolerance: float) -> bool:
    lo = bisect.bisect_left(sorted_values, target * (1 - tolerance))
    hi = bisect.bisect_right(sorted_values, target * (1 + tolerance))
    return hi > lo


def offsets_of(chunk: bytes, target: float) -> list[int]:
    """Every byte offset holding this value, as float64 or float32."""
    found = []
    for o in range(len(chunk) - 8):
        if abs(struct.unpack_from("<d", chunk, o)[0] - target) < abs(
            target
        ) * F64_TOLERANCE:
            found.append(o)
    for o in range(len(chunk) - 4):
        if abs(struct.unpack_from("<f", chunk, o)[0] - target) < abs(
            target
        ) * F32_TOLERANCE:
            found.append(o)
    return sorted(found)


def dominant_stride(offsets: list[int]) -> tuple[int, int, int] | None:
    """The most common gap between hits, if it repeats often enough.

    A value that belongs to one field of a fixed-size record appears once per
    record, so the gaps between its offsets are all the record size. That is
    what makes a record array visible without knowing any class's layout.
    """
    if len(offsets) < MIN_STRIDE_RUN:
        return None
    gaps = collections.Counter(b - a for a, b in zip(offsets, offsets[1:]))
    stride, count = gaps.most_common(1)[0]
    if count + 1 < MIN_STRIDE_RUN:
        return None
    run_start = next(
        a for a, b in zip(offsets, offsets[1:]) if b - a == stride
    )
    return stride, count + 1, run_start


def layout_map(chunk: bytes, start: int, stride: int, count: int) -> str:
    """One character per byte of a record: '.' constant, '#' varies."""
    marks = []
    for k in range(stride):
        seen = {chunk[start + i * stride + k] for i in range(count)}
        marks.append("." if len(seen) == 1 else "#")
    return "".join(marks)


def examine(path: pathlib.Path) -> None:
    pdf = path.with_suffix(".pdf")
    if not pdf.exists():
        print(f"{path.suffix}: no PDF beside it, so no ground truth. Skipped.")
        return
    chunk = next(
        (
            payload
            for name, payload in probe.parse_modern_format(path.read_bytes())
            if name == probe.TARGET_CHUNK and payload is not None
        ),
        None,
    )
    if chunk is None:
        print(f"{path.suffix}: no readable {probe.TARGET_CHUNK} chunk")
        return

    numbers = pdf_numbers(pdf)
    f64, f32 = float_index(chunk)
    print(f"=== {path.suffix}, {probe.TARGET_CHUNK} {len(chunk):,} bytes")
    print(
        f"    {len(numbers)} decimal numbers on the sheet; "
        f"{len(f64):,} float64 and {len(f32):,} float32 candidates in range"
    )

    random.seed(DECOY_SEED)
    decoys = [v * random.uniform(DECOY_LOW, DECOY_HIGH) for v in numbers]
    for label, scale in [("as written", 1.0), ("inches to metres", INCHES_TO_METRES)]:
        real = sum(
            1
            for v in numbers
            if present(f64, v * scale, F64_TOLERANCE)
            or present(f32, v * scale, F32_TOLERANCE)
        )
        control = sum(
            1
            for v in decoys
            if present(f64, v * scale, F64_TOLERANCE)
            or present(f32, v * scale, F32_TOLERANCE)
        )
        print(
            f"    {label:<17}: {real:>3} of {len(numbers)} found | "
            f"decoy control {control:>3} of {len(decoys)}"
        )

    print("    record arrays found by following a located value:")
    reported = set()
    for index, value in enumerate(numbers):
        for scale in (1.0, INCHES_TO_METRES):
            run = dominant_stride(offsets_of(chunk, value * scale))
            if run is None:
                continue
            stride, count, start = run
            if (stride, count) in reported:
                continue
            marks = layout_map(chunk, start, stride, count)
            constant = marks.count(".")
            if constant < stride * MIN_CONSTANT_FRACTION:
                continue
            reported.add((stride, count))
            print(
                f"        sheet number #{index}: {count} records of {stride} "
                f"bytes at 0x{start:06x}; {constant} of {stride} byte "
                f"positions identical in every record"
            )
            for i in range(0, len(marks), 100):
                print(f"            +{i:<4} {marks[i : i + 100]}")
    if not reported:
        print("        none")


if len(sys.argv) < 2:
    print(__doc__)
    sys.exit(1)
for argument in sys.argv[1:]:
    target = pathlib.Path(argument)
    if target.exists():
        examine(target)
    else:
        print(f"not found: {argument}")
