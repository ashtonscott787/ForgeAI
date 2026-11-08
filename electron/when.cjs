/**
 * Turning "remind me every Friday at 7pm" into a time.
 *
 * Small and deliberate: it understands the handful of shapes people actually
 * type, and when it does not understand something it says so rather than
 * guessing a time the reminder would then fire at.
 */
const UNITS = { second: 1e3, sec: 1e3, minute: 6e4, min: 6e4, hour: 36e5, hr: 36e5, day: 864e5, week: 6048e5 };
const WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, half: 0.5 };
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];
const PARTS = { morning: 9, "mid morning": 10, noon: 12, midday: 12, afternoon: 14, evening: 18, tonight: 20, night: 21, midnight: 0 };

const at = (base, h, m) => {
  const d = new Date(base);
  d.setHours(h, m, 0, 0);
  return d;
};

/** Finds a clock time anywhere in the text: 7pm, 7:30 pm, 19:30, 7 o'clock. */
function clock(text) {
  const m = text.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|o'?clock)?\b/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const suffix = (m[3] || "").toLowerCase().replace(/[.']/g, "");
  if (h > 23 || min > 59) return null;
  if (suffix.startsWith("p") && h < 12) h += 12;
  if (suffix.startsWith("a") && h === 12) h = 0;
  // A bare "at 7" in the evening reads as 7pm to most people; 7:00 does not.
  if (!suffix && !m[2] && h <= 7 && /\bat\s+\d{1,2}\b/i.test(text)) h += 12;
  return { h, m: min, explicit: Boolean(suffix || m[2]) };
}

function partOfDay(text) {
  for (const [word, hour] of Object.entries(PARTS)) {
    if (new RegExp(`\\b${word}\\b`, "i").test(text)) return hour;
  }
  return null;
}

/**
 * @returns {{at:number, repeat:null|{kind:string,day?:number,interval?:number}, text:string}|{error:string}}
 */
function parseWhen(input, now = Date.now()) {
  const text = String(input || "").toLowerCase().trim();
  if (!text) return { error: "no time given" };
  const base = new Date(now);
  // A day number next to a month name is a date, not a clock time, so it is
  // taken out before looking for one: "March 12 at 2pm" is 2pm, not 12 o'clock.
  const MONTH_RE = new RegExp(`\\b(?:(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTHS.join("|")})|(${MONTHS.join("|")})\\s+(\\d{1,2})(?:st|nd|rd|th)?)\\b`, "i");
  const dateMatch = text.match(MONTH_RE);
  const timeText = dateMatch ? text.replace(dateMatch[0], " ") : text;
  const time = clock(timeText);
  const part = partOfDay(timeText);
  const hour = time ? time.h : part;
  const minute = time ? time.m : 0;

  // every / each → recurring
  const every = text.match(/\b(?:every|each)\s+([a-z]+)(?:\s+at\b)?/i);
  if (every) {
    const word = every[1];
    const dayIndex = DAYS.findIndex((d) => d.startsWith(word.replace(/s$/, "")));
    const h = hour ?? 9;
    if (dayIndex >= 0) {
      const next = at(base, h, minute);
      let delta = (dayIndex - next.getDay() + 7) % 7;
      if (delta === 0 && next.getTime() <= now) delta = 7;
      next.setDate(next.getDate() + delta);
      return { at: next.getTime(), repeat: { kind: "weekly", day: dayIndex }, text: input };
    }
    if (/^day$|^morning$|^evening$|^night$/.test(word)) {
      let next = at(base, h, minute);
      if (next.getTime() <= now) next = new Date(next.getTime() + 864e5);
      return { at: next.getTime(), repeat: { kind: "daily" }, text: input };
    }
    if (/^week$/.test(word)) {
      const next = at(base, h, minute);
      next.setDate(next.getDate() + 7);
      return { at: next.getTime(), repeat: { kind: "weekly", day: next.getDay() }, text: input };
    }
    if (/^weekday$/.test(word)) {
      let next = at(base, h, minute);
      if (next.getTime() <= now) next = new Date(next.getTime() + 864e5);
      while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1);
      return { at: next.getTime(), repeat: { kind: "weekdays" }, text: input };
    }
    if (/^month$/.test(word)) {
      const next = at(base, h, minute);
      next.setMonth(next.getMonth() + 1);
      return { at: next.getTime(), repeat: { kind: "monthly", day: next.getDate() }, text: input };
    }
  }

  // in N units
  const rel = text.match(/\bin\s+(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|half)\s*(?:an?\s+)?(second|sec|minute|min|hour|hr|day|week)s?\b/i);
  if (rel) {
    const n = Number(rel[1]) || WORDS[rel[1]] || 0;
    const unit = UNITS[rel[2].toLowerCase()];
    if (n > 0 && unit) return { at: now + n * unit, repeat: null, text: input };
  }

  // on the 12th of March / 12 March / March 12
  if (dateMatch) {
    const dayNum = Number(dateMatch[1] ?? dateMatch[4]);
    const monthName = MONTHS.indexOf((dateMatch[2] ?? dateMatch[3]).toLowerCase());
    if (monthName >= 0 && dayNum >= 1 && dayNum <= 31) {
      const d = at(base, hour ?? 9, minute);
      d.setMonth(monthName, dayNum);
      if (d.getTime() <= now) d.setFullYear(d.getFullYear() + 1);
      return { at: d.getTime(), repeat: null, text: input };
    }
  }

  // named weekday (this/next friday)
  const named = DAYS.findIndex((d) => new RegExp(`\\b${d}\\b`, "i").test(text));
  if (named >= 0) {
    const d = at(base, hour ?? 9, minute);
    let delta = (named - d.getDay() + 7) % 7;
    if (delta === 0 && (d.getTime() <= now || /\bnext\b/.test(text))) delta = 7;
    if (/\bnext\b/.test(text) && delta < 7) delta += 7;
    d.setDate(d.getDate() + delta);
    return { at: d.getTime(), repeat: null, text: input };
  }

  if (/\btomorrow\b/.test(text)) {
    const d = at(base, hour ?? 9, minute);
    d.setDate(d.getDate() + 1);
    return { at: d.getTime(), repeat: null, text: input };
  }
  if (/\btonight\b/.test(text)) return { at: at(base, hour ?? 20, minute).getTime(), repeat: null, text: input };

  if (hour !== null && hour !== undefined) {
    let d = at(base, hour, minute);
    if (d.getTime() <= now) d = new Date(d.getTime() + 864e5); // today has passed
    return { at: d.getTime(), repeat: null, text: input };
  }

  return { error: "could not work out a time from that" };
}

/** The next occurrence after a recurring reminder fires. */
function advance(when, repeat) {
  const d = new Date(when);
  if (!repeat) return null;
  if (repeat.kind === "daily") d.setDate(d.getDate() + 1);
  else if (repeat.kind === "weekly") d.setDate(d.getDate() + 7);
  else if (repeat.kind === "weekdays") {
    do {
      d.setDate(d.getDate() + 1);
    } while (d.getDay() === 0 || d.getDay() === 6);
  } else if (repeat.kind === "monthly") d.setMonth(d.getMonth() + 1);
  else return null;
  return d.getTime();
}

module.exports = { parseWhen, advance };
