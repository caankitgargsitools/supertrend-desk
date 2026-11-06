#!/usr/bin/env bash
# AnkGenie Android app (6 Nov 2026, Papa): a WebView wrapper around https://supertrend-desk.vercel.app/ (the portal is
# loaded live, so the app needs rebuilding only for its own changes). Built without the Android SDK, which this cloud
# box can't download: Ubuntu's aapt / dalvik-exchange / zipalign / apksigner and android.jar (API 33) from GitHub.
#   apt-get install -y aapt zipalign apksigner dalvik-exchange
#   curl -L -o android.jar https://raw.githubusercontent.com/Sable/android-platforms/master/android-33/android.jar
# Usage: android/build.sh <android.jar> <keystore.jks> <out.apk>   (keystore password in $KP; alias "ankgenie").
# Keep the same keystore for updates, or phones must uninstall the old app first.
set -euo pipefail
J=$1 KS=$2 OUT=$3 D=$(cd "$(dirname "$0")" && pwd) W=$(mktemp -d)
mkdir -p "$W/gen" "$W/obj"
aapt package -f -m -M "$D/AndroidManifest.xml" -S "$D/res" -I "$J" -J "$W/gen" -F "$W/unsigned.apk"
javac -source 8 -target 8 -bootclasspath "$J" -classpath "$J" -d "$W/obj" "$W"/gen/com/ankgenie/app/R.java "$D"/src/com/ankgenie/app/*.java
dalvik-exchange --dex --output="$W/classes.dex" "$W/obj"
(cd "$W" && aapt add unsigned.apk classes.dex >/dev/null)
zipalign -f 4 "$W/unsigned.apk" "$W/aligned.apk"
apksigner sign --ks "$KS" --ks-key-alias ankgenie --ks-pass env:KP --min-sdk-version 21 --out "$OUT" "$W/aligned.apk"
apksigner verify "$OUT" && echo "built $OUT"
