#!/usr/bin/env bash
# Build the Swipium persistent UI dumper into a dex jar runnable with app_process.
# Needs a JDK (javac 11+) and the Android SDK (platforms/android-<N>/android.jar + build-tools d8).
# Output: android-agent/prebuilt/swipium-dumper.jar
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
API="${SWIPIUM_AGENT_API:-$(ls "$SDK/platforms" | sed -n 's/^android-\([0-9]*\)$/\1/p' | sort -n | tail -1)}"
ANDROID_JAR="$SDK/platforms/android-$API/android.jar"
BT="${SWIPIUM_AGENT_BUILD_TOOLS:-$(ls "$SDK/build-tools" | sort -V | tail -1)}"
D8="$SDK/build-tools/$BT/d8"
[ -f "$ANDROID_JAR" ] || { echo "android.jar not found: $ANDROID_JAR" >&2; exit 1; }
[ -x "$D8" ] || { echo "d8 not found: $D8" >&2; exit 1; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
javac --release 11 -cp "$ANDROID_JAR" -d "$TMP/classes" $(find "$HERE/src" -name '*.java')
(cd "$TMP/classes" && jar cf "$TMP/classes.jar" .)
mkdir -p "$HERE/prebuilt"
"$D8" --release --min-api 26 --lib "$ANDROID_JAR" --output "$HERE/prebuilt/swipium-dumper.jar" "$TMP/classes.jar"
echo "built $HERE/prebuilt/swipium-dumper.jar (android-$API, build-tools $BT)"
