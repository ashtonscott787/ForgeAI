// What Forge AI knows about where it is running, and what it refuses to know.
const test = require("node:test");
const assert = require("node:assert/strict");
const env = require("../electron/environment.cjs");

test("the date and time are read, never guessed", () => {
  const at = new Date("2026-03-07T09:05:00Z");
  const t = env.now(at, "en-GB");
  assert.equal(t.iso, "2026-03-07T09:05:00.000Z");
  assert.match(t.date, /2026/);
  assert.match(t.date, /March/i);
  assert.ok(t.utc_offset.startsWith("+") || t.utc_offset.startsWith("-"), "the offset has a sign");
});

test("the machine is described from the operating system", () => {
  const fake = {
    platform: () => "darwin",
    release: () => "25.1.0",
    arch: () => "arm64",
    cpus: () => Array(10).fill({ model: " Apple M4 Pro " }),
    totalmem: () => 48 * 1024 ** 3,
    freemem: () => 12 * 1024 ** 3,
    uptime: () => 7200,
  };
  const m = env.machine(fake);
  assert.equal(m.os, "macOS");
  assert.equal(m.cpu, "Apple M4 Pro", "trimmed");
  assert.equal(m.cores, 10);
  assert.equal(m.memory_gb, 48);
  assert.equal(m.uptime_hours, 2);
});

test("no location means no weather, and no attempt to find one", async () => {
  let called = false;
  const w = await env.weather(null, async () => { called = true; return {}; });
  assert.equal(w.known, false);
  assert.match(w.why, /does not look up where you are/i);
  assert.equal(called, false, "nothing was fetched");
});

test("weather sends two numbers and nothing else", async () => {
  let seen = "";
  const w = await env.weather({ lat: 51.5072, lon: -0.1276, label: "London" }, async (url) => {
    seen = url;
    return { current: { temperature_2m: 9.1, apparent_temperature: 6.4, relative_humidity_2m: 81, wind_speed_10m: 14, weather_code: 61 } };
  });
  assert.equal(w.known, true);
  assert.equal(w.description, "light rain");
  assert.equal(w.place, "London");
  const u = new URL(seen);
  assert.equal(u.searchParams.get("latitude"), "51.51", "coordinates are rounded before they are sent");
  assert.equal(u.searchParams.get("longitude"), "-0.13");
  assert.equal([...u.searchParams.keys()].sort().join(","), "current,latitude,longitude", "nothing else is sent");
});

test("a weather service that fails does not break the answer", async () => {
  const w = await env.weather({ lat: 1, lon: 2 }, async () => { throw new Error("offline"); });
  assert.equal(w.known, false);
  assert.match(w.why, /offline/);
});

test("the brief tells the model these facts are real and to stop guessing", () => {
  const b = env.brief({
    time: env.now(new Date("2026-03-07T09:05:00Z"), "en-GB"),
    computer: { os: "macOS", os_version: "25.1.0", arch: "arm64", cpu: "Apple M4", cores: 10, memory_gb: 48 },
    sky: { known: true, place: "London", description: "light rain", temperature_c: 9.1, feels_like_c: 6.4 },
  });
  assert.match(b, /March/);
  assert.match(b, /macOS 25\.1\.0/);
  assert.match(b, /London/);
  assert.match(b, /Do not guess/i);
});

test("an unknown sky is left out rather than filled in", () => {
  const b = env.brief({ sky: { known: false, why: "no location" } });
  assert.ok(!/weather in/i.test(b), "no weather sentence at all");
});
