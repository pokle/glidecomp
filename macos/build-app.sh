#!/bin/bash
# Build TaskScore.app bundle for local macOS distribution
set -euo pipefail

cd "$(dirname "$0")"

echo "Building release binary..."
swift build -c release

APP="TaskScore.app"
CONTENTS="$APP/Contents"
BINARY=".build/release/TaskScore"
RESOURCES_BUNDLE=$(find .build/release -name "TaskScore_TaskScore.bundle" -type d | head -1)

# Clean previous build
rm -rf "$APP"

# Create .app bundle structure
mkdir -p "$CONTENTS/MacOS"
mkdir -p "$CONTENTS/Resources"

# Copy binary
cp "$BINARY" "$CONTENTS/MacOS/TaskScore"

# Copy SPM resource bundle (contains sample flights, icon, etc.)
if [ -n "$RESOURCES_BUNDLE" ]; then
    cp -R "$RESOURCES_BUNDLE" "$CONTENTS/Resources/"
    echo "Bundled resources from $RESOURCES_BUNDLE"
fi

# Copy icon to standard location
if [ -f "TaskScore/Resources/AppIcon.icns" ]; then
    cp "TaskScore/Resources/AppIcon.icns" "$CONTENTS/Resources/AppIcon.icns"
fi

# Create Info.plist
cat > "$CONTENTS/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>TaskScore</string>
    <key>CFBundleIdentifier</key>
    <string>info.shonky.taskscore</string>
    <key>CFBundleName</key>
    <string>TaskScore</string>
    <key>CFBundleDisplayName</key>
    <string>TaskScore</string>
    <key>CFBundleVersion</key>
    <string>1.0</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>LSMinimumSystemVersion</key>
    <string>14.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSSupportsAutomaticTermination</key>
    <false/>
</dict>
</plist>
PLIST

echo ""
echo "Built $APP successfully."
echo "Run with: open $APP"
echo "Or copy to /Applications: cp -R $APP /Applications/"
