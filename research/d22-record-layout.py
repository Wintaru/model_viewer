#!/usr/bin/env python3
"""D22 step 3 -- measure record sizes by aligning on class declarations, using
the small files to read the big ones.

The breakthrough here is which file to look at. A drawing's Contents/Definition
chunk runs to 786 KB and declares 132 classes, and every structural route into
it failed (see WAYFINDER.md's D22): drawings share only a 224-byte common
prefix, and 87 of them produce 86 distinct class sequences, so nothing aligns.

A *part* has a Contents/Definition chunk too, and it is 5,440 bytes with six
classes. Same container, same MFC framing, one seventy-seventh the size. And
those six classes are exactly the last six a drawing declares, so whatever is
learned in the small file applies directly to the big one.

Parts do align, where drawings do not: 53 of 62 share one class sequence. That
makes the gap between consecutive class declarations measurable across a real
corpus, and a gap that never changes is a fixed-size record.

WHAT THIS FOUND

    moANSI_c: FF FF | schema 1 | name length 8 | "moANSI_c" | u32
              14 bytes of declaration, a 4-byte body, 18 bytes in total.

Confirmed across **186 files of three different kinds** -- 62 parts, 36
assemblies and 88 drawings -- with the gap to the next class declaration
exactly 18 bytes in every single one, and the body always the u32 value 7.
That is the first completely decoded record in this format, and it transfers
between file types.

Running it over the whole corpus reports **73 classes with a fixed record
size**, including moDrawing_c (an empty body, so a pure marker), moHeader_c
(157 bytes) and the whole family of unit descriptors, which sit at 62 or 64
bytes each. moBomInfoMgr_c is fixed at 38 bytes across every part and
assembly but varies in drawings, which carry BOM tables that a part does not.

WHAT THIS DOES NOT SHOW

A gap that never changes is strong evidence of a fixed-size record, and it is
not proof. This corpus is one company's template, so a variable-length record
whose content happens to be identical everywhere would look the same. moANSI_c
is the solid one, because its 18 bytes hold across three different file types
rather than across one template. Treat a class seen only in drawings as
likely, not settled.

The body of moANSI_c holds 7 in all 186 files. So its size and type are
confirmed and its *meaning* is not: this corpus is one company using one
drafting standard, so the field never varies. Reading it as a standards
selector is inference. Same limit as the sheet size in d22-value-locate.py.

CONFIDENTIALITY

This reports class names, byte offsets, gap sizes and small fixed-size record
bodies. Record bodies are printed ONLY when the same value appears in many
files, which makes it a property of the format rather than of any drawing.
Never widen this to print a body that varies between files: a per-file value
is that customer's data.

Usage: d22-record-layout.py <file-or-directory> [more...]
       Give it a directory and it reads every SolidWorks file underneath.
"""

import collections
import importlib.util
import pathlib
import struct
import sys

_PROBE = pathlib.Path(__file__).with_name("d22-definition-probe.py")
_spec = importlib.util.spec_from_file_location("d22_probe", _PROBE)
probe = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(probe)

SUFFIXES = (".SLDPRT", ".SLDASM", ".SLDDRW")
CLASS_TAG_BYTES = 6  # FF FF, schema u16, name length u16
# Only print a record body seen in at least this many files. Below it, a body
# is one drawing's content rather than a property of the format.
MIN_FILES_TO_PRINT_A_BODY = 5
# A class seen in one file trivially has one gap. Below this many files, a
# constant gap is a sample size of one, not a fixed-size record.
MIN_FILES_TO_CALL_A_GAP_FIXED = 5
MAX_BODY_BYTES = 8


def declarations(path: pathlib.Path) -> list[tuple[int, str]]:
    """Every class declaration in this file's Definition chunk, in order."""
    chunk = next(
        (
            payload
            for name, payload in probe.parse_modern_format(path.read_bytes())
            if name == probe.TARGET_CHUNK and payload is not None
        ),
        None,
    )
    if chunk is None:
        return []
    found = [
        (offset - CLASS_TAG_BYTES, run.decode("ascii"))
        for offset, run in probe.ascii_runs(chunk)
        if probe.IDENTIFIER_RE.match(run)
    ]
    found.sort()
    return found


def gather(paths: list[pathlib.Path]) -> None:
    by_kind = collections.defaultdict(list)
    for path in paths:
        by_kind[path.suffix.upper()].append(path)

    gaps = collections.defaultdict(collections.Counter)
    bodies = collections.defaultdict(collections.Counter)
    counted = collections.Counter()

    for suffix, files in sorted(by_kind.items()):
        for path in files:
            found = declarations(path)
            if not found:
                continue
            counted[suffix] += 1
            chunk = next(
                payload
                for name, payload in probe.parse_modern_format(path.read_bytes())
                if name == probe.TARGET_CHUNK and payload is not None
            )
            for (start, name), (next_start, _) in zip(found, found[1:]):
                gap = next_start - start
                gaps[name][gap] += 1
                body_size = gap - CLASS_TAG_BYTES - len(name)
                if 0 < body_size <= MAX_BODY_BYTES:
                    body_start = start + CLASS_TAG_BYTES + len(name)
                    bodies[name][chunk[body_start : body_start + body_size].hex()] += 1

    print(f"read {sum(counted.values())} files: {dict(counted)}\n")
    print("class declarations, and the gap to the next one:")
    for name, seen in sorted(gaps.items(), key=lambda kv: -sum(kv[1].values())):
        total = sum(seen.values())
        gap = next(iter(seen))
        body_size = gap - CLASS_TAG_BYTES - len(name)
        if len(seen) > 1:
            note = f"varies, {len(seen)} distinct gaps"
        elif total < MIN_FILES_TO_CALL_A_GAP_FIXED:
            # One file always has one gap. That is not evidence of anything.
            note = f"{gap} bytes here, too few files to call it fixed"
        else:
            note = f"FIXED {gap} bytes, so a {body_size}-byte body"
        print(f"    {name:<26} {total:>4} files   {note}")

    print("\nfixed record bodies, printed only where many files agree:")
    printed = False
    for name, seen in sorted(bodies.items()):
        for value, count in seen.most_common():
            if count < MIN_FILES_TO_PRINT_A_BODY or len(seen) != 1:
                continue
            printed = True
            as_int = (
                struct.unpack("<I", bytes.fromhex(value))[0]
                if len(value) == 8
                else None
            )
            reading = f" = u32 {as_int}" if as_int is not None else ""
            print(f"    {name:<26} {value}{reading}   in all {count} files")
    if not printed:
        print("    none")


def collect(argument: str) -> list[pathlib.Path]:
    target = pathlib.Path(argument)
    if target.is_dir():
        return [
            p
            for p in sorted(target.rglob("*"))
            if p.suffix.upper() in SUFFIXES and not p.name.startswith("~$")
        ]
    return [target] if target.exists() else []


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    paths: list[pathlib.Path] = []
    for argument in sys.argv[1:]:
        found = collect(argument)
        if not found:
            print(f"nothing to read at: {argument}")
        paths.extend(found)
    if paths:
        gather(paths)


if __name__ == "__main__":
    main()
