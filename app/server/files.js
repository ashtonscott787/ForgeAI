'use strict';
// Text extraction for uploaded files (document analysis). Images are passed to vision models instead.
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|xml|html?|css|js|ts|py|rb|go|rs|java|c|cpp|h|sql|yaml|yml|log|ini|toml|sh|swift|kt)$/i;
const MAX_CHARS = 200000;

function isImage(mime, name) { return /^image\/(png|jpe?g|gif|webp)$/i.test(mime || '') || /\.(png|jpe?g|gif|webp)$/i.test(name || ''); }
function imageMime(mime, name) {
  if (/^image\//.test(mime || '')) return mime.replace('image/jpg', 'image/jpeg');
  const ext = (/\.(\w+)$/.exec(name || '') || [])[1] || 'png';
  return 'image/' + (ext.toLowerCase() === 'jpg' ? 'jpeg' : ext.toLowerCase());
}

async function extractText(buf, name, mime) {
  try {
    if (/\.pdf$/i.test(name) || mime === 'application/pdf') {
      const { extractText: ex, getDocumentProxy } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      const { text } = await ex(pdf, { mergePages: true });
      return clip(text);
    }
    if (/\.docx$/i.test(name)) {
      const mammoth = require('mammoth');
      const r = await mammoth.extractRawText({ buffer: buf });
      return clip(r.value);
    }
    if (TEXT_EXT.test(name) || /^text\//.test(mime || '') || /json|xml|csv/.test(mime || '')) return clip(buf.toString('utf8'));
  } catch (e) {
    return `[Could not read ${name}: ${e.message}]`;
  }
  return null;
}
function clip(s) { s = String(s || ''); return s.length > MAX_CHARS ? s.slice(0, MAX_CHARS) + '\n…[truncated]' : s; }

module.exports = { extractText, isImage, imageMime };
