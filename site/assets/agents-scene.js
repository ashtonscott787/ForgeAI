'use strict';
/* ============================================================================
   "The back office" — a drawn sequence for the agents page.
   Each frame is rendered once into its own canvas, so scrubbing is just a blit.
   Composed on a 1440 x 900 grid and scaled to whatever size is configured.
   ========================================================================== */
window.AgentsScene = (function () {
  var W = 1440, H = 820;
  var BG = '#07090d', CARD = 'rgba(255,255,255,.055)', LINE = 'rgba(255,255,255,.14)';
  var TEXT = '#eef1f5', DIM = '#8a94a4', BLUE = '#5d7dff', VIOLET = '#6b4bff', PINK = '#ff4d8d', GREEN = '#3ccf7a', AMBER = '#f3b04a';

  var AGENTS = [
    { name: 'Inbox triage',       job: 'Sorting overnight mail',     x: 230, y: 168, colour: BLUE },
    { name: 'Invoice chaser',     job: 'Checking what is overdue',   x: 910, y: 168, colour: AMBER },
    { name: 'Website watch',      job: 'Opening the site',           x: 230, y: 520, colour: VIOLET },
    { name: 'Cellar door weekly', job: 'Counting this week',         x: 910, y: 520, colour: PINK }
  ];
  var CX = 720, CY = 372;

  /* ---------- helpers ---------- */
  function ease(t) { return t < 0 ? 0 : t > 1 ? 1 : 1 - Math.pow(1 - t, 3); }
  function seg(p, a, b) { return ease((p - a) / (b - a)); }
  function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }
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
  // quadratic path from a to b, bowed away from the centre
  function along(ax, ay, bx, by, t, bow) {
    var mx = (ax + bx) / 2, my = (ay + by) / 2;
    var dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    var nx = -dy / len, ny = dx / len;
    var cx = mx + nx * (bow || 70), cy = my + ny * (bow || 70);
    var u = 1 - t;
    return { x: u * u * ax + 2 * u * t * cx + t * t * bx, y: u * u * ay + 2 * u * t * cy + t * t * by };
  }
  function orb(c, x, y, r, alpha) {
    c.save(); c.globalAlpha = alpha == null ? 1 : alpha;
    var g = c.createLinearGradient(x - r, y - r, x + r * .4, y + r);
    g.addColorStop(0, '#5e5ce6'); g.addColorStop(1, '#2f6df6');
    c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, 6.2832); c.fill();
    var p = c.createRadialGradient(x + r * .3, y - r * .4, 1, x + r * .3, y - r * .4, r * 1.1);
    p.addColorStop(0, 'rgba(255,55,95,.85)'); p.addColorStop(1, 'rgba(255,55,95,0)');
    c.fillStyle = p; c.beginPath(); c.arc(x, y, r, 0, 6.2832); c.fill();
    var o = c.createRadialGradient(x + r * .35, y + r * .35, 1, x + r * .35, y + r * .35, r);
    o.addColorStop(0, 'rgba(255,159,10,.8)'); o.addColorStop(1, 'rgba(255,159,10,0)');
    c.fillStyle = o; c.beginPath(); c.arc(x, y, r, 0, 6.2832); c.fill();
    var s = c.createRadialGradient(x - r * .3, y - r * .45, 1, x - r * .3, y - r * .45, r * .55);
    s.addColorStop(0, 'rgba(255,255,255,.8)'); s.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = s; c.beginPath(); c.arc(x, y, r, 0, 6.2832); c.fill();
    c.restore();
  }
  // a small envelope / document / page glyph used for the work packets
  function packet(c, x, y, kind, scale, alpha) {
    c.save(); c.globalAlpha = alpha == null ? 1 : alpha;
    c.translate(x, y); c.scale(scale || 1, scale || 1);
    var col = kind === 'mail' ? BLUE : kind === 'money' ? AMBER : kind === 'page' ? VIOLET : GREEN;
    c.shadowColor = col; c.shadowBlur = 16;
    c.fillStyle = col; rr(c, -13, -10, 26, 20, 5); c.fill();
    c.shadowBlur = 0;
    c.strokeStyle = 'rgba(255,255,255,.85)'; c.lineWidth = 1.6; c.lineCap = 'round';
    if (kind === 'mail') { c.beginPath(); c.moveTo(-8, -4); c.lineTo(0, 3); c.lineTo(8, -4); c.stroke(); }
    else if (kind === 'money') { c.beginPath(); c.moveTo(0, -6); c.lineTo(0, 6); c.moveTo(-4, -2); c.lineTo(4, 2); c.stroke(); }
    else { c.beginPath(); c.moveTo(-6, -3); c.lineTo(6, -3); c.moveTo(-6, 1); c.lineTo(3, 1); c.stroke(); }
    c.restore();
  }
  function deskCard(c, a, appear, busy, done, p) {
    var w = 300, h = 96, x = a.x, y = a.y;
    c.save();
    c.globalAlpha = appear;
    c.translate(0, (1 - appear) * 18);
    c.save();
    c.shadowColor = 'rgba(0,0,0,.5)'; c.shadowBlur = 30; c.shadowOffsetY = 10;
    c.fillStyle = CARD; rr(c, x, y, w, h, 18); c.fill();
    c.restore();
    c.strokeStyle = busy > 0 && done < 1
      ? 'rgba(' + (a.colour === BLUE ? '93,125,255' : a.colour === AMBER ? '243,176,74' : a.colour === VIOLET ? '107,75,255' : '255,77,141') + ',.75)'
      : LINE;
    c.lineWidth = busy > 0 && done < 1 ? 2 : 1.4;
    rr(c, x, y, w, h, 18); c.stroke();

    // avatar
    c.fillStyle = a.colour; c.globalAlpha = appear * .22;
    c.beginPath(); c.arc(x + 42, y + 48, 21, 0, 6.2832); c.fill();
    c.globalAlpha = appear;
    c.fillStyle = a.colour;
    c.beginPath(); c.arc(x + 42, y + 42, 7.5, 0, 6.2832); c.fill();
    c.beginPath(); c.arc(x + 42, y + 60, 13, Math.PI, 0); c.fill();

    txt(c, a.name, x + 76, y + 40, 17, TEXT, 700, 'left', 160);
    txt(c, done >= 1 ? 'Done · handed back' : busy > 0 ? a.job + '…' : 'Waiting', x + 76, y + 63, 14, done >= 1 ? GREEN : DIM, 500, 'left', 170);

    // working ring, tucked into the corner
    if (busy > 0 && done < 1) {
      var r = 11, cx = x + w - 28, cy = y + 30;
      c.strokeStyle = 'rgba(255,255,255,.14)'; c.lineWidth = 3;
      c.beginPath(); c.arc(cx, cy, r, 0, 6.2832); c.stroke();
      c.strokeStyle = a.colour; c.lineCap = 'round';
      var spin = (p * 26) % 1;
      c.beginPath(); c.arc(cx, cy, r, spin * 6.2832, spin * 6.2832 + Math.min(5.6, busy * 5.6)); c.stroke();
    } else if (done >= 1) {
      c.strokeStyle = GREEN; c.lineWidth = 3; c.lineCap = 'round';
      c.beginPath(); c.moveTo(x + w - 38, y + 30); c.lineTo(x + w - 31, y + 37); c.lineTo(x + w - 18, y + 22); c.stroke();
    }
    c.restore();
  }

  /* ---------- one frame ---------- */
  function render(i, n, size) {
    var p = n === 1 ? 1 : i / (n - 1);
    var ow = (size && size.w) || W, oh = (size && size.h) || H;
    var cv = document.createElement('canvas');
    cv.width = ow; cv.height = oh;
    var c = cv.getContext('2d');
    c.scale(ow / W, oh / H);
    c.fillStyle = BG; c.fillRect(0, 0, 1440, 820);

    // ---- floor grid ----
    var grid = seg(p, 0, .07) * (1 - seg(p, .8, 1) * .5);
    c.save(); c.globalAlpha = grid * .4; c.fillStyle = 'rgba(255,255,255,.22)';
    for (var gx = 50; gx < 1440; gx += 44) for (var gy = 60; gy < 820; gy += 44) c.fillRect(gx, gy, 2, 2);
    c.restore();

    // ---- centre glow ----
    var gl = seg(p, .03, .2);
    if (gl > 0) {
      var g = c.createRadialGradient(CX, CY, 20, CX, CY, 420);
      g.addColorStop(0, 'rgba(93,125,255,' + (.20 * gl).toFixed(3) + ')');
      g.addColorStop(.6, 'rgba(107,75,255,' + (.08 * gl).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(7,9,13,0)');
      c.fillStyle = g; c.fillRect(0, 0, 1440, 820);
    }

    // ---- links from the centre to each desk ----
    AGENTS.forEach(function (a, k) {
      var t = seg(p, .14 + k * .025, .26 + k * .025);
      if (t <= 0) return;
      var tx = a.x + (a.x < CX ? 300 : 0), ty = a.y + 48;
      c.save(); c.globalAlpha = t * .5;
      c.strokeStyle = 'rgba(255,255,255,.22)'; c.lineWidth = 1.6; c.setLineDash([5, 7]);
      var pt = along(CX, CY, tx, ty, 1, 60);
      c.beginPath(); c.moveTo(CX, CY);
      var mx = (CX + tx) / 2, my = (CY + ty) / 2, dx = tx - CX, dy = ty - CY, len = Math.hypot(dx, dy) || 1;
      c.quadraticCurveTo(mx + (-dy / len) * 60, my + (dx / len) * 60, pt.x, pt.y);
      c.stroke(); c.restore();
    });

    // ---- the desks ----
    AGENTS.forEach(function (a, k) {
      var appear = seg(p, .10 + k * .028, .22 + k * .028);
      if (appear <= 0) return;
      var busyStart = .30 + k * .035, busyEnd = .62 + k * .04;
      var busy = clamp01((p - busyStart) / (busyEnd - busyStart));
      var done = p > busyEnd ? 1 : 0;
      deskCard(c, a, appear, p > busyStart ? busy : 0, done, p);
    });

    // ---- the orb in the middle ----
    var oa = seg(p, .05, .16);
    if (oa > 0) {
      orb(c, CX, CY, 46 * (0.7 + 0.3 * oa), oa);
      txt(c, 'ForgeAI', CX, CY + 82, 16, TEXT, 700, 'center');
      txt(c, 'on this computer', CX, CY + 104, 13.5, DIM, 500, 'center');
    }

    // ---- work flying out to the agents ----
    var kinds = ['mail', 'money', 'page', 'chart'];
    AGENTS.forEach(function (a, k) {
      var s = .26 + k * .03, e = s + .12;
      var t = clamp01((p - s) / (e - s));
      if (t <= 0 || t >= 1) return;
      var tx = a.x + (a.x < CX ? 300 : 0), ty = a.y + 48;
      var pt = along(CX, CY, tx, ty, ease(t), a.x < CX ? 60 : -60);
      packet(c, pt.x, pt.y, kinds[k], 1.15, Math.min(1, t * 4) * Math.min(1, (1 - t) * 5 + .4));
    });

    // ---- agents handing work to each other ----
    var hands = [[0, 1, 'mail', .50, .60], [2, 3, 'page', .55, .65], [1, 3, 'money', .60, .70]];
    hands.forEach(function (hd) {
      var A = AGENTS[hd[0]], B = AGENTS[hd[1]];
      var t = clamp01((p - hd[3]) / (hd[4] - hd[3]));
      if (t <= 0 || t >= 1) return;
      var ax = A.x + 150, ay = A.y + (A.y < CY ? 96 : 0);
      var bx = B.x + 150, by = B.y + (B.y < CY ? 96 : 0);
      c.save(); c.globalAlpha = .4 * Math.min(1, (1 - t) * 4);
      c.strokeStyle = 'rgba(255,255,255,.3)'; c.lineWidth = 1.4; c.setLineDash([4, 6]);
      c.beginPath(); c.moveTo(ax, ay);
      var mx = (ax + bx) / 2, my = (ay + by) / 2, dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
      c.quadraticCurveTo(mx + (-dy / len) * 90, my + (dx / len) * 90, bx, by);
      c.stroke(); c.restore();
      var pt = along(ax, ay, bx, by, ease(t), 90);
      packet(c, pt.x, pt.y, hd[2], .95, Math.min(1, t * 4) * Math.min(1, (1 - t) * 5 + .4));
    });

    // ---- results coming home ----
    AGENTS.forEach(function (a, k) {
      var s = .66 + k * .028, e = s + .11;
      var t = clamp01((p - s) / (e - s));
      if (t <= 0 || t >= 1) return;
      var tx = a.x + (a.x < CX ? 300 : 0), ty = a.y + 48;
      var pt = along(tx, ty, CX, CY, ease(t), a.x < CX ? -60 : 60);
      packet(c, pt.x, pt.y, 'chart', 1, Math.min(1, t * 4) * Math.min(1, (1 - t) * 5 + .4));
    });

    // ---- the one thing that needs a person ----
    var ap = seg(p, .74, .84) * (1 - seg(p, .97, 1));
    if (ap > 0) {
      var bw = 470, bh = 104, bx = CX - bw / 2, by = 676;
      c.save(); c.globalAlpha = ap; c.translate(0, (1 - ap) * 16);
      c.save();
      c.shadowColor = 'rgba(0,0,0,.6)'; c.shadowBlur = 34; c.shadowOffsetY = 12;
      c.fillStyle = 'rgba(243,176,74,.12)'; rr(c, bx, by, bw, bh, 18); c.fill();
      c.restore();
      c.strokeStyle = 'rgba(243,176,74,.55)'; c.lineWidth = 1.6; rr(c, bx, by, bw, bh, 18); c.stroke();
      c.fillStyle = AMBER; c.beginPath(); c.arc(bx + 38, by + 52, 15, 0, 6.2832); c.fill();
      c.fillStyle = '#07090d'; txt(c, '!', bx + 38, by + 58, 19, '#07090d', 800, 'center');
      txt(c, 'Waiting for you', bx + 68, by + 42, 16.5, TEXT, 700);
      txt(c, 'Refund for Marcus Johnson — $342.00', bx + 68, by + 67, 14, DIM, 500, 'left', 215);
      c.fillStyle = 'rgba(60,207,122,.18)'; rr(c, bx + bw - 190, by + 34, 82, 36, 10); c.fill();
      txt(c, 'Approve', bx + bw - 149, by + 57, 14, GREEN, 700, 'center');
      c.fillStyle = 'rgba(255,255,255,.08)'; rr(c, bx + bw - 98, by + 34, 76, 36, 10); c.fill();
      txt(c, 'Decline', bx + bw - 60, by + 57, 14, DIM, 700, 'center');
      c.restore();
    }

    // ---- the tally ----
    var tally = seg(p, .86, .96);
    if (tally > 0) {
      var items = [['31', 'emails sorted'], ['6', 'replies drafted'], ['2', 'flagged for you'], ['0', 'sent anywhere']];
      var colW = 190, startX = CX - (items.length - 1) * colW / 2;
      c.save(); c.globalAlpha = tally;
      items.forEach(function (it, k) {
        var a2 = clamp01((tally - k * .08) * 2);
        c.globalAlpha = tally * a2;
        var x = startX + k * colW;
        txt(c, it[0], x, 190, 34, k === 3 ? GREEN : TEXT, 800, 'center');
        txt(c, it[1], x, 214, 13, DIM, 500, 'center');
      });
      c.restore();
    }
    return cv;
  }

  return { render: render, W: W, H: H };
})();
