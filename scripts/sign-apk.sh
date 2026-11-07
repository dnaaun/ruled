#!/usr/bin/env bash
# Sign the release APK. Uses $KEYSTORE_B64 / $KEYSTORE_PASSWORD if provided (keep the same key
# for every release, or Android refuses to update the installed app); otherwise makes a local one.
set -euo pipefail
cd "$(dirname "$0")/.."
BT="$(ls -d "${ANDROID_HOME:-/opt/android-sdk}"/build-tools/* | sort -V | tail -1)"
KS="${KEYSTORE_PATH:-ruled-release.keystore}"
PASS="${KEYSTORE_PASSWORD:-ruled-local-key}"
if [ -n "${KEYSTORE_B64:-}" ]; then echo "$KEYSTORE_B64" | base64 -d > "$KS"; fi
if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -storepass "$PASS" -keypass "$PASS" -alias ruled \
    -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Ruled" >/dev/null
fi
UNSIGNED="$(ls src-tauri/gen/android/app/build/outputs/apk/universal/release/*-unsigned.apk | head -1)"
mkdir -p release
"$BT/zipalign" -f -p 4 "$UNSIGNED" release/aligned.apk
"$BT/apksigner" sign --ks "$KS" --ks-pass "pass:$PASS" --ks-key-alias ruled --out release/Ruled.apk release/aligned.apk
rm -f release/aligned.apk release/*.idsig
"$BT/apksigner" verify release/Ruled.apk && echo "Signed: release/Ruled.apk"
