#!/usr/bin/env bash
# Starts the packaged inference engine, waits until it is ready, and asks it for a reply.
# Fails on any missing library, a start that never becomes ready, or an empty reply.
#
# usage: scripts/smoke-engine.sh <engine folder> <model .gguf> [port]
#
# `--version` runs first: it loads every dynamic library the engine needs, so a missing library
# stops here with dyld's own message rather than later.
set -euo pipefail

ENGINE="${1:?engine folder}"
MODEL="${2:?model file}"
PORT="${3:-18765}"
BIN="$ENGINE/llama-server"

[ -x "$BIN" ] || { echo "smoke: $BIN is missing or not executable"; exit 1; }
[ -s "$MODEL" ] || { echo "smoke: model $MODEL is missing or empty"; exit 1; }

echo "smoke: loading libraries (--version)"
if ! "$BIN" --version > "${TMPDIR:-/tmp}/forge-smoke-version.txt" 2>&1; then
  echo "smoke: the engine did not load"
  cat "${TMPDIR:-/tmp}/forge-smoke-version.txt"
  exit 1
fi
head -1 "${TMPDIR:-/tmp}/forge-smoke-version.txt"

LOG="${TMPDIR:-/tmp}/forge-smoke-server.log"
"$BIN" --model "$MODEL" --port "$PORT" --host 127.0.0.1 --ctx-size 2048 --n-gpu-layers 999 > "$LOG" 2>&1 &
PID=$!
cleanup() { kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; }
trap cleanup EXIT

echo "smoke: waiting for the engine to be ready"
ready=""
for _ in $(seq 1 150); do
  if curl -sf -m 2 "http://127.0.0.1:$PORT/health" | grep -q '"ok"'; then ready=1; break; fi
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "smoke: the engine exited before it was ready"; tail -60 "$LOG"; exit 1
  fi
  sleep 2
done
[ -n "$ready" ] || { echo "smoke: the engine did not become ready in five minutes"; tail -60 "$LOG"; exit 1; }

echo "smoke: asking the model for a reply"
RESP=$(curl -sf -m 180 "http://127.0.0.1:$PORT/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Reply with the single word OK."}],"max_tokens":16,"temperature":0}')
TEXT=$(printf '%s' "$RESP" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.choices[0].message.content||"")})')
echo "smoke: reply: $(printf '%s' "$TEXT" | tr -d '\r' | head -c 200)"
if [ -z "$(printf '%s' "$TEXT" | tr -d '[:space:]')" ]; then
  echo "smoke: the model returned an empty reply"; tail -60 "$LOG"; exit 1
fi
echo "smoke: passed"
