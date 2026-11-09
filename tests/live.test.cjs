// Live checks against real services. Skipped unless FORGE_LIVE=1, because they need network access
// and a service that is not rate-limiting this machine. Run with: FORGE_LIVE=1 pnpm test:live
const test = require("node:test");
const assert = require("node:assert/strict");
const live = process.env.FORGE_LIVE === "1";
const { wikipediaSearch, wikipediaSummary } = require("../electron/open-web.cjs");

test("live: Wikipedia search returns real sources with URLs", { skip: !live && "set FORGE_LIVE=1" }, async () => {
  const r = await wikipediaSearch("Forge AI", { limit: 3 });
  assert.equal(r.provider, "wikipedia");
  assert.ok(r.sources.length >= 1);
  for (const s of r.sources) assert.match(s.url, /^https:\/\/en\.wikipedia\.org\/wiki\//);
});

test("live: Wikipedia article summary returns text and its page", { skip: !live && "set FORGE_LIVE=1" }, async () => {
  const s = await wikipediaSummary("Electron (software framework)");
  assert.ok(s.text.length > 40);
  assert.equal(s.url, "https://en.wikipedia.org/wiki/Electron_(software_framework)");
});
