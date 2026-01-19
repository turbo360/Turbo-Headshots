# Turbo Headshots

Headshot registration kiosk app for tethered photography with Panasonic LUMIX cameras.

## Requirements

- macOS 10.15+
- Node.js 18+ (https://nodejs.org)
- LUMIX Tether app (free from Panasonic)
- Xcode Command Line Tools (for code signing)

## Building

### Easy Method
Double-click `BUILD - Double Click Me.command`

### Manual Method
```bash
npm install
npm run build
```

The build process will:
1. Build the Electron app
2. Sign with Developer ID certificate
3. Submit to Apple for notarization
4. Staple the notarization ticket

**Note:** Notarization can take 2-10 minutes depending on Apple's servers.

## Code Signing Requirements

The app is configured to sign with:
- Team ID: ETURVK9WSA
- Identity: Developer ID Application

Make sure you have the "Developer ID Application" certificate installed in your Keychain. Check with:
```bash
security find-identity -v -p codesigning
```

## Development

Run without building:
```bash
npm start
```

## Output

After building, find the signed DMG in the `dist/` folder.

## Troubleshooting

### "No identity found"
Install your Developer ID Application certificate from the Apple Developer portal.

### Notarization fails
- Ensure you're connected to the internet
- Check that the app-specific password is valid
- Verify Team ID matches your certificate

### Camera not detected
- Set camera USB mode to "PC (Tether)"
- Use the USB cable that came with the camera
- Launch LUMIX Tether before starting a session
