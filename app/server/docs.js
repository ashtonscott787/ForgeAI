'use strict';
// Making files people keep: Word, PowerPoint, Excel, PDF, web page, Markdown, CSV — and charts.
const fs = require('fs');
const path = require('path');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function inlineHtml(s) {
  return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
}
// Block-level markdown parse shared by HTML/PDF and Word output.
function parseBlocks(md) {
  const lines = String(md || '').replace(/\r/g, '').split('\n'); const out = []; let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) { const c = []; i++; while (i < lines.length && !/^```/.test(lines[i])) c.push(lines[i++]); i++; out.push({ t: 'code', text: c.join('\n') }); continue; }
    const hm = /^(#{1,6})\s+(.*)/.exec(l); if (hm) { out.push({ t: 'h', level: hm[1].length, text: hm[2] }); i++; continue; }
    if (/^\s*([-*•]|\d+\.)\s+/.test(l)) { const ordered = /^\s*\d+\./.test(l); const items = []; while (i < lines.length && /^\s*([-*•]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*•]|\d+\.)\s+/, '')); out.push({ t: 'list', ordered, items }); continue; }
    if (/^\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const row = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = row(l); i += 2; const rows = []; while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(row(lines[i++]));
      out.push({ t: 'table', head, rows }); continue;
    }
    if (/^>\s?/.test(l)) { const q = []; while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, '')); out.push({ t: 'quote', text: q.join(' ') }); continue; }
    if (!l.trim()) { i++; continue; }
    const p = []; while (i < lines.length && lines[i].trim() && !/^(```|#{1,6}\s|\s*([-*•]|\d+\.)\s+|>|\|)/.test(lines[i])) p.push(lines[i++]);
    if (!p.length) p.push(lines[i++]);
    out.push({ t: 'p', text: p.join(' ') });
  }
  return out;
}
function mdToHtml(md) {
  return parseBlocks(md).map((b) => {
    if (b.t === 'h') return `<h${b.level}>${inlineHtml(b.text)}</h${b.level}>`;
    if (b.t === 'code') return `<pre><code>${esc(b.text)}</code></pre>`;
    if (b.t === 'list') return `<${b.ordered ? 'ol' : 'ul'}>${b.items.map((x) => `<li>${inlineHtml(x)}</li>`).join('')}</${b.ordered ? 'ol' : 'ul'}>`;
    if (b.t === 'table') return `<table><thead><tr>${b.head.map((c) => `<th>${inlineHtml(c)}</th>`).join('')}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${inlineHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    if (b.t === 'quote') return `<blockquote>${inlineHtml(b.text)}</blockquote>`;
    return `<p>${inlineHtml(b.text)}</p>`;
  }).join('\n');
}
const PAGE_CSS = `body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;color:#1d1d1f;max-width:760px;margin:40px auto;padding:0 24px}
h1{font-size:30px;letter-spacing:-.02em;margin:0 0 16px}h2{font-size:21px;margin:28px 0 10px}h3{font-size:17px;margin:22px 0 8px}
table{border-collapse:collapse;width:100%;margin:14px 0}th,td{border-bottom:1px solid #e5e5ea;padding:8px 10px;text-align:left}th{background:#f5f5f7}
pre{background:#f5f5f7;padding:12px;border-radius:8px;overflow:auto}code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.9em}
blockquote{border-left:3px solid #d2d2d7;margin:12px 0;padding:2px 14px;color:#6e6e73}img{max-width:100%}`;
const htmlPage = (title, bodyHtml) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body>${bodyHtml}</body></html>`;

// ---------- Word
async function makeDocx(title, md) {
  const d = require('docx');
  const runs = (text) => {
    const parts = []; const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g; let last = 0, m;
    while ((m = re.exec(text))) { if (m.index > last) parts.push(new d.TextRun(text.slice(last, m.index))); const t = m[0];
      if (t.startsWith('**')) parts.push(new d.TextRun({ text: t.slice(2, -2), bold: true })); else if (t.startsWith('`')) parts.push(new d.TextRun({ text: t.slice(1, -1), font: 'Consolas' })); else parts.push(new d.TextRun({ text: t.slice(1, -1), italics: true }));
      last = m.index + t.length; }
    if (last < text.length) parts.push(new d.TextRun(text.slice(last)));
    return parts;
  };
  const children = [];
  if (title) children.push(new d.Paragraph({ heading: d.HeadingLevel.TITLE, children: [new d.TextRun(title)] }));
  const H = [d.HeadingLevel.HEADING_1, d.HeadingLevel.HEADING_2, d.HeadingLevel.HEADING_3, d.HeadingLevel.HEADING_4, d.HeadingLevel.HEADING_5, d.HeadingLevel.HEADING_6];
  for (const b of parseBlocks(md)) {
    if (b.t === 'h') children.push(new d.Paragraph({ heading: H[b.level - 1], children: runs(b.text) }));
    else if (b.t === 'list') b.items.forEach((it) => children.push(new d.Paragraph({ children: runs(it), ...(b.ordered ? { numbering: { reference: 'num', level: 0 } } : { bullet: { level: 0 } }) })));
    else if (b.t === 'code') b.text.split('\n').forEach((ln) => children.push(new d.Paragraph({ children: [new d.TextRun({ text: ln, font: 'Consolas', size: 19 })] })));
    else if (b.t === 'table') {
      const cell = (t, bold) => new d.TableCell({ children: [new d.Paragraph({ children: bold ? [new d.TextRun({ text: t, bold: true })] : runs(t) })] });
      children.push(new d.Table({ width: { size: 100, type: d.WidthType.PERCENTAGE }, rows: [new d.TableRow({ tableHeader: true, children: b.head.map((c) => cell(c, true)) }), ...b.rows.map((r) => new d.TableRow({ children: b.head.map((_, i) => cell(r[i] || '')) }))] }));
    } else if (b.t === 'quote') children.push(new d.Paragraph({ children: runs(b.text), indent: { left: 400 } }));
    else children.push(new d.Paragraph({ children: runs(b.text), spacing: { after: 120 } }));
  }
  const doc = new d.Document({ creator: 'ForgeAI', title: title || 'Document', numbering: { config: [{ reference: 'num', levels: [{ level: 0, format: d.LevelFormat.DECIMAL, text: '%1.', alignment: d.AlignmentType.START }] }] },
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } }, sections: [{ children }] });
  return d.Packer.toBuffer(doc);
}

// ---------- PowerPoint
async function makePptx(title, slides, theme) {
  const PptxGenJS = require('pptxgenjs');
  const p = new PptxGenJS(); p.layout = 'LAYOUT_WIDE'; p.title = title || 'Presentation';
  const accent = (theme && theme.color || '#0071E3').replace('#', '');
  const cover = p.addSlide(); cover.background = { color: '111114' };
  cover.addText(title || 'Presentation', { x: 0.8, y: 2.6, w: 11.5, h: 1.4, fontSize: 44, bold: true, color: 'FFFFFF', fontFace: 'Helvetica Neue' });
  if (theme && theme.subtitle) cover.addText(theme.subtitle, { x: 0.8, y: 4.0, w: 11.5, h: 0.8, fontSize: 20, color: 'A1A1A6', fontFace: 'Helvetica Neue' });
  cover.addShape(p.ShapeType.rect, { x: 0.8, y: 2.35, w: 1.2, h: 0.08, fill: { color: accent } });
  for (const s of slides || []) {
    const sl = p.addSlide(); sl.background = { color: 'FFFFFF' };
    sl.addText(s.title || '', { x: 0.7, y: 0.45, w: 12, h: 0.9, fontSize: 30, bold: true, color: '1D1D1F', fontFace: 'Helvetica Neue' });
    sl.addShape(p.ShapeType.rect, { x: 0.7, y: 1.3, w: 0.9, h: 0.06, fill: { color: accent } });
    if (s.bullets && s.bullets.length) sl.addText(s.bullets.map((b) => ({ text: String(b), options: { bullet: true, breakLine: true } })), { x: 0.7, y: 1.6, w: s.table ? 6 : 12, h: 5.2, fontSize: 20, color: '1D1D1F', valign: 'top', paraSpaceAfter: 10, fontFace: 'Helvetica Neue' });
    if (s.table && s.table.length) sl.addTable(s.table.map((r, i) => r.map((c) => ({ text: String(c), options: i === 0 ? { bold: true, fill: { color: 'F5F5F7' } } : {} }))), { x: s.bullets && s.bullets.length ? 7 : 0.7, y: 1.7, w: s.bullets && s.bullets.length ? 5.6 : 12, fontSize: 13, border: { type: 'solid', pt: 0.5, color: 'D2D2D7' } });
    if (s.notes) sl.addNotes(String(s.notes));
  }
  return p.write({ outputType: 'nodebuffer' });
}

// ---------- Excel
async function makeXlsx(sheets) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook(); wb.creator = 'ForgeAI';
  for (const sh of sheets && sheets.length ? sheets : [{ name: 'Sheet1', rows: [] }]) {
    const ws = wb.addWorksheet(String(sh.name || 'Sheet').slice(0, 31));
    (sh.rows || []).forEach((r) => ws.addRow((r || []).map((c) => (typeof c === 'string' && c.startsWith('=') ? { formula: c.slice(1) } : c))));
    if ((sh.rows || []).length) { ws.getRow(1).font = { bold: true }; ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F7' } }; ws.views = [{ state: 'frozen', ySplit: 1 }]; }
    ws.columns.forEach((col) => { let w = 10; col.eachCell({ includeEmpty: false }, (c) => { w = Math.max(w, Math.min(60, String(c.value && c.value.formula ? c.value.formula : c.value ?? '').length + 2)); }); col.width = w; });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
async function readXlsx(buf) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
  const out = [];
  wb.eachSheet((ws) => {
    out.push(`# Sheet: ${ws.name}`);
    ws.eachRow({ includeEmpty: false }, (row) => { out.push((row.values || []).slice(1).map((v) => (v && typeof v === 'object' ? (v.result ?? v.text ?? v.formula ?? JSON.stringify(v)) : v ?? '')).join('\t')); });
  });
  return out.join('\n');
}

// ---------- PDF (plain fallback when no browser engine is available)
async function makePdfPlain(title, md) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const doc = await PDFDocument.create(); const font = await doc.embedFont(StandardFonts.Helvetica); const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([595, 842]); let y = 790; const L = 56, W = 483;
  const clean = (s) => String(s).replace(/[^\x20-\x7E -ÿ]/g, '').replace(/\*\*|`/g, '');
  const write = (text, f, size, gap) => {
    const words = clean(text).split(/\s+/); let line = '';
    const flush = () => { if (y < 60) { page = doc.addPage([595, 842]); y = 790; } page.drawText(line, { x: L, y, size, font: f, color: rgb(0.11, 0.11, 0.12) }); y -= size * 1.45; line = ''; };
    for (const w of words) { const t = line ? line + ' ' + w : w; if (f.widthOfTextAtSize(t, size) > W) { flush(); line = w; } else line = t; }
    if (line) flush(); y -= gap;
  };
  if (title) write(title, bold, 22, 10);
  for (const b of parseBlocks(md)) {
    if (b.t === 'h') write(b.text, bold, b.level === 1 ? 18 : 14, 4);
    else if (b.t === 'list') b.items.forEach((it, i) => write((b.ordered ? `${i + 1}. ` : '• ') + it, font, 11, 2));
    else if (b.t === 'table') [b.head, ...b.rows].forEach((r) => write(r.join('   |   '), font, 10, 1));
    else write(b.text, font, 11, 6);
  }
  return Buffer.from(await doc.save());
}

// ---------- charts (SVG, no dependencies)
function makeChartSvg({ type = 'bar', title = '', labels = [], series = [] }) {
  const W = 760, H = 420, P = { l: 60, r: 20, t: title ? 50 : 20, b: 70 };
  const colors = ['#0071e3', '#34c759', '#ff9f0a', '#af52de', '#ff375f', '#5ac8fa', '#ffd60a', '#8e8e93'];
  const s = series.map((x) => ({ name: x.name || '', values: (x.values || []).map(Number) }));
  let body = '';
  if (type === 'pie') {
    const vals = (s[0] || { values: [] }).values; const tot = vals.reduce((a, b) => a + Math.max(0, b), 0) || 1;
    let a0 = -Math.PI / 2; const cx = 250, cy = (H + P.t) / 2, r = 150;
    vals.forEach((v, i) => { const a1 = a0 + (Math.max(0, v) / tot) * Math.PI * 2; const large = a1 - a0 > Math.PI ? 1 : 0;
      body += `<path d="M${cx},${cy} L${cx + r * Math.cos(a0)},${cy + r * Math.sin(a0)} A${r},${r} 0 ${large} 1 ${cx + r * Math.cos(a1)},${cy + r * Math.sin(a1)} Z" fill="${colors[i % colors.length]}" stroke="#fff" stroke-width="2"/>`;
      body += `<rect x="470" y="${P.t + 20 + i * 26}" width="14" height="14" rx="3" fill="${colors[i % colors.length]}"/><text x="492" y="${P.t + 32 + i * 26}" font-size="13">${esc(labels[i] || '')} — ${Math.round((v / tot) * 1000) / 10}%</text>`;
      a0 = a1; });
  } else {
    const all = s.flatMap((x) => x.values); const max = Math.max(0, ...all) || 1, min = Math.min(0, ...all);
    const iw = W - P.l - P.r, ih = H - P.t - P.b; const Y = (v) => P.t + ih - ((v - min) / (max - min || 1)) * ih; const n = Math.max(1, labels.length);
    for (let k = 0; k <= 4; k++) { const v = min + ((max - min) * k) / 4; body += `<line x1="${P.l}" x2="${W - P.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="#e5e5ea"/><text x="${P.l - 8}" y="${Y(v) + 4}" font-size="11" text-anchor="end" fill="#8e8e93">${Math.round(v * 100) / 100}</text>`; }
    labels.forEach((lb, i) => { const x = P.l + (iw / n) * (i + 0.5); body += `<text x="${x}" y="${H - P.b + 18}" font-size="11" text-anchor="middle" fill="#6e6e73">${esc(String(lb).slice(0, 14))}</text>`; });
    s.forEach((se, si) => {
      const c = colors[si % colors.length];
      if (type === 'line') body += `<polyline fill="none" stroke="${c}" stroke-width="2.5" points="${se.values.map((v, i) => `${P.l + (iw / n) * (i + 0.5)},${Y(v)}`).join(' ')}"/>` + se.values.map((v, i) => `<circle cx="${P.l + (iw / n) * (i + 0.5)}" cy="${Y(v)}" r="3.5" fill="${c}"/>`).join('');
      else { const bw = (iw / n) * 0.7 / s.length; se.values.forEach((v, i) => { const x = P.l + (iw / n) * i + (iw / n) * 0.15 + bw * si; body += `<rect x="${x}" y="${Math.min(Y(v), Y(0))}" width="${bw - 2}" height="${Math.abs(Y(v) - Y(0))}" rx="3" fill="${c}"/>`; }); }
    });
    if (s.length > 1) s.forEach((se, si) => { body += `<rect x="${P.l + si * 150}" y="${H - 28}" width="12" height="12" rx="3" fill="${colors[si % colors.length]}"/><text x="${P.l + si * 150 + 18}" y="${H - 18}" font-size="12">${esc(se.name)}</text>`; });
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif" fill="#1d1d1f"><rect width="100%" height="100%" fill="#fff"/>${title ? `<text x="${P.l}" y="30" font-size="18" font-weight="600">${esc(title)}</text>` : ''}${body}</svg>`;
}

async function createDocument(args, dir, host) {
  const fmt = String(args.format || 'md').toLowerCase().replace(/^\./, '');
  const base = String(args.filename || args.title || 'Document').replace(/[\\/:*?"<>|]+/g, '-').replace(/\.[a-z0-9]+$/i, '').slice(0, 80) || 'Document';
  let buf;
  const content = args.content || '';
  if (fmt === 'docx') buf = await makeDocx(args.title, content);
  else if (fmt === 'pptx') buf = await makePptx(args.title, args.slides || [], args.theme);
  else if (fmt === 'xlsx') buf = await makeXlsx(args.sheets || []);
  else if (fmt === 'pdf') { const html = htmlPage(args.title || base, (args.title ? `<h1>${esc(args.title)}</h1>` : '') + (args.html || mdToHtml(content))); buf = host && host.htmlToPdf ? await host.htmlToPdf(html) : await makePdfPlain(args.title, content); }
  else if (fmt === 'html') buf = Buffer.from(args.html && /<html/i.test(args.html) ? args.html : htmlPage(args.title || base, (args.title ? `<h1>${esc(args.title)}</h1>` : '') + (args.html || mdToHtml(content))));
  else if (fmt === 'csv') buf = Buffer.from((args.sheets && args.sheets[0] ? args.sheets[0].rows : []).map((r) => r.map((c) => /[",\n]/.test(String(c ?? '')) ? `"${String(c).replace(/"/g, '""')}"` : String(c ?? '')).join(',')).join('\n'));
  else if (fmt === 'md' || fmt === 'txt') buf = Buffer.from((args.title && fmt === 'md' ? `# ${args.title}\n\n` : '') + content);
  else throw new Error('Unsupported format: ' + fmt + ' (use docx, pptx, xlsx, pdf, html, md, csv, txt)');
  fs.mkdirSync(dir, { recursive: true });
  let name = `${base}.${fmt}`, n = 2; while (fs.existsSync(path.join(dir, name))) name = `${base} (${n++}).${fmt}`;
  fs.writeFileSync(path.join(dir, name), buf);
  return { name, abs: path.join(dir, name), size: buf.length };
}

module.exports = { createDocument, makeChartSvg, mdToHtml, htmlPage, readXlsx, esc };
