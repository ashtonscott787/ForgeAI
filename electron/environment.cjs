/**
 * What Forge AI knows about where it is running.
 *
 * A model on its own knows nothing about today, this machine or the weather,
 * and will cheerfully invent all three. This module gathers the few facts that
 * are actually knowable and hands them over as plain text the model is given
 * before it answers.
 *
 * Two rules it keeps:
 *
 * 1. Nothing here guesses. If a fact is not available it is left out rather
 *    than filled in, because a wrong date stated confidently is worse than no
 *    date at all.
 * 2. Nothing here leaves the machine except the coordinates for a weather
 *    lookup, and only when someone has set a location themselves. There is no
 *    lookup of the user's position by IP address: that would hand their
 *    whereabouts to a third party to answer a question they did not ask.
 */
const os = require("node:os");

const GB = 1024 ** 3;

/** The date and time, as the person at this machine would say it. */
function now(at = new Date(), locale = undefined) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  const fmt = (o) => new Intl.DateTimeFormat(locale, o).format(at);
  const offsetMin = -at.getTimezoneOffset();
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  return {
    iso: at.toISOString(),
    date: fmt({ weekday: "long", day: "numeric", month: "long", year: "numeric" }),
    time: fmt({ hour: "2-digit", minute: "2-digit" }),
    weekday: fmt({ weekday: "long" }),
    timezone: tz,
    utc_offset: `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`,
  };
}

/** This computer. Facts from the operating system, none of them inferred. */
function machine(o = os) {
  const cpus = o.cpus() || [];
  const platform = o.platform();
  const names = { darwin: "macOS", win32: "Windows", linux: "Linux", freebsd: "FreeBSD" };
  return {
    os: names[platform] || platform,
    os_version: o.release(),
    arch: o.arch(),
    cpu: cpus[0] ? cpus[0].model.trim() : "",
    cores: cpus.length,
    memory_gb: Math.round((o.totalmem() / GB) * 10) / 10,
    memory_free_gb: Math.round((o.freemem() / GB) * 10) / 10,
    uptime_hours: Math.round((o.uptime() / 3600) * 10) / 10,
  };
}

const CODES = {
  0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast",
  45: "fog", 48: "freezing fog", 51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
  80: "showers", 81: "showers", 82: "heavy showers", 85: "snow showers", 86: "snow showers",
  95: "thunderstorms", 96: "thunderstorms with hail", 99: "thunderstorms with hail",
};

/**
 * The weather where the person said they are.
 *
 * `place` must carry latitude and longitude that someone set themselves. No
 * location is looked up: this is the only call in here that touches the
 * network, and all it sends is those two numbers.
 */
async function weather(place, fetchJson) {
  if (!place || typeof place.lat !== "number" || typeof place.lon !== "number") {
    return { known: false, why: "No location is set. Forge AI does not look up where you are." };
  }
  const lat = Number(place.lat.toFixed(2));
  const lon = Number(place.lon.toFixed(2));
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + "&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code";
  try {
    const d = await fetchJson(url);
    const c = d && d.current;
    if (!c) return { known: false, why: "The weather service answered with nothing usable." };
    return {
      known: true,
      place: place.label || `${lat}, ${lon}`,
      description: CODES[c.weather_code] ?? `code ${c.weather_code}`,
      temperature_c: c.temperature_2m,
      feels_like_c: c.apparent_temperature,
      humidity_pct: c.relative_humidity_2m,
      wind_kmh: c.wind_speed_10m,
    };
  } catch (e) {
    return { known: false, why: `The weather could not be fetched: ${e.message}` };
  }
}

/**
 * The block of facts handed to the model before it answers.
 *
 * Written as sentences rather than JSON because that is what a language model
 * reads best, and marked as context so it is not mistaken for the question.
 */
function brief({ time = now(), computer = machine(), sky = null } = {}) {
  const lines = [
    `Today is ${time.date}. The time is ${time.time}${time.timezone ? ` (${time.timezone}, UTC${time.utc_offset})` : ""}.`,
    `You are running on this person's own computer: ${computer.os} ${computer.os_version} on ${computer.arch}`
      + `${computer.cpu ? `, ${computer.cpu}` : ""}${computer.cores ? `, ${computer.cores} cores` : ""}`
      + `${computer.memory_gb ? `, ${computer.memory_gb} GB of memory` : ""}.`,
  ];
  if (sky && sky.known) {
    lines.push(`The weather in ${sky.place} is ${sky.description}, ${sky.temperature_c}°C`
      + `${sky.feels_like_c != null ? ` (feels like ${sky.feels_like_c}°C)` : ""}.`);
  }
  lines.push("These facts are current. Do not guess at the date, this machine or the weather; if something is not listed here, say you do not know it.");
  return lines.join("\n");
}

module.exports = { now, machine, weather, brief, CODES };
