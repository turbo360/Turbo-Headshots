#!/bin/bash

# Turbo Headshots Build Script
# Double-click this file to build the app

cd "$(dirname "$0")"

echo "================================"
echo "  Turbo Headshots Build Script"
echo "================================"
echo ""

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js is not installed."
    echo ""
    echo "Please install Node.js from: https://nodejs.org"
    echo "Download the LTS version and run the installer."
    echo ""
    read -p "Press Enter to exit..."
    exit 1
fi

echo "Node.js version: $(node --version)"
echo "npm version: $(npm --version)"
echo ""

# Check for Xcode command line tools (needed for signing)
if ! xcode-select -p &> /dev/null; then
    echo "WARNING: Xcode Command Line Tools not found."
    echo "Installing... (you may need to click Install in the popup)"
    xcode-select --install
    echo ""
    read -p "After installation completes, press Enter to continue..."
fi

# Install dependencies
echo "Installing dependencies..."
npm install

if [ $? -ne 0 ]; then
    echo ""
    echo "ERROR: npm install failed."
    read -p "Press Enter to exit..."
    exit 1
fi

echo ""
echo "Building signed and notarized app..."
echo "(This may take several minutes for notarization)"
echo ""

npm run build

if [ $? -eq 0 ]; then
    echo ""
    echo "================================"
    echo "  BUILD SUCCESSFUL!"
    echo "================================"
    echo ""
    echo "Your signed app is in the 'dist' folder."
    echo "Opening folder..."
    open dist/
else
    echo ""
    echo "BUILD FAILED - Check errors above."
fi

echo ""
read -p "Press Enter to exit..."
