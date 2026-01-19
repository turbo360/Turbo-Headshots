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
