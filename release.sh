#!/bin/bash
# Build every ForgeAI package: Mac (Apple Silicon + Intel, ad-hoc signed), Windows installers (x64 + arm64), Server edition.
# Installer/uninstaller .exe filenames carry the version (e.g. "Install ForgeAI 2.8.1 (x64).exe").
# The four distribution zips and SHA256SUMS keep canonical names because the hub serves them by those exact names.
set -e
cd /home/claude/aicore
VER=$(node -p "require('./app/package.json').version")
RC=/home/claude/apple-codesign-0.29.0-x86_64-unknown-linux-musl/rcodesign
rm -rf dist out; mkdir -p out
# Standalone uninstaller first. uninstaller.nsi outputs "Uninstall ForgeAI ${VER}.exe".
# A canonical copy (unversioned) is bundled inside the app and served by the hub for remote uninstall.
( cd win && makensis -V2 uninstaller.nsi >/tmp/nsis0.log 2>&1 )
cp "out/Uninstall ForgeAI ${VER}.exe" "app/deploy/Uninstall ForgeAI.exe"
node build.js
"$RC" sign "dist/ForgeAI-darwin-arm64/ForgeAI.app" >/tmp/sign1.log 2>&1
"$RC" sign "dist/ForgeAI-darwin-x64/ForgeAI.app" >/tmp/sign2.log 2>&1
mkdir -p "out/ForgeAI (Apple Silicon)" "out/ForgeAI (Intel)" "out/ForgeAI for Windows" "out/ForgeAI Server"
cp -R "dist/ForgeAI-darwin-arm64/ForgeAI.app" "out/ForgeAI (Apple Silicon)/"
cp -R "dist/ForgeAI-darwin-x64/ForgeAI.app" "out/ForgeAI (Intel)/"
( cd win && makensis -DARCH=x64 -DSRC=../dist/ForgeAI-win32-x64 installer.nsi >/tmp/nsis1.log 2>&1 && makensis -DARCH=arm64 -DSRC=../dist/ForgeAI-win32-arm64 installer.nsi >/tmp/nsis2.log 2>&1 )
mv out/Install*.exe "out/ForgeAI for Windows/"; cp "out/Uninstall ForgeAI ${VER}.exe" "out/ForgeAI for Windows/"
for d in "ForgeAI (Apple Silicon)" "ForgeAI (Intel)" "ForgeAI for Windows"; do cp "How to install ForgeAI.html" "out/$d/"; done
for d in "ForgeAI (Apple Silicon)" "ForgeAI (Intel)"; do cp app/deploy/uninstall-unix.sh "out/$d/Uninstall ForgeAI.command"; chmod 755 "out/$d/Uninstall ForgeAI.command"; done
cp server-edition/README.txt server-edition/install.sh server-edition/install.ps1 app/deploy/install-unix.sh app/deploy/install-windows.ps1 app/deploy/uninstall-unix.sh "out/ForgeAI Server/"
mkdir -p "out/ForgeAI Server/app" && (cd app && tar cf - --exclude=./README.md --exclude=./electron --exclude=./data --exclude=./test --exclude='./engines/macos-*' --exclude='./engines/win-*' --exclude='./deploy/Uninstall ForgeAI.exe' .) | (cd "out/ForgeAI Server/app" && tar xf -)
cd out
zip -qry ForgeAI-Mac-AppleSilicon.zip "ForgeAI (Apple Silicon)"
zip -qry ForgeAI-Mac-Intel.zip "ForgeAI (Intel)"
zip -qr ForgeAI-Windows.zip "ForgeAI for Windows"
zip -qr ForgeAI-Server.zip "ForgeAI Server"
sha256sum ForgeAI-*.zip "Uninstall ForgeAI ${VER}.exe" > SHA256SUMS.txt
cat SHA256SUMS.txt; ls -la *.zip "Uninstall ForgeAI ${VER}.exe"
