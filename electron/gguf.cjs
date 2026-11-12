/**
 * Reading a model's own metadata, instead of guessing from its file name.
 *
 * A GGUF file begins with a header: a magic number, a version, counts, a
 * key/value block, then one record per tensor giving its name, shape and type.
 * The shapes are the thing worth having — summing their elements gives the
 * exact parameter count, not an approximation and not whatever the uploader
 * happened to put in the file name.
 *
 * Only the header is read. It sits at the start of the file, so this costs a
 * few hundred kilobytes rather than the gigabytes of weights behind it, and the
 * same parser works on the first chunk of a remote file fetched with a range
 * request.
 */
const fs = require("node:fs");

const MAGIC = 0x46554747; // "GGUF", little-endian

// Metadata value types, from the GGUF specification.
const T = {
  UINT8: 0, INT8: 1, UINT16: 2, INT16: 3, UINT32: 4, INT32: 5,
  FLOAT32: 6, BOOL: 7, STRING: 8, ARRAY: 9, UINT64: 10, INT64: 11, FLOAT64: 12,
};

class Cursor {
  constructor(buf) { this.b = buf; this.i = 0; }
  need(n) { if (this.i + n > this.b.length) throw new Error("truncated"); }
  u8() { this.need(1); return this.b[this.i++]; }
  u16() { this.need(2); const v = this.b.readUInt16LE(this.i); this.i += 2; return v; }
  i16() { this.need(2); const v = this.b.readInt16LE(this.i); this.i += 2; return v; }
  u32() { this.need(4); const v = this.b.readUInt32LE(this.i); this.i += 4; return v; }
  i32() { this.need(4); const v = this.b.readInt32LE(this.i); this.i += 4; return v; }
  f32() { this.need(4); const v = this.b.readFloatLE(this.i); this.i += 4; return v; }
  f64() { this.need(8); const v = this.b.readDoubleLE(this.i); this.i += 8; return v; }
  // Counts and offsets are 64-bit. Number is exact to 2^53, far beyond any
  // real tensor count, and a BigInt here would infect every caller.
  u64() { this.need(8); const v = this.b.readBigUInt64LE(this.i); this.i += 8; return Number(v); }
  i64() { this.need(8); const v = this.b.readBigInt64LE(this.i); this.i += 8; return Number(v); }
  str() {
    const n = this.u64();
    if (n > 64 * 1024 * 1024) throw new Error("implausible string length");
    this.need(n);
    const s = this.b.toString("utf8", this.i, this.i + n);
    this.i += n;
    return s;
  }
  value(type) {
    switch (type) {
      case T.UINT8: return this.u8();
      case T.INT8: { const v = this.b.readInt8(this.i); this.i += 1; return v; }
      case T.UINT16: return this.u16();
      case T.INT16: return this.i16();
      case T.UINT32: return this.u32();
      case T.INT32: return this.i32();
      case T.FLOAT32: return this.f32();
      case T.BOOL: return this.u8() !== 0;
      case T.STRING: return this.str();
      case T.UINT64: return this.u64();
      case T.INT64: return this.i64();
      case T.FLOAT64: return this.f64();
      case T.ARRAY: {
        const inner = this.u32();
        const n = this.u64();
        if (n > 10_000_000) throw new Error("implausible array length");
        const out = [];
        for (let k = 0; k < n; k++) out.push(this.value(inner));
        return out;
      }
      default: throw new Error(`unknown metadata type ${type}`);
    }
  }
}

/**
 * Parses a GGUF header. `buf` may be the whole file or only its first chunk;
 * when the chunk stops partway through, whatever was read is returned with
 * `complete: false` rather than an error, because partial metadata is still
 * worth having.
 */
function parseHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) throw new Error("That file is too short to be a GGUF model.");
  if (buf.readUInt32LE(0) !== MAGIC) throw new Error("That file is not a GGUF model.");
  const c = new Cursor(buf);
  c.i = 4;
  const version = c.u32();
  if (version < 2 || version > 3) throw new Error(`GGUF version ${version} is not supported.`);
  const tensorCount = c.u64();
  const kvCount = c.u64();
  if (tensorCount > 1_000_000 || kvCount > 100_000) throw new Error("That GGUF header is not plausible.");

  const meta = {};
  let complete = true;
  try {
    for (let k = 0; k < kvCount; k++) {
      const key = c.str();
      const type = c.u32();
      meta[key] = c.value(type);
    }
  } catch {
    // Ran off the end of a partial read: keep what was parsed.
    return { version, tensorCount, kvCount, meta, tensors: [], parameters: 0, complete: false };
  }

  const tensors = [];
  let parameters = 0;
  try {
    for (let k = 0; k < tensorCount; k++) {
      const name = c.str();
      const nDims = c.u32();
      if (nDims > 8) throw new Error("implausible tensor rank");
      const dims = [];
      for (let d = 0; d < nDims; d++) dims.push(c.u64());
      const type = c.u32();
      c.u64(); // offset, not needed here
      tensors.push({ name, dims, type });
      parameters += dims.reduce((a, b) => a * b, 1);
    }
  } catch {
    complete = false;
  }
  return { version, tensorCount, kvCount, meta, tensors, parameters, complete };
}

/** Rounds a parameter count the way model names do: 2.6B, 7B, 256M. */
function humanParams(n) {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1e9) {
    const b = n / 1e9;
    return `${b >= 10 ? Math.round(b) : Number(b.toFixed(1))}B`;
  }
  if (n >= 1e6) return `${Math.round(n / 1e6)}M`;
  return `${Math.round(n / 1e3)}K`;
}

/**
 * What the app wants to know about a model, taken from the file itself.
 * Every field is either read from the file or absent — nothing is inferred
 * from the name, so a mislabelled upload cannot produce a wrong figure.
 */
function describe(buf) {
  const h = parseHeader(buf);
  const m = h.meta;
  const arch = typeof m["general.architecture"] === "string" ? m["general.architecture"] : "";
  const pick = (suffix) => {
    const k = arch && `${arch}.${suffix}` in m ? `${arch}.${suffix}` : Object.keys(m).find((x) => x.endsWith(`.${suffix}`));
    const v = k ? m[k] : undefined;
    return typeof v === "number" ? v : null;
  };
  // Some files state the count; the tensor shapes are the ground truth, so they win.
  const stated = typeof m["general.parameter_count"] === "number" ? m["general.parameter_count"] : null;
  const counted = h.complete && h.parameters > 0 ? h.parameters : null;
  const parameters = counted ?? stated;
  return {
    architecture: arch || null,
    name: typeof m["general.name"] === "string" ? m["general.name"] : null,
    parameters,
    parameters_source: counted ? "counted from tensor shapes" : stated ? "stated in the file" : null,
    parameters_label: humanParams(parameters ?? 0) || null,
    context_length: pick("context_length"),
    embedding_length: pick("embedding_length"),
    block_count: pick("block_count"),
    quantization: typeof m["general.file_type"] === "number" ? m["general.file_type"] : null,
    vision: Object.keys(m).some((k) => k.startsWith("clip.") || k.includes("vision")),
    complete: h.complete,
    tensor_count: h.tensorCount,
  };
}

/**
 * Reads enough of a file on disk to describe it, and no more.
 *
 * A first pass of a few megabytes covers most models. A large vocabulary sits
 * between the key/value block and the tensor records — Gemma's 256k tokens run
 * to about 20 MB — so when the first pass stops short the read grows once
 * rather than defaulting to something wasteful for every model.
 */
function describeFile(file, steps = [4 * 1024 * 1024, 48 * 1024 * 1024]) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    let last = null;
    for (const want of steps) {
      const n = Math.min(want, size);
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, 0);
      last = describe(buf);
      if (last.complete || n >= size) return last;
    }
    return last;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { parseHeader, describe, describeFile, humanParams, MAGIC, TYPES: T };
