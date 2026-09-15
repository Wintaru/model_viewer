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

The sheet-size half of the search needs no PDF at all: a drawing sheet is one
of a handful of standard sizes, so those values are known in advance. That
found the same thing in all 87 real drawings -- sheet height and width as two
float64 in metres, eight bytes apart, height first -- with decoy sizes never
matching. The region around that pair reads as recognisable standard
constants rather than arbitrary numbers.

Every one of those drawings is ANSI B at the same scale, because they are one
company's template, so at first this could not tell "the sheet size field is
here" apart from "a constant that equals the sheet size is here". An
invariance control settles it without needing a second sheet size. A
coincidental bit pattern turns up about as often per byte in every file, so
its count rises with the size of the chunk. Across all 88 drawings the chunk
grows 27 times over, from 768 KB to 20.8 MB, and the counts do not move at
all: 3 height hits, 2 width hits and 2 adjacent pairs in every single file.
A field of the sheet behaves that way. Random data cannot.

What that still does not fix is which field means what. Height before width is
the natural read of an ANSI B sheet, and the neighbouring values have the
shape of a scale and four margins, but both remain interpretation. One drawing
on a different sheet size would confirm the lot in a single run.

Usage: d22-value-locate.py <file.SLDDRW> [more files...]
       A PDF of the same name beside it enables the extra sheet-number search.
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

# Standard drawing sheet sizes, width and height in inches. These need no PDF,
# so this half of the search works on any drawing. A sheet size is a value the
# file must hold somewhere, and it is not customer data, which makes it the
# cleanest possible anchor.
SHEET_SIZES_INCHES = {
    "ANSI A": (11.0, 8.5),
    "ANSI B": (17.0, 11.0),
    "ANSI C": (22.0, 17.0),
    "ANSI D": (34.0, 22.0),
    "ANSI E": (44.0, 34.0),
    "ISO A4": (11.693, 8.268),
    "ISO A3": (16.535, 11.693),
    "ISO A2": (23.386, 16.535),
}
# Sizes no standard uses. If one of these ever matches, the search is finding
# coincidences and its results mean nothing.
DECOY_SIZES_INCHES = {
    "decoy 19x13": (19.0, 13.0),
    "decoy 12.2x7.5": (12.2, 7.5),
    "decoy 30.6x21.9": (30.6, 21.9),
}
# Values worth recognising near a located sheet record. All are standard, so
# none of them is customer data.
NAMED_CONSTANTS = {
    1.0: "1",
    2.0: "2",
    4.0: "4",
    0.5: "1/2",
    0.25: "1/4",
    0.125: "1/8",
    0.0254: "1 inch",
    0.0127: "half an inch",
    0.00635: "quarter of an inch",
}
SHEET_WINDOW = 256
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
    """Every decimal number printed on the sheet, deduplicated and sorted.

    Empty when no PDF sits beside the drawing. The sheet-size search below
    needs no PDF, so a drawing without one is still worth examining.
    """
    if not pdf.exists():
        return []
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


def exact_offsets_of(chunk: bytes, target: float) -> list[int]:
    """Every byte offset holding exactly this float64, by bit pattern.

    A value written by the same arithmetic that produced it here -- 17 inches
    times 0.0254, say -- lands on the identical 8 bytes, so searching for
    those bytes is exact rather than approximate. It is also far faster:
    bytes.find runs in C over the whole buffer, where reading and comparing a
    float at every offset in Python takes minutes on a 20 MB chunk. Use this
    for values known in advance, and offsets_of below for a value read off a
    PDF, which may have been rounded for printing and so needs a tolerance.
    """
    pattern = struct.pack("<d", target)
    found = []
    position = chunk.find(pattern)
    while position != -1:
        found.append(position)
        position = chunk.find(pattern, position + 1)
    return found


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


