#!/bin/bash
# run-local-analyzer.sh
# Script to run the local recording analyzer

echo "🚀 Starting Local Recording Analyzer..."
echo "======================================"
echo ""

# Check if recordings directory exists
RECORDINGS_DIR="/Users/snazir/zoom-grok-local-download/zoom_recordings"

if [ ! -d "$RECORDINGS_DIR" ]; then
    echo "❌ Error: Recordings directory not found!"
    echo "   Looking for: $RECORDINGS_DIR"
    echo ""
    echo "Please update the path in local-recording-analyzer.js"
    exit 1
fi

# Count recordings
RECORDING_COUNT=$(find "$RECORDINGS_DIR" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
echo "📁 Found $RECORDING_COUNT recording folders to analyze"
echo ""

# Run the analyzer
node local-recording-analyzer.js

# Check if analysis file was created
LATEST_ANALYSIS=$(ls -t recording-analysis-*.json 2>/dev/null | head -1)

if [ -n "$LATEST_ANALYSIS" ]; then
    echo ""
    echo "✅ Analysis complete!"
    echo "📄 Results saved to: $LATEST_ANALYSIS"
    echo ""
    echo "You can view the detailed results with:"
    echo "   cat $LATEST_ANALYSIS | jq ."
else
    echo ""
    echo "⚠️  No analysis file was created. Check for errors above."
fi