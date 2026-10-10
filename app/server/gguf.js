'use strict';
// Reads the metadata header of a GGUF model file (architecture, context length, size label, chat template…)
// without loading the model. Only the header is read; tensor data is skipped.
const fs = require('node:fs');

const T = { U8: 0, I8: 1, U16: 2, I16: 3, U32: 4, I32: 5, F32: 6, BOOL: 7, STR: 8, ARR: 9, U64: 10, I64: 11, F64: 12 };
const SIZE = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
const FILE_TYPES = { 0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 7: 'Q8_0', 8: 'Q5_0', 9: 'Q5_1', 10: 'Q2_K', 11: 'Q3_K_S', 12: 'Q3_K_M', 13: 'Q3_K_L', 14: 'Q4_K_S', 15: 'Q4_K_M', 16: 'Q5_K_S', 17: 'Q5_K_M', 18: 'Q6_K', 19: 'IQ2_XXS', 20: 'IQ2_XS', 21: 'Q2_K_S', 22: 'IQ3_XS', 23: 'IQ3_XXS', 24: 'IQ1_S', 25: 'IQ4_NL', 26: 'IQ3_S', 27: 'IQ3_M', 28: 'IQ2_S', 29: 'IQ2_M', 30: 'IQ4_XS', 31: 'IQ1_M', 32: 'BF16', 36: 'TQ1_0', 37: 'TQ2_0', 38: 'MXFP4' };

class Reader {
  constructor(fd) { this.fd = fd; this.buf = Buffer.alloc(0); this.off = 0; this.pos = 0; this.eof = false; }
  need(n) {
    while (this.buf.length - this.off < n) {
      if (this.eof) throw new Error('Unexpected end of GGUF header');
      const chunk = Buffer.alloc(Math.max(n, 1 << 20)); const got = fs.readSync(this.fd, chunk, 0, chunk.length, this.pos);
      if (!got) this.eof = true; this.pos += got;
      this.buf = Buffer.concat([this.buf.subarray(this.off), chunk.subarray(0, got)]); this.off = 0;
    }
  }
  skip(n) { while (n > 0) { const have = this.buf.length - this.off; if (have >= n) { this.off += n; return; } n -= have; this.off = this.buf.length; this.need(Math.min(n, 1 << 20)); } }
  u32() { this.need(4); const v = this.buf.readUInt32LE(this.off); this.off += 4; return v; }
  u64() { this.need(8); const v = this.buf.readBigUInt64LE(this.off); this.off += 8; return Number(v); }
  str() { const n = this.u64(); if (n > 64 * 2 ** 20) throw new Error('GGUF string too long'); this.need(n); const s = this.buf.toString('utf8', this.off, this.off + n); this.off += n; return s; }
  scalar(t) {
    const n = SIZE[t]; this.need(n); const b = this.buf, o = this.off; this.off += n;
    switch (t) { case 0: return b.readUInt8(o); case 1: return b.readInt8(o); case 2: return b.readUInt16LE(o); case 3: return b.readInt16LE(o); case 4: return b.readUInt32LE(o); case 5: return b.readInt32LE(o);
      case 6: return b.readFloatLE(o); case 7: return !!b.readUInt8(o); case 10: return Number(b.readBigUInt64LE(o)); case 11: return Number(b.readBigInt64LE(o)); case 12: return b.readDoubleLE(o); default: return null; }
  }
  value(t, keep) {
    if (t === T.STR) return this.str();
    if (t === T.ARR) {
      const et = this.u32(); const n = this.u64();
      if (!keep) { if (et === T.STR) { for (let i = 0; i < n; i++) { const l = this.u64(); this.skip(l); } } else if (SIZE[et]) this.skip(n * SIZE[et]); else for (let i = 0; i < n; i++) this.value(et, false); return { length: n }; }
      const out = []; for (let i = 0; i < n; i++) out.push(this.value(et, true)); return out;
    }
    return this.scalar(t);
  }
}

// Returns a plain summary; never throws (unknown fields stay null).
function readGGUF(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r'); const r = new Reader(fd);
    r.need(4); if (r.buf.toString('ascii', 0, 4) !== 'GGUF') return { ok: false, error: 'Not a GGUF file' }; r.off = 4;
    const version = r.u32(); const tensors = r.u64(); const kvs = r.u64(); const kv = {};
    for (let i = 0; i < kvs; i++) { const k = r.str(); const t = r.u32(); kv[k] = r.value(t, false); }
    const arch = kv['general.architecture'] || null; const A = (k) => (arch ? kv[`${arch}.${k}`] : undefined);
    const tpl = typeof kv['tokenizer.chat_template'] === 'string' ? kv['tokenizer.chat_template'] : '';
    const size = fs.statSync(file).size;
    return {
      ok: true, version, tensors, arch, name: kv['general.name'] || null, basename: kv['general.basename'] || null, sizeLabel: kv['general.size_label'] || null,
      contextLength: A('context_length') || null, blocks: A('block_count') || null, embedding: A('embedding_length') || null, experts: A('expert_count') || null,
      fileType: kv['general.file_type'] != null ? FILE_TYPES[kv['general.file_type']] || String(kv['general.file_type']) : null,
      quantVersion: kv['general.quantization_version'] || null, license: kv['general.license'] || null, sizeBytes: size,
      // Tool use: chat templates that handle "tools" can call functions. Reasoning: templates with think blocks.
      tools: tpl ? /\btools\b/.test(tpl) : null, reasoning: tpl ? /<think>|reasoning_content|enable_thinking/.test(tpl) : null, hasTemplate: !!tpl,
      vision: /clip|mmproj/i.test(arch || '') ? true : null, isProjector: arch === 'clip' || /^mmproj/i.test(require('node:path').basename(file)),
    };
  } catch (e) { return { ok: false, error: e.message }; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

module.exports = { readGGUF };
