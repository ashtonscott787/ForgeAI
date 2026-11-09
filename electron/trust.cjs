/**
 * Decides whether an IPC message came from the app's own page. Only the
 * bundled index.html, loaded from the local file system, may call forge:* handlers.
 * Anything else (a navigated page, an embedded frame, a future remote URL) is refused.
 */
const { pathToFileURL } = require("node:url");

function trustedUrl(url, appIndexPath) {
  try {
    const u = new URL(url);
    return u.protocol === "file:" && u.href === pathToFileURL(appIndexPath).href;
  } catch {
    return false;
  }
}

/** senderFrame is the frame that sent the message; it must be the main frame and the app page. */
function isTrustedSender(event, appIndexPath) {
  const frame = event && event.senderFrame;
  if (!frame || frame.parent !== null) return false;
  return trustedUrl(frame.url, appIndexPath);
}

module.exports = { isTrustedSender, trustedUrl };
