#!/bin/bash

echo "================================"
echo "  Turbo Headshots Setup"
echo "================================"
echo ""

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found!"
    echo ""
    echo "Please install Node.js first:"
    echo "  1. Download from: https://nodejs.org"
    echo "  2. Or with Homebrew: brew install node"
    echo ""
    exit 1
fi

echo "✓ Node.js found: $(node -v)"

# Check for npm
if ! command -v npm &> /dev/null; then
    echo "❌ npm not found!"
    exit 1
fi

echo "✓ npm found: $(npm -v)"
echo ""

# RAW conversion tools — required for processing RAW files (NEF, ARW, CR3, RW2, etc.)
# when shooting RAW-only without an in-camera JPEG sidecar.
# exiftool extracts the embedded full-res JPEG (works for modern cameras incl. Nikon Z6_3).
# dcraw is a fallback for older cameras with no embedded preview.
if ! command -v exiftool &> /dev/null || ! command -v dcraw &> /dev/null; then
    if command -v brew &> /dev/null; then
        echo "Installing RAW conversion tools (exiftool, dcraw)..."
        brew install exiftool dcraw
    else
        echo "⚠️  Homebrew not found — skipping exiftool/dcraw install."
        echo "   If you shoot RAW-only, install manually: brew install exiftool dcraw"
    fi
else
    echo "✓ exiftool found: $(exiftool -ver)"
    echo "✓ dcraw found"
fi
echo ""

# Install dependencies
echo "Installing dependencies..."
npm install

if [ $? -eq 0 ]; then
    echo ""
    echo "================================"
    echo "  Setup Complete!"
    echo "================================"
    echo ""
    echo "To run the app:"
    echo "  npm start"
    echo ""
    echo "To build a standalone DMG:"
    echo "  npm run build"
    echo ""
else
    echo ""
    echo "❌ Installation failed. Check errors above."
    exit 1
fi