def sheet_record(chunk: bytes) -> None:
    """Find a sheet's height and width, then read what sits around them.

    Height and width are stored as two float64 in metres, eight bytes apart,
    height first. Finding that pair locates a fixed-layout region, and the
    values nearby are recognisable standard constants rather than arbitrary
    numbers. Decoy sizes run alongside for the same reason as everywhere else
    in this script.
    """
    for label, sizes in [
        ("sheet size", SHEET_SIZES_INCHES),
        ("decoy control", DECOY_SIZES_INCHES),
    ]:
        for name, (width_in, height_in) in sizes.items():
            width, height = width_in * INCHES_TO_METRES, height_in * INCHES_TO_METRES
            heights = exact_offsets_of(chunk, height)
            widths = set(exact_offsets_of(chunk, width))
            pairs = [o for o in heights if o + 8 in widths]
            if not pairs:
                continue
            print(f"    {label}: {name}, {len(pairs)} adjacent height+width pair(s)")
            if label == "decoy control":
                continue
            base = min(pairs)
            print(f"        reading the region around 0x{base:06x}:")
            for offset in range(
                max(0, base - SHEET_WINDOW),
                min(len(chunk) - 8, base + SHEET_WINDOW),
            ):
                value = struct.unpack_from("<d", chunk, offset)[0]
                for known, described in NAMED_CONSTANTS.items():
                    if abs(value - known) < abs(known) * F64_TOLERANCE:
                        print(f"            {offset - base:>+5}  {described}")
                        break
                else:
                    if abs(value - height) < height * F64_TOLERANCE:
                        print(f"            {offset - base:>+5}  sheet height")
                    elif abs(value - width) < width * F64_TOLERANCE:
                        print(f"            {offset - base:>+5}  sheet width")


def examine(path: pathlib.Path) -> None:
    pdf = path.with_suffix(".pdf")
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
    # Building the float index reads every byte offset in Python, which costs
    # minutes on a 20 MB chunk. Skip it when there is nothing to look up.
    f64, f32 = float_index(chunk) if numbers else ([], [])
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

    sheet_record(chunk)

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


def invariance_report(paths: list[pathlib.Path]) -> None:
    """Do the sheet-size hits stay put as the drawing grows?

    This is the control that decides whether the sheet record is real. A
    coincidental bit pattern turns up about as often per byte in every file,
    so its count rises with the size of the chunk. A field of the sheet record
    appears once per sheet however much else the drawing holds. Run this over
    a corpus and read the spread: a flat count across a wide range of sizes
    cannot be coincidence.
    """
    width = SHEET_SIZES_INCHES["ANSI B"][0] * INCHES_TO_METRES
    height = SHEET_SIZES_INCHES["ANSI B"][1] * INCHES_TO_METRES
    rows = []
    for path in paths:
        chunk = next(
            (
                payload
                for name, payload in probe.parse_modern_format(path.read_bytes())
                if name == probe.TARGET_CHUNK and payload is not None
            ),
            None,
        )
        if chunk is None:
            continue
        heights = exact_offsets_of(chunk, height)
        widths = set(exact_offsets_of(chunk, width))
        pairs = sum(1 for offset in heights if offset + 8 in widths)
        rows.append((len(chunk), len(heights), pairs))
    if len(rows) < 2:
        return
    sizes = [row[0] for row in rows]
    print(f"\ninvariance control over {len(rows)} drawings")
    print(
        f"    chunk sizes span {min(sizes):,} to {max(sizes):,} bytes, "
        f"a {max(sizes) / min(sizes):.0f} times range"
    )
    print(f"    height-value hits per drawing: {sorted({row[1] for row in rows})}")
    print(f"    adjacent height and width pairs: {sorted({row[2] for row in rows})}")
    print(
        "    One value in each of those two lines means the count does not grow"
        "\n    with the drawing. These are fields of the sheet, not bit patterns"
        "\n    found by chance."
    )


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    examined = []
    for argument in sys.argv[1:]:
        target = pathlib.Path(argument)
        if target.exists():
            examine(target)
            examined.append(target)
        else:
            print(f"not found: {argument}")
    invariance_report(examined)


if __name__ == "__main__":
    main()
