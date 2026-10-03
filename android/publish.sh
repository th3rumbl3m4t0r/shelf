#!/bin/bash
# Builds the signed release and puts it where serve.py (shelf-apk.service)
# serves it, as shelf-<version>.apk; the page links only the newest one, so
# Obtainium finds a single APK there.
set -euo pipefail
cd "$(dirname "$0")"
out=${1:-/srv/shelf-apk}
export JAVA_HOME=${JAVA_HOME:-/usr/lib/jvm/java-21-openjdk} ANDROID_HOME=${ANDROID_HOME:-/opt/android-sdk}
export SHELF_KEYSTORE=${SHELF_KEYSTORE:-/root/.shelf-android/keystore.properties}
/opt/gradle-8.9/bin/gradle --offline -q --no-daemon assembleRelease
apk=app/build/outputs/apk/release/app-release.apk
"$ANDROID_HOME"/build-tools/34.0.0/apksigner verify "$apk"
version=$("$ANDROID_HOME"/build-tools/34.0.0/aapt dump badging "$apk" | sed -n "s/.*versionName='\([^']*\)'.*/\1/p")
install -d -m 755 "$out"
install -m 644 "$apk" "$out/shelf-$version.apk"
cat >"$out/index.html" <<EOF
<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>shelf for android</title>
<body style="background:#17110c;color:#ddd2c4;font:16px sans-serif;padding:1em 2em">
<h1>shelf for android</h1>
<p><a style="color:#7bbf6a" href="shelf-$version.apk">shelf $version</a> ($(date +%F))</p>
<p>Obtainium: add this page's address as the app's source.</p>
EOF
echo "published shelf $version in $out"
