#!/bin/bash
# Build TaskScore.app and upload to GitHub Releases
set -euo pipefail

cd "$(dirname "$0")"

# Check for gh CLI
if ! command -v gh &> /dev/null; then
    echo "Error: gh CLI is required. Install with: brew install gh"
    exit 1
fi

# Get version from argument or prompt
VERSION="${1:-}"
if [ -z "$VERSION" ]; then
    echo "Usage: ./release.sh <version>"
    echo "Example: ./release.sh 1.0.0"
    exit 1
fi

TAG="macos/v${VERSION}"
ZIP="TaskScore-${VERSION}-macos-arm64.zip"

# Check for uncommitted changes
if ! git diff --quiet HEAD; then
    echo "Error: You have uncommitted changes. Commit or stash them first."
    exit 1
fi

# Check tag doesn't already exist
if git rev-parse "$TAG" &> /dev/null 2>&1; then
    echo "Error: Tag $TAG already exists."
    exit 1
fi

# Build the app
echo "Building TaskScore.app (release)..."
./build-app.sh

# Zip the app bundle
echo "Creating $ZIP..."
ditto -c -k --keepParent TaskScore.app "$ZIP"

# Create GitHub release and upload
echo "Creating GitHub release $TAG..."
gh release create "$TAG" "$ZIP" \
    --title "TaskScore macOS $VERSION" \
    --notes "TaskScore macOS app v${VERSION} (Apple Silicon)"

# Clean up zip
rm "$ZIP"

echo ""
echo "Released: $TAG"
echo "View at: $(gh release view "$TAG" --json url -q .url)"
