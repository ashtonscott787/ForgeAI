@echo off
rem ForgeAI CLI shim — runs forgeai.ps1 next to this file, passing all arguments through.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0forgeai.ps1" %*
