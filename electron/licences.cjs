/**
 * Which models a business may actually use.
 *
 * The catalogue carries a licence name on every model and nothing read it.
 * One of the sixteen — qwen2.5-3b-instruct — is under the Qwen research
 * licence, which forbids commercial use outright, and it sat in the library
 * next to the Apache ones with nothing to tell them apart. Somebody
 * building a business on Forge AI had no way to know.
 *
 * So each licence is classified once, here, with what it actually requires.
 * Three kinds:
 *
 *   free        use it for anything, including selling what you make
 *   conditions  commercial use allowed, but the licence asks something of
 *               you — attribution, a use policy, a cap on how large you may
 *               get before you must ask
 *   research    commercial use not permitted
 *
 * This is a summary for choosing a model, not legal advice, and the
 * interface says so. What it is not is silence.
 */
const LICENCES = {
  "apache-2.0": {
    label: "Apache 2.0",
    kind: "free",
    commercial_ok: true,
    says: "Use it for anything, including commercially. Keep the notice.",
  },
  mit: {
    label: "MIT",
    kind: "free",
    commercial_ok: true,
    says: "Use it for anything, including commercially. Keep the notice.",
  },
  "llama-3.1": {
    label: "Llama 3.1 Community",
    kind: "conditions",
    commercial_ok: true,
    says: "Commercial use allowed. Attribution required, an acceptable-use policy applies, and a separate licence is needed above 700 million monthly users.",
  },
  "llama-3.2": {
    label: "Llama 3.2 Community",
    kind: "conditions",
    commercial_ok: true,
    says: "Commercial use allowed. Attribution required, an acceptable-use policy applies, and a separate licence is needed above 700 million monthly users.",
  },
  gemma: {
    label: "Gemma Terms of Use",
    kind: "conditions",
    commercial_ok: true,
    says: "Commercial use allowed, subject to a prohibited-use policy that follows the model and anything derived from it.",
  },
  "qwen-research": {
    label: "Qwen Research",
    kind: "research",
    commercial_ok: false,
    says: "Research and evaluation only. Commercial use is not permitted by this licence.",
  },
  "cc-by-nc-4.0": {
    label: "CC BY-NC 4.0",
    kind: "research",
    commercial_ok: false,
    says: "Non-commercial use only.",
  },
};

/**
 * What is known about a licence.
 *
 * An unknown name is reported as unknown, not assumed to be permissive.
 * Guessing in the generous direction is the one wrong answer here: it tells
 * somebody they may sell what they build when nobody has checked.
 */
function about(name) {
  const key = String(name || "").toLowerCase().trim();
  const known = LICENCES[key];
  if (known) return { id: key, known: true, ...known };
  return {
    id: key || "unknown",
    known: false,
    label: name || "Unknown",
    kind: "unknown",
    commercial_ok: null,
    says: "This licence is not one Forge AI knows. Read it before using the model commercially.",
  };
}

/** True only when the licence is known and permits it. */
const commercialOk = (name) => about(name).commercial_ok === true;

/**
 * Filters a catalogue for commercial use.
 *
 * Unknown licences are excluded along with the research ones, because the
 * person asking this question wants a list they can act on, and "we are not
 * sure" belongs in that list no more than "no" does.
 */
const forCommercialUse = (models) => models.filter((m) => commercialOk(m.license));

/** Adds what is known to each entry, without changing anything else. */
const annotate = (models) => models.map((m) => ({ ...m, licence: about(m.license) }));

module.exports = { LICENCES, about, commercialOk, forCommercialUse, annotate };
