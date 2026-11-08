'use strict';
/* ============================================================================
   Two more drawn sequences:
     CustomersScene — the phone, the texts and the website chat being answered
     BuildScene     — a sentence turning into a published website
   Both are composed on a 1440 x 820 grid and scaled to the configured size.
   ========================================================================== */
(function () {
  var W = 1440, H = 820;
  var BG = '#07090d', TEXT = '#eef1f5', DIM = '#8a94a4', LINE = 'rgba(255,255,255,.14)';
  var BLUE = '#5d7dff', GREEN = '#3ccf7a', VIOLET = '#6b4bff', PINK = '#ff4d8d', AMBER = '#f3b04a';
  var IMSG = '#2fd45e';

  function ease(t) { return t < 0 ? 0 : t > 1 ? 1 : 1 - Math.pow(1 - t, 3); }
  function seg(p, a, b) { return ease((p - a) / (b - a)); }
  function cl(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }
  function rr(c, x, y, w, h, r) {
    c.beginPath();
    if (c.roundRect) { c.roundRect(x, y, w, h, r); return; }
    c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }
  function txt(c, s, x, y, size, colour, weight, align, maxW) {
    c.font = (weight || 500) + ' ' + size + 'px Inter, system-ui, -apple-system, "Segoe UI", sans-serif';
    c.fillStyle = colour; c.textAlign = align || 'left'; c.textBaseline = 'alphabetic';
    if (maxW) c.fillText(s, x, y, maxW); else c.fillText(s, x, y);
  }
  // Breaks text on word boundaries for a given width — hand-slicing by character
  // count splits words in half and looks broken.
  function wrap(c, s, maxW, size, weight) {
    c.font = (weight || 500) + ' ' + size + 'px Inter, system-ui, -apple-system, "Segoe UI", sans-serif';
    var words = s.split(' '), lines = [], line = '';
    for (var i = 0; i < words.length; i++) {
      var test = line ? line + ' ' + words[i] : words[i];
      if (c.measureText(test).width > maxW && line) { lines.push(line); line = words[i]; }
      else line = test;
    }
    if (line) lines.push(line);
    return lines;
  }
  // reveals a wrapped block progressively, as if it were being typed
  function typeBlock(c, s, x, y, maxW, size, colour, weight, t, lineH) {
    var lines = wrap(c, s, maxW, size, weight);
    var total = s.length, shownChars = Math.round(total * Math.min(1, t)), used = 0;
    for (var i = 0; i < lines.length; i++) {
      if (used >= shownChars) break;
      var take = Math.min(lines[i].length, shownChars - used);
      txt(c, lines[i].slice(0, take), x, y + i * (lineH || size + 7), size, colour, weight);
      used += lines[i].length + 1;
    }
    return lines.length * (lineH || size + 7);
  }

  function shadowed(c, fn) { c.save(); c.shadowColor = 'rgba(0,0,0,.55)'; c.shadowBlur = 30; c.shadowOffsetY = 12; fn(); c.restore(); }
  function panel(c, x, y, w, h, appear, title, accent) {
    c.save(); c.globalAlpha = appear; c.translate(0, (1 - appear) * 16);
    shadowed(c, function () { c.fillStyle = 'rgba(255,255,255,.05)'; rr(c, x, y, w, h, 20); c.fill(); });
    c.strokeStyle = accent ? accent : LINE; c.lineWidth = accent ? 1.8 : 1.4; rr(c, x, y, w, h, 20); c.stroke();
    c.fillStyle = 'rgba(255,255,255,.04)'; rr(c, x, y, w, 46, 20); c.fill();
    c.fillStyle = LINE; c.fillRect(x, y + 46, w, 1.2);
    txt(c, title, x + 20, y + 29, 14.5, TEXT, 700, 'left', w - 40);
    c.restore();
  }
  // a chat bubble that can be revealed left-to-right like typing
  function bubble(c, x, y, w, lines, mine, t, lineH) {
    if (t <= 0) return 0;
    lineH = lineH || 22;
    var h = lines.length * lineH + 22;
    c.save();
    c.globalAlpha = Math.min(1, t * 3);
    c.fillStyle = mine ? BLUE : 'rgba(255,255,255,.09)';
    rr(c, x, y, w, h, 14); c.fill();
    var shown = Math.ceil(lines.length * Math.min(1, t));
    for (var i = 0; i < shown; i++) {
      var frac = Math.min(1, (t * lines.length) - i);
      var full = lines[i];
      var n = Math.max(1, Math.round(full.length * frac));
      txt(c, full.slice(0, n), x + 15, y + 26 + i * lineH, 14, mine ? '#fff' : TEXT, 500, 'left', w - 30);
    }
    c.restore();
    return h;
  }
  function orb(c, x, y, r, alpha) {
    c.save(); c.globalAlpha = alpha == null ? 1 : alpha;
    var g = c.createLinearGradient(x - r, y - r, x + r * .4, y + r);
    g.addColorStop(0, '#5e5ce6'); g.addColorStop(1, '#2f6df6');
    c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, 6.2832); c.fill();
    [['rgba(255,55,95,.85)', .3, -.4], ['rgba(255,159,10,.8)', .35, .35]].forEach(function (q) {
      var rg = c.createRadialGradient(x + r * q[1], y + r * q[2], 1, x + r * q[1], y + r * q[2], r * 1.05);
      rg.addColorStop(0, q[0]); rg.addColorStop(1, q[0].replace(/[\d.]+\)$/, '0)'));
      c.fillStyle = rg; c.beginPath(); c.arc(x, y, r, 0, 6.2832); c.fill();
    });
    var s = c.createRadialGradient(x - r * .3, y - r * .45, 1, x - r * .3, y - r * .45, r * .55);
    s.addColorStop(0, 'rgba(255,255,255,.8)'); s.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = s; c.beginPath(); c.arc(x, y, r, 0, 6.2832); c.fill();
    c.restore();
  }
  function base(size) {
    var ow = (size && size.w) || W, oh = (size && size.h) || H;
    var cv = document.createElement('canvas'); cv.width = ow; cv.height = oh;
    var c = cv.getContext('2d'); c.scale(ow / W, oh / H);
    c.fillStyle = BG; c.fillRect(0, 0, W, H);
    return { cv: cv, c: c };
  }
  function grid(c, a) {
    c.save(); c.globalAlpha = a * .35; c.fillStyle = 'rgba(255,255,255,.22)';
    for (var gx = 50; gx < W; gx += 44) for (var gy = 60; gy < H; gy += 44) c.fillRect(gx, gy, 2, 2);
    c.restore();
  }
  function glow(c, x, y, r, col, a) {
    if (a <= 0) return;
    var g = c.createRadialGradient(x, y, 10, x, y, r);
    g.addColorStop(0, col.replace(')', ',' + (0.22 * a).toFixed(3) + ')').replace('rgb(', 'rgba('));
    g.addColorStop(1, 'rgba(7,9,13,0)');
    c.fillStyle = g; c.fillRect(0, 0, W, H);
  }

  /* ========================= CUSTOMERS ================================== */
  window.CustomersScene = { W: W, H: H, render: function (i, n, size) {
    var p = n === 1 ? 1 : i / (n - 1);
    var b = base(size), c = b.c;
    grid(c, seg(p, 0, .07) * (1 - seg(p, .85, 1) * .5));
    glow(c, 720, 400, 460, 'rgb(93,125,255)', seg(p, .04, .2));

    var y0 = 180, ph = 470;
    // ---- the phone ----
    var a1 = seg(p, .05, .16);
    if (a1 > 0) {
      panel(c, 90, y0, 380, ph, a1, 'Phone line · 06 835 1180', seg(p, .2, .3) > 0 && p < .5 ? 'rgba(93,125,255,.6)' : null);
      c.save(); c.globalAlpha = a1;
      var ring = seg(p, .18, .24) * (1 - seg(p, .3, .36));
      if (ring > 0) {
        c.strokeStyle = 'rgba(93,125,255,' + (0.5 * ring).toFixed(2) + ')'; c.lineWidth = 2;
        for (var k = 0; k < 3; k++) {
          var rr2 = 30 + ((p * 9 + k * .33) % 1) * 44;
          c.globalAlpha = a1 * ring * (1 - ((p * 9 + k * .33) % 1));
          c.beginPath(); c.arc(280, y0 + 130, rr2, 0, 6.2832); c.stroke();
        }
        c.globalAlpha = a1;
      }
      // handset
      c.save();
      c.translate(280, y0 + 130); c.rotate(-0.4);
      c.strokeStyle = seg(p, .24, .3) > .5 ? GREEN : BLUE;
      c.fillStyle = c.strokeStyle; c.lineWidth = 7; c.lineCap = 'round'; c.lineJoin = 'round';
      c.beginPath();
      c.moveTo(-14, -20); c.lineTo(-8, -6); c.lineTo(-14, 1);
      c.quadraticCurveTo(-2, 16, 13, 10);
      c.lineTo(19, 24); c.stroke();
      c.restore();
      txt(c, seg(p, .26, .32) > .5 ? 'Answered' : 'Incoming call', 280, y0 + 192, 15, seg(p, .26, .32) > .5 ? GREEN : TEXT, 700, 'center');
      txt(c, 'Marcus Johnson', 280, y0 + 216, 13.5, DIM, 500, 'center');
      // transcript
      var tl = [['Caller', 'Are you open on Sunday?', .34], ['ForgeAI', 'We are — eleven to five, last tasting at half four.', .40]];
      var ty = y0 + 250;
      tl.forEach(function (row) {
        var t = seg(p, row[2], row[2] + .07);
        if (t <= 0) return;
        c.globalAlpha = a1 * Math.min(1, t * 2);
        txt(c, row[0], 120, ty, 12, row[0] === 'Caller' ? DIM : BLUE, 700);
        var h = typeBlock(c, row[1], 120, ty + 22, 300, 14, TEXT, 500, t, 21);
        ty += h + 34;
      });
      c.restore();
    }

    // ---- iMessage ----
    var a2 = seg(p, .09, .20);
    if (a2 > 0) {
      panel(c, 530, y0, 380, ph, a2, 'Messages · iMessage', p > .44 && p < .72 ? 'rgba(47,212,94,.55)' : null);
      c.save(); c.globalAlpha = a2;
      var by = y0 + 74;
      var h1 = bubble(c, 556, by, 250, ['Hi — can I move my', 'tasting to Saturday?'], false, seg(p, .46, .52));
      if (h1) by += h1 + 14;
      var typing = seg(p, .53, .57) * (1 - seg(p, .58, .62));
      if (typing > 0) {
        c.globalAlpha = a2 * typing;
        c.fillStyle = 'rgba(255,255,255,.09)'; rr(c, 556, by, 76, 38, 14); c.fill();
        for (var d = 0; d < 3; d++) {
          c.globalAlpha = a2 * typing * (0.45 + 0.55 * Math.abs(Math.sin(p * 30 + d)));
          c.fillStyle = DIM; c.beginPath(); c.arc(576 + d * 18, by + 19, 4.5, 0, 6.2832); c.fill();
        }
        c.globalAlpha = a2;
      }
      var h2 = bubble(c, 634, by, 250, ['Done — Saturday 2pm,', 'four people. Confirmation', 'is on its way.'], true, seg(p, .60, .68));
      if (h2) by += h2 + 14;
      var note = seg(p, .68, .74);
      if (note > 0) {
        c.globalAlpha = a2 * note;
        txt(c, '✓ Calendar updated · booking moved', 556, by + 18, 12.5, GREEN, 600);
      }
      c.restore();
    }

    // ---- website chat ----
    var a3 = seg(p, .13, .24);
    if (a3 > 0) {
      panel(c, 970, y0, 380, ph, a3, 'Your website · live chat', p > .70 ? 'rgba(107,75,255,.55)' : null);
      c.save(); c.globalAlpha = a3;
      // a little page behind the widget
      c.fillStyle = 'rgba(255,255,255,.04)'; rr(c, 994, y0 + 70, 332, 150, 10); c.fill();
      c.fillStyle = 'rgba(255,255,255,.1)'; rr(c, 1010, y0 + 90, 120, 12, 6); c.fill();
      rr(c, 1010, y0 + 112, 240, 9, 4.5); c.fill();
      rr(c, 1010, y0 + 130, 210, 9, 4.5); c.fill();
      var wy = y0 + 250;
      var hb1 = bubble(c, 996, wy, 250, ['Do you ship to Auckland?'], false, seg(p, .72, .77));
      if (hb1) wy += hb1 + 12;
      var hb2 = bubble(c, 1074, wy, 250, ['Yes — overnight courier,', 'free over six bottles.'], true, seg(p, .78, .86));
      if (hb2) wy += hb2 + 12;
      var hand = seg(p, .86, .92);
      if (hand > 0) {
        c.globalAlpha = a3 * hand;
        txt(c, '✓ Answered from your own notes', 996, wy + 16, 12.5, VIOLET, 600);
      }
      c.restore();
    }

    // ---- the orb underneath it all ----
    var oa = seg(p, .03, .14);
    if (oa > 0) {
      orb(c, 720, 712, 30, oa);
      txt(c, 'One ForgeAI, three front doors', 720, 772, 15, TEXT, 700, 'center');
    }
    return b.cv;
  } };

  /* ========================= BUILDS ===================================== */
  window.BuildScene = { W: W, H: H, render: function (i, n, size) {
    var p = n === 1 ? 1 : i / (n - 1);
    var b = base(size), c = b.c;
    grid(c, seg(p, 0, .07) * (1 - seg(p, .6, .9) * .6));
    glow(c, 720, 430, 500, 'rgb(107,75,255)', seg(p, .05, .25));

    // ---- the sentence you type ----
    var ask = 'Build a one-page site for the cellar door — tasting times, a booking form, and the photo of the terrace.';
    var at = seg(p, .02, .22);
    if (at > 0) {
      var bw = 980, bx = 720 - bw / 2, by = 92;
      c.save(); c.globalAlpha = Math.min(1, at * 4);
      shadowed(c, function () { c.fillStyle = 'rgba(255,255,255,.06)'; rr(c, bx, by, bw, 64, 16); c.fill(); });
      c.strokeStyle = LINE; c.lineWidth = 1.4; rr(c, bx, by, bw, 64, 16); c.stroke();
      orb(c, bx + 34, by + 32, 14, 1);
      var shown = ask.slice(0, Math.max(1, Math.round(ask.length * at)));
      txt(c, shown, bx + 60, by + 38, 15.5, TEXT, 500, 'left', bw - 110);
      if (at < 1) { c.fillStyle = BLUE; c.fillRect(bx + 62 + c.measureText(shown).width + 3, by + 22, 2.5, 22); }
      c.restore();
    }

    // ---- the browser window building itself ----
    var wx = 300, wy = 210, ww = 840, wh = 470;
    var sh = seg(p, .20, .32);
    if (sh > 0) {
      c.save(); c.globalAlpha = sh; c.translate(0, (1 - sh) * 20);
      shadowed(c, function () { c.fillStyle = '#11151d'; rr(c, wx, wy, ww, wh, 16); c.fill(); });
      c.strokeStyle = LINE; c.lineWidth = 1.5; rr(c, wx, wy, ww, wh, 16); c.stroke();
      c.fillStyle = 'rgba(255,255,255,.05)'; rr(c, wx, wy, ww, 42, 16); c.fill();
      c.fillStyle = LINE; c.fillRect(wx, wy + 42, ww, 1.2);
      ['#ff5f57', '#febc2e', '#28c840'].forEach(function (col, k) {
        c.fillStyle = col; c.beginPath(); c.arc(wx + 26 + k * 20, wy + 21, 6, 0, 6.2832); c.fill();
      });
      // address pill, filled in once published
      var pub = seg(p, .80, .90);
      c.fillStyle = 'rgba(255,255,255,.07)'; rr(c, wx + 100, wy + 10, 300, 22, 11); c.fill();
      if (pub > 0) {
        c.globalAlpha = sh * pub;
        txt(c, 'hillcountry.forge.site/cellar-door', wx + 250, wy + 26, 12.5, GREEN, 600, 'center');
        c.globalAlpha = sh;
      }

      // blocks appearing in order: nav, hero, headline, text, image, form, button
      var blocks = [
        { t: .33, x: 24, y: 64, w: 140, h: 14, r: 7, col: 'rgba(255,255,255,.5)' },
        { t: .35, x: ww - 220, y: 64, w: 60, h: 12, r: 6, col: 'rgba(255,255,255,.22)' },
        { t: .36, x: ww - 148, y: 64, w: 60, h: 12, r: 6, col: 'rgba(255,255,255,.22)' },
        { t: .40, x: 24, y: 104, w: ww - 48, h: 150, r: 12, col: 'rgba(107,75,255,.30)', photo: true },
        { t: .50, x: 24, y: 272, w: 360, h: 22, r: 7, col: 'rgba(255,255,255,.72)' },
        { t: .53, x: 24, y: 306, w: 300, h: 12, r: 6, col: 'rgba(255,255,255,.3)' },
        { t: .55, x: 24, y: 326, w: 250, h: 12, r: 6, col: 'rgba(255,255,255,.3)' },
        { t: .58, x: 24, y: 360, w: 170, h: 12, r: 6, col: 'rgba(60,207,122,.75)' },
        { t: .60, x: 24, y: 380, w: 150, h: 12, r: 6, col: 'rgba(255,255,255,.3)' },
        { t: .64, x: 430, y: 272, w: ww - 478, h: 44, r: 10, col: 'rgba(255,255,255,.10)', field: true },
        { t: .67, x: 430, y: 326, w: ww - 478, h: 44, r: 10, col: 'rgba(255,255,255,.10)', field: true },
        { t: .70, x: 430, y: 380, w: 170, h: 40, r: 10, col: 'rgba(93,125,255,.95)', cta: true }
      ];
      blocks.forEach(function (bl) {
        var t = seg(p, bl.t, bl.t + .05);
        if (t <= 0) return;
        c.save(); c.globalAlpha = sh * Math.min(1, t * 1.6); c.translate(0, (1 - t) * 8);
        c.fillStyle = bl.col; rr(c, wx + bl.x, wy + 56 + bl.y, bl.w, bl.h, bl.r); c.fill();
        if (bl.photo) {
          // a suggestion of a photo: horizon and sun
          c.fillStyle = 'rgba(255,159,10,.5)'; c.beginPath(); c.arc(wx + bl.x + bl.w - 90, wy + 56 + bl.y + 52, 22, 0, 6.2832); c.fill();
          c.fillStyle = 'rgba(255,255,255,.12)'; rr(c, wx + bl.x, wy + 56 + bl.y + 96, bl.w, 54, 0); c.fill();
        }
        if (bl.field) { c.fillStyle = 'rgba(255,255,255,.22)'; rr(c, wx + bl.x + 14, wy + 56 + bl.y + 16, 110, 10, 5); c.fill(); }
        if (bl.cta) { c.fillStyle = '#fff'; rr(c, wx + bl.x + 38, wy + 56 + bl.y + 15, 94, 10, 5); c.fill(); }
        c.restore();
      });
      c.restore();
    }

    // ---- published: the share link ----
    var pubCard = seg(p, .84, .93);
    if (pubCard > 0) {
      var cw = 520, cx2 = 720 - cw / 2, cy2 = 712;
      c.save(); c.globalAlpha = pubCard; c.translate(0, (1 - pubCard) * 14);
      shadowed(c, function () { c.fillStyle = 'rgba(60,207,122,.12)'; rr(c, cx2, cy2, cw, 74, 16); c.fill(); });
      c.strokeStyle = 'rgba(60,207,122,.5)'; c.lineWidth = 1.6; rr(c, cx2, cy2, cw, 74, 16); c.stroke();
      c.strokeStyle = GREEN; c.lineWidth = 3; c.lineCap = 'round';
      c.beginPath(); c.moveTo(cx2 + 28, cy2 + 38); c.lineTo(cx2 + 36, cy2 + 46); c.lineTo(cx2 + 52, cy2 + 28); c.stroke();
      txt(c, 'Published — link ready to send', cx2 + 72, cy2 + 32, 15.5, TEXT, 700);
      txt(c, 'Hosted by ForgeAI, or pushed to your own web host', cx2 + 72, cy2 + 54, 13, DIM, 500, 'left', 400);
      c.restore();
    }
    return b.cv;
  } };
})();
