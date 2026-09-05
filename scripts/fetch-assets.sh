#!/usr/bin/env bash
# Download the test corpus. About 75 MB, and it is not stored in git.
#
# The NIST files are the important ones: the same 11 parts exist as both native
# SolidWorks and STEP, so a decoder can be checked against independent ground
# truth. NIST states they may be used without restriction.
#
# Usage: scripts/fetch-assets.sh
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
assets="$root/assets"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$assets"/{step,solidworks,mesh,gltf,2d}

have() { [ -n "$(ls -A "$1" 2>/dev/null)" ]; }

# --- NIST MBE PMI test corpus -------------------------------------------------
if have "$assets/solidworks" && have "$assets/step"; then
  echo "NIST corpus already present, skipping"
else
  echo "Downloading NIST CAD models (58 MB)..."
  curl -fsSL -o "$tmp/nist-cad.zip" \
    "https://www.nist.gov/system/files/documents/noindex/2024/05/07/NIST-FTC-CTC-PMI-CAD-models.zip"
  echo "Downloading NIST STEP files (13 MB)..."
  curl -fsSL -o "$tmp/nist-step.zip" \
    "https://www.nist.gov/system/files/documents/noindex/2024/06/19/NIST-PMI-STEP-Files.zip"

  unzip -qo "$tmp/nist-cad.zip"  -d "$tmp/cad"
  unzip -qo "$tmp/nist-step.zip" -d "$tmp/step"

  find "$tmp/cad"  -iname '*.sldprt' -exec cp {} "$assets/solidworks/" \;
  find "$tmp/cad"  -iname '*.stp'    -exec cp {} "$assets/step/" \;
  find "$tmp/step" -iname '*.stp'    -exec cp {} "$assets/step/" \;
  echo "  SLDPRT: $(ls -1 "$assets/solidworks" | wc -l | tr -d ' ') files"
  echo "  STEP:   $(ls -1 "$assets/step" | wc -l | tr -d ' ') files"
fi

# --- Mesh and glTF reference models -------------------------------------------
[ -f "$assets/mesh/3DBenchy.stl" ] || {
  echo "Downloading 3DBenchy.stl..."
  curl -fsSL -o "$assets/mesh/3DBenchy.stl" \
    "https://raw.githubusercontent.com/CreativeTools/3DBenchy/master/Single-part/3DBenchy.stl"
}

[ -f "$assets/gltf/DamagedHelmet.glb" ] || {
  echo "Downloading DamagedHelmet.glb..."
  curl -fsSL -o "$assets/gltf/DamagedHelmet.glb" \
    "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/DamagedHelmet/glTF-Binary/DamagedHelmet.glb"
}

echo
echo "Done. $(du -sh "$assets" | cut -f1) in $assets"
echo "See assets/README.md for provenance and licensing."
