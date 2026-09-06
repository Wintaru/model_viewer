# Research scripts

Run order, and what each one settles.

| Script | Question it answers |
| --- | --- |
| `probe-step.mjs` | Can OCCT-in-WebAssembly read real STEP AP242? (Yes — 32 of 33 NIST files.) |
| `probe-sldprt.py` | Is a SLDPRT file opaque? (No — entropy profile plus signature scan.) |
| `scan-deflate.py` | Where are the compressed streams? (22 raw-deflate streams, 97 percent of the file.) |
| `recurse-sldprt.py` | What is inside them? (Nested streams, including 4 Parasolid transmit streams.) |
| `d8-ground-truth.mjs` | Triangle count and bounding box per part, from the STEP twins. Writes `d8-truth.json`. |
| `d8-extract-cache.py` | Extract every nested stream once and cache to disk. Slow, so run it once. |
| `d8-final.py` | Does a cached display mesh exist? (Yes.) |
| `d8-analyze.py` | Same analysis against one directory of streams. |
| `d14-marker-scan.py` | Can the container's real structure be read directly, instead of scanning every byte for a compressed stream? (Yes — a documented open-source reader's chunk format, validated against every sample file: 2-95ms instead of 45-60s to several minutes.) |

## Run the control first

`d8-final.py --control` checks the detector against a real binary STL with
225,706 triangles before you trust any result from it.

This is not optional politeness. Two earlier versions of the mesh detector
reported "no mesh found", and both were wrong: the run-length threshold assumed
packed vertex arrays, and pooled byte alignments let garbage floats through.
The control caught both. A detector that has never found anything has not been
tested.

Those two broken versions were deleted rather than kept, so that nobody runs
one and believes its answer.

## Environment

`d8-final.py` and `d8-analyze.py` need numpy. The rest use only the standard
library. Node scripts need `npm install` first.
