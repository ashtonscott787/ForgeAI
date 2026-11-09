/**
 * Writes the inference engine's output to a log file without ever writing to a
 * stream that has already ended. Writing after end() raises
 * ERR_STREAM_WRITE_AFTER_END, which crashes the main process when it escapes
 * an event listener. Every write here checks the stream's state first, and an
 * engine's log is closed exactly once, before the next engine opens the file.
 */
const fs = require("node:fs");

function openEngineLog(file) {
  const out = fs.createWriteStream(file, { flags: "w" });
  out.on("error", () => { /* a log that cannot be written must never take the app down */ });
  let closed = false;
  return {
    write(chunk) {
      if (closed || out.destroyed || out.writableEnded) return false;
      try {
        return out.write(chunk);
      } catch {
        return false;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try { out.end(); } catch { /* already closed */ }
    },
    get closed() {
      return closed;
    },
  };
}

module.exports = { openEngineLog };
