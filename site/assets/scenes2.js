'use strict';
/* ============================================================================
   ScaleScene — one computer growing into an office, then two sites
   TrainScene — your examples turning into a model that writes like you
   Composed on 1440 x 820 and scaled to the configured size.
   ========================================================================== */
(function () {
  var W = 1440, H = 820;
  var BG = '#07090d', TEXT = '#eef1f5', DIM = '#8a94a4', LINE = 'rgba(255,255,255,.14)';
  var BLUE = '#5d7dff', GREEN = '#3ccf7a', VIOLET = '#6b4bff', PINK = '#ff4d8d', AMBER = '#f3b04a';

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
  function wrap(c, s, maxW, size, weight) {
    c.font = (weight || 500) + ' ' + size + 'px Inter, system-ui, sans-serif';
    var words = s.split(' '), lines = [], line = '';
    for (var i = 0; i < words.length; i++) {
      var test = line ? line + ' ' + words[i] : words[i];
      if (c.measureText(test).width > maxW && line) { lines.push(line); line = words[i]; } else line = test;
    }
    if (line) lines.push(line);
    return lines;
  }
  function shadowed(c, fn) { c.save(); c.shadowColor = 'rgba(0,0,0,.55)'; c.shadowBlur = 30; c.shadowOffsetY = 12; fn(); c.restore(); }
  function orb(c, x, y, r, alpha) {
    c.save(); c.globalAlpha = alpha == null ? 1 : alpha;
    var g = c.createLinearGradient(x - r, y - r, x + r * .4, y + r);
    g.addColorStop(0, '#5e5ce6'); g.addColorStop(1, '#2f6df6');
    c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, 6.2832); c.fill();
    [['rgba(255,55,95,', .3, -.4], ['rgba(255,159,10,', .35, .35]].forEach(function (q) {
      var rg = c.createRadialGradient(x + r * q[1], y + r * q[2], 1, x + r * q[1], y + r * q[2], r * 1.05);
      rg.addColorStop(0, q[0] + '.85)'); rg.addColorStop(1, q[0] + '0)');
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
    c.save(); c.globalAlpha = a * .32; c.fillStyle = 'rgba(255,255,255,.22)';
    for (var gx = 50; gx < W; gx += 44) for (var gy = 60; gy < H; gy += 44) c.fillRect(gx, gy, 2, 2);
    c.restore();
  }
  function glow(c, x, y, r, rgb, a) {
    if (a <= 0) return;
    var g = c.createRadialGradient(x, y, 10, x, y, r);
    g.addColorStop(0, 'rgba(' + rgb + ',' + (0.2 * a).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(7,9,13,0)');
    c.fillStyle = g; c.fillRect(0, 0, W, H);
  }
  // a laptop seen head-on
  function laptop(c, x, y, w, appear, label, lit) {
    if (appear <= 0) return;
    var h = w * 0.62;
    c.save(); c.globalAlpha = appear; c.translate(0, (1 - appear) * 14);
    shadowed(c, function () { c.fillStyle = '#141922'; rr(c, x - w / 2, y - h / 2, w, h, 9); c.fill(); });
    c.strokeStyle = lit ? 'rgba(93,125,255,.75)' : LINE; c.lineWidth = lit ? 2 : 1.4;
    rr(c, x - w / 2, y - h / 2, w, h, 9); c.stroke();
    c.fillStyle = lit ? 'rgba(93,125,255,.14)' : 'rgba(255,255,255,.05)';
    rr(c, x - w / 2 + 7, y - h / 2 + 7, w - 14, h - 14, 6); c.fill();
    // base
    c.fillStyle = '#1b2130'; rr(c, x - w * 0.62, y + h / 2 + 3, w * 1.24, 7, 3.5); c.fill();
    if (label) txt(c, label, x, y + h / 2 + 32, 13.5, DIM, 600, 'center');
    c.restore();
  }
  function person(c, x, y, s, appear, colour) {
    if (appear <= 0) return;
    c.save(); c.globalAlpha = appear;
    c.fillStyle = colour || 'rgba(255,255,255,.55)';
    c.beginPath(); c.arc(x, y - s * .55, s * .42, 0, 6.2832); c.fill();
    c.beginPath(); c.arc(x, y + s * .55, s * .78, Math.PI, 0); c.fill();
    c.restore();
  }

  /* ========================= SCALE ====================================== */
  window.ScaleScene = { W: W, H: H, render: function (i, n, size) {
    var p = n === 1 ? 1 : i / (n - 1);
    var b = base(size), c = b.c;
    grid(c, seg(p, 0, .06) * (1 - seg(p, .85, 1) * .4));
    glow(c, 720, 400, 480, '93,125,255', seg(p, .03, .18));

    // --- one computer ---
    var one = seg(p, .03, .14);
    laptop(c, 720, 400, 190, one, 'Your Mac', true);
    if (one > 0) orb(c, 720, 400, 26, one);
    if (one > 0 && p < .2) txt(c, 'One person. One computer. Free.', 720, 520, 15.5, TEXT, 600, 'center');

    // --- more computers join ---
    var mates = [
      { x: 420, y: 300, w: 150, t: .20, label: 'Office PC' },
      { x: 1020, y: 300, w: 150, t: .24, label: 'Art-room PC' },
      { x: 720, y: 158, w: 140, t: .28, label: 'Server in the cupboard' }
    ];
    mates.forEach(function (m) {
      var a = seg(p, m.t, m.t + .10);
      if (a <= 0) return;
      laptop(c, m.x, m.y, m.w, a, m.label, p > m.t + .12);
      // joining line + the code travelling along it
      c.save(); c.globalAlpha = a * .55;
      c.strokeStyle = 'rgba(255,255,255,.3)'; c.lineWidth = 1.5; c.setLineDash([5, 7]);
      c.beginPath(); c.moveTo(m.x, m.y); c.lineTo(720, 400); c.stroke();
      c.restore();
      var send = cl((p - m.t) / .09);
      if (send > 0 && send < 1) {
        var px = m.x + (720 - m.x) * ease(send), py = m.y + (400 - m.y) * ease(send);
        c.save(); c.globalAlpha = a; c.fillStyle = BLUE;
        rr(c, px - 26, py - 12, 52, 24, 7); c.fill();
        txt(c, '4821', px, py + 5, 12.5, '#fff', 700, 'center');
        c.restore();
      }
    });
    if (p > .30 && p < .48) txt(c, 'Joined with a four-digit code — they share models and memory', 720, 620, 15.5, TEXT, 600, 'center');

    // --- people ---
    var folk = [[300, 560, PINK], [430, 600, BLUE], [560, 622, VIOLET], [880, 622, GREEN], [1010, 600, AMBER], [1140, 560, BLUE]];
    folk.forEach(function (f, k) {
      var a = seg(p, .46 + k * .022, .56 + k * .022);
      if (a <= 0) return;
      person(c, f[0], f[1], 22, a, f[2]);
      c.save(); c.globalAlpha = a * .4; c.strokeStyle = 'rgba(255,255,255,.25)'; c.lineWidth = 1.2; c.setLineDash([4, 6]);
      c.beginPath(); c.moveTo(f[0], f[1] - 26); c.lineTo(720, 430); c.stroke(); c.restore();
    });
    if (p > .58 && p < .70) txt(c, 'Everyone in the building, from their own machine', 720, 700, 15.5, TEXT, 600, 'center');

    // --- a second site ---
    var site2 = seg(p, .70, .82);
    if (site2 > 0) {
      c.save(); c.globalAlpha = site2;
      // two buildings
      [[300, 180, 'Hastings'], [1140, 180, 'Napier']].forEach(function (bd, k) {
        var a = seg(p, .70 + k * .04, .80 + k * .04);
        if (a <= 0) return;
        c.globalAlpha = site2 * a;
        shadowed(c, function () { c.fillStyle = 'rgba(255,255,255,.06)'; rr(c, bd[0] - 70, bd[1] - 52, 140, 104, 12); c.fill(); });
        c.strokeStyle = LINE; c.lineWidth = 1.4; rr(c, bd[0] - 70, bd[1] - 52, 140, 104, 12); c.stroke();
        c.fillStyle = 'rgba(93,125,255,.35)';
        for (var wx = 0; wx < 3; wx++) for (var wy = 0; wy < 2; wy++) rr(c, bd[0] - 48 + wx * 34, bd[1] - 30 + wy * 32, 22, 20, 4), c.fill();
        txt(c, bd[2], bd[0], bd[1] + 74, 13.5, DIM, 600, 'center');
      });
      c.globalAlpha = site2 * .6;
      c.strokeStyle = 'rgba(60,207,122,.6)'; c.lineWidth = 2; c.setLineDash([7, 9]);
      c.beginPath(); c.moveTo(370, 180); c.lineTo(1070, 180); c.stroke();
      c.setLineDash([]);
      c.globalAlpha = site2;
      txt(c, 'linked privately', 720, 172, 12.5, GREEN, 600, 'center');
      c.restore();
    }

    // --- tally ---
    var tally = seg(p, .86, .96);
    if (tally > 0) {
      var items = [['12', 'people'], ['4', 'computers'], ['2', 'sites'], ['$0', 'per month']];
      var colW = 180, sx = 720 - (items.length - 1) * colW / 2;
      c.save();
      items.forEach(function (it, k) {
        c.globalAlpha = tally * cl((tally - k * .08) * 2);
        txt(c, it[0], sx + k * colW, 752, 34, k === 3 ? GREEN : TEXT, 800, 'center');
        txt(c, it[1], sx + k * colW, 776, 13, DIM, 500, 'center');
      });
      c.restore();
    }
    return b.cv;
  } };

  /* ========================= TRAINING =================================== */
  window.TrainScene = { W: W, H: H, render: function (i, n, size) {
    var p = n === 1 ? 1 : i / (n - 1);
    var b = base(size), c = b.c;
    grid(c, seg(p, 0, .06) * (1 - seg(p, .8, 1) * .5));
    glow(c, 720, 400, 460, '107,75,255', seg(p, .04, .2));

    // --- the examples ---
    var EX = [
      ['Customer asks for trade pricing', 'Quote the March trade list, never retail'],
      ['Someone asks about Sunday', 'Open 11–5, last tasting 4:30'],
      ['Order confirmation', 'Short, warm, sign off “Ashton”'],
      ['Shipping question', 'Overnight courier, free over six bottles']
    ];
    var cardsX = 150, cardsY = 190, cw = 390;
    EX.forEach(function (e, k) {
      var a = seg(p, .04 + k * .035, .16 + k * .035);
      if (a <= 0) return;
      var y = cardsY + k * 104;
      // cards slide to the right as training begins
      var pull = seg(p, .30, .46);
      var x = cardsX + pull * 180;
      c.save(); c.globalAlpha = a * (1 - seg(p, .44, .54) * .75);
      c.translate((1 - a) * -20, 0);
      shadowed(c, function () { c.fillStyle = 'rgba(255,255,255,.055)'; rr(c, x, y, cw, 86, 14); c.fill(); });
      c.strokeStyle = LINE; c.lineWidth = 1.3; rr(c, x, y, cw, 86, 14); c.stroke();
      txt(c, 'You ask', x + 18, y + 26, 11.5, DIM, 700);
      txt(c, e[0], x + 18, y + 46, 13.5, TEXT, 500, 'left', cw - 36);
      txt(c, '→ ' + e[1], x + 18, y + 70, 13, BLUE, 500, 'left', cw - 36);
      c.restore();
    });
    if (p < .28) txt(c, 'Examples you write once', cardsX + cw / 2, 160, 14, DIM, 700, 'center');

    // --- the trainer ---
    var tr = seg(p, .26, .38);
    var bx = 760, by = 230, bw = 520, bh = 300;
    if (tr > 0) {
      c.save(); c.globalAlpha = tr; c.translate(0, (1 - tr) * 16);
      shadowed(c, function () { c.fillStyle = 'rgba(255,255,255,.05)'; rr(c, bx, by, bw, bh, 18); c.fill(); });
      c.strokeStyle = p > .36 && p < .72 ? 'rgba(107,75,255,.6)' : LINE; c.lineWidth = p > .36 && p < .72 ? 2 : 1.4;
      rr(c, bx, by, bw, bh, 18); c.stroke();
      txt(c, 'Training', bx + 24, by + 36, 16, TEXT, 700);
      txt(c, 'LoRA · Qwen 3 4B · 200 steps', bx + 24, by + 58, 13, DIM, 500);

      // loss curve
      var prog = cl((p - .38) / .32);
      var gx = bx + 24, gy = by + 98, gw = bw - 48, gh = 118;
      c.strokeStyle = 'rgba(255,255,255,.1)'; c.lineWidth = 1;
      for (var l = 0; l <= 3; l++) { c.beginPath(); c.moveTo(gx, gy + l * gh / 3); c.lineTo(gx + gw, gy + l * gh / 3); c.stroke(); }
      if (prog > 0) {
        c.strokeStyle = VIOLET; c.lineWidth = 2.4; c.lineJoin = 'round'; c.beginPath();
        for (var s2 = 0; s2 <= 60 * prog; s2++) {
          var u = s2 / 60;
          var loss = Math.exp(-u * 3.1) * .8 + .12 + Math.sin(u * 22) * .012;
          var px = gx + u * gw, py = gy + loss * gh;
          if (s2 === 0) c.moveTo(px, py); else c.lineTo(px, py);
        }
        c.stroke();
        var lastU = prog, lastLoss = Math.exp(-lastU * 3.1) * .8 + .12;
        c.fillStyle = VIOLET; c.beginPath(); c.arc(gx + lastU * gw, gy + lastLoss * gh, 4.5, 0, 6.2832); c.fill();
      }
      txt(c, 'loss', gx, gy - 12, 11.5, DIM, 600);
      // progress bar
      var pbY = by + bh - 52;
      c.fillStyle = 'rgba(255,255,255,.08)'; rr(c, bx + 24, pbY, bw - 48, 10, 5); c.fill();
      c.fillStyle = VIOLET; rr(c, bx + 24, pbY, (bw - 48) * prog, 10, 5); c.fill();
      txt(c, prog >= 1 ? 'Finished · 4 min 12 s on this Mac' : Math.round(prog * 200) + ' of 200 steps', bx + 24, pbY + 32, 13, prog >= 1 ? GREEN : DIM, 600);
      c.restore();
    }

    // --- the adapter clipping onto the base model ---
    var ad = seg(p, .70, .80);
    if (ad > 0) {
      c.save(); c.globalAlpha = ad;
      var mx = 430, my = 600;
      shadowed(c, function () { c.fillStyle = 'rgba(255,255,255,.06)'; rr(c, mx, my, 250, 86, 14); c.fill(); });
      c.strokeStyle = LINE; c.lineWidth = 1.4; rr(c, mx, my, 250, 86, 14); c.stroke();
      txt(c, 'Qwen 3 4B', mx + 20, my + 34, 15, TEXT, 700);
      txt(c, 'base model — unchanged', mx + 20, my + 58, 12.5, DIM, 500);
      // the adapter slides in and clicks on
      var slide = ease(ad);
      var ax = mx + 268 + (1 - slide) * 90;
      c.fillStyle = 'rgba(107,75,255,.2)'; rr(c, ax, my + 10, 150, 66, 12); c.fill();
      c.strokeStyle = 'rgba(107,75,255,.8)'; c.lineWidth = 1.8; rr(c, ax, my + 10, 150, 66, 12); c.stroke();
      txt(c, 'Your adapter', ax + 16, my + 36, 13.5, VIOLET, 700);
      txt(c, '18 MB', ax + 16, my + 56, 12, DIM, 500);
      c.restore();
    }

    // --- it answers in your voice ---
    var out = seg(p, .82, .94);
    if (out > 0) {
      c.save(); c.globalAlpha = out;
      var ox = 790, oy = 586, ow2 = 470;
      var lines = wrap(c, 'Hi Marcus — 12 × Reserve Pinot at the March trade price, $28.50 + GST. Thursday delivery. Ashton', ow2 - 40, 14.5, 500);
      var oh2 = lines.length * 22 + 60;
      shadowed(c, function () { c.fillStyle = 'rgba(60,207,122,.10)'; rr(c, ox, oy, ow2, oh2, 16); c.fill(); });
      c.strokeStyle = 'rgba(60,207,122,.45)'; c.lineWidth = 1.5; rr(c, ox, oy, ow2, oh2, 16); c.stroke();
      txt(c, 'Now it answers like you', ox + 20, oy + 30, 13.5, GREEN, 700);
      lines.forEach(function (ln, k) { txt(c, ln, ox + 20, oy + 56 + k * 22, 14.5, TEXT, 500); });
      c.restore();
    }
    return b.cv;
  } };
})();
