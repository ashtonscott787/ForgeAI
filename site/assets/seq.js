'use strict';
/* ============================================================================
   Scroll-scrubbed frame sequence.

   A tall <section data-seq> is the scroll track; its sticky child pins the
   canvas to the viewport while the track scrolls past, so scroll position maps
   straight onto frame number. Frames are decoded up front and drawn with
   drawImage(), which is far cheaper than swapping an <img> src.

   Seq.init({
     track:   '#track',                  // the tall section
     canvas:  '#stage',
     caps:    '.cap',                    // caption blocks with data-from / data-to
     frames:  { pattern:'frames/chat/f###.webp', from:1, to:96 },   // real frames
     render:  function (i, n) { return aCanvas; },                  // or draw them
     count:   120,                       // frames to draw when using render()
     scrollPerFrame: 34, captionSpace: 0.32, maxDpr: 1.5, smoothing: 0.18
   });
   ========================================================================== */
window.Seq = (function () {
  function init(opt) {
    var cfg = {
      scrollPerFrame: 34, minTrackVh: 180, smoothing: 0.18, maxDpr: 1.5,
      captionSpace: 0.32, captionSpaceNarrow: 0.38, narrowZoom: 1.3,
      startAfter: 10, background: '#07090d', chrome: true, count: 120
    };
    for (var k in opt) if (opt.hasOwnProperty(k)) cfg[k] = opt[k];

    var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    var track = document.querySelector(cfg.track);
    var canvas = document.querySelector(cfg.canvas);
    if (!track || !canvas) return;
    var ctx = canvas.getContext('2d', { alpha: false });
    var loader = document.querySelector(cfg.loader || '#loader');
    var caps = [].slice.call(document.querySelectorAll(cfg.caps || '.cap')).map(function (el) {
      return { el: el, from: +el.dataset.from, to: +el.dataset.to };
    });

    var frames = [], total = 0, shown = -1, live = 0, target = 0, activeCap = -1, needsPaint = true, dpr = 1;

    /* ---------- painting ---------- */
    function roundRect(c, x, y, w, h, r) {
      c.beginPath();
      if (c.roundRect) { c.roundRect(x, y, w, h, r); return; }
      c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
      c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
    }
    function nearest(i) {
      if (frames[i]) return frames[i];
      for (var d = 1; d < frames.length; d++) {
        if (frames[i - d]) return frames[i - d];
        if (frames[i + d]) return frames[i + d];
      }
      return null;
    }
    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, cfg.maxDpr);
      var r = canvas.getBoundingClientRect();
      var w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w; canvas.height = h;
        ctx.imageSmoothingQuality = 'low';   // 'high' is several times dearer per blit and no crisper in motion
      }
      needsPaint = true;
    }
    function paint(i) {
      var f = nearest(i);
      if (!f) return;
      var cw = canvas.width, ch = canvas.height;
      var iw = f.naturalWidth || f.width, ih = f.naturalHeight || f.height;
      ctx.fillStyle = cfg.background; ctx.fillRect(0, 0, cw, ch);

      // the captions live along the bottom, so the frame is fitted above them
      var narrow = window.innerWidth < 760;
      var boxH = ch * (1 - (narrow ? cfg.captionSpaceNarrow : cfg.captionSpace));
      var scale = Math.min(cw / iw, boxH / ih) * (narrow ? cfg.narrowZoom : 1);
      var dw = iw * scale, dh = ih * scale;
      var dx = (cw - dw) / 2, dy = (boxH - dh) * (narrow ? 0.6 : 0.5);

      if (cfg.chrome) {
        var r = 16 * (dw / iw);
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 55 * dpr; ctx.shadowOffsetY = 20 * dpr;
        roundRect(ctx, dx, dy, dw, dh, r); ctx.fillStyle = '#0b0e14'; ctx.fill();
        ctx.restore();
        ctx.drawImage(f, dx, dy, dw, dh);
        ctx.save();
        roundRect(ctx, dx + .5, dy + .5, dw - 1, dh - 1, r);
        ctx.strokeStyle = 'rgba(255,255,255,.13)'; ctx.lineWidth = Math.max(1, dpr); ctx.stroke();
        ctx.restore();
      } else {
        ctx.drawImage(f, dx, dy, dw, dh);
      }
    }

    /* ---------- scroll → frame ---------- */
    function measure() {
      var want = total * cfg.scrollPerFrame + window.innerHeight;
      track.style.height = Math.round(Math.max(want, window.innerHeight * (cfg.minTrackVh / 100))) + 'px';
    }
    function progress() {
      var r = track.getBoundingClientRect(), span = r.height - window.innerHeight;
      return span <= 0 ? 0 : Math.min(1, Math.max(0, -r.top / span));
    }
    function setCap(i) {
      var want = -1;
      for (var k = 0; k < caps.length; k++) if (i >= caps[k].from && i <= caps[k].to) { want = k; break; }
      if (want === activeCap) return;
      activeCap = want;
      for (var j = 0; j < caps.length; j++) caps[j].el.classList.toggle('is-on', j === want);
    }
    function tick() {
      if (reduce || cfg.smoothing <= 0) live = target;
      else { live += (target - live) * cfg.smoothing; if (Math.abs(target - live) < 0.01) live = target; }
      var i = Math.round(live); if (i < 0) i = 0; if (i > total - 1) i = total - 1;
      if (i !== shown || needsPaint) { shown = i; needsPaint = false; paint(i); setCap(i); }
      requestAnimationFrame(tick);
    }
    function onScroll() { target = progress() * (total - 1); }

    function start(count) {
      total = count; measure(); resize(); onScroll(); live = target;
      if (loader) { loader.style.transition = 'opacity .4s'; loader.style.opacity = '0'; setTimeout(function () { loader.style.display = 'none'; }, 420); }
      addEventListener('scroll', onScroll, { passive: true });
      addEventListener('resize', function () { measure(); resize(); onScroll(); needsPaint = true; }, { passive: true });
      if ('ResizeObserver' in window) new ResizeObserver(resize).observe(canvas);
      requestAnimationFrame(tick);
    }

    /* ---------- loading ---------- */
    function srcList() {
      var f = cfg.frames;
      if (!f) return null;
      if (Array.isArray(f)) return f.slice();
      var out = [], pad = (f.pattern.match(/#+/) || ['###'])[0];
      for (var i = f.from; i <= f.to; i++) out.push(f.pattern.replace(pad, String(i).padStart(pad.length, '0')));
      return out;
    }

    var list = srcList();
    if (list && list.length) {
      frames = new Array(list.length);
      var done = 0, started = false, eager = Math.min(list.length, cfg.startAfter);
      list.forEach(function (src, i) {
        var img = new Image();
        img.decoding = 'async';
        try { img.fetchPriority = i < eager ? 'high' : 'low'; } catch (e) {}
        var settle = function (ok) {
          if (ok) {
            // an ImageBitmap is already in the compositor's format, so later draws are straight blits
            if (window.createImageBitmap) createImageBitmap(img).then(function (b) { frames[i] = b; }).catch(function () { frames[i] = img; });
            else frames[i] = img;
          }
          done++;
          if (!started && (done >= eager || done === list.length)) { started = true; start(list.length); }
        };
        img.onload = function () { if (img.decode) img.decode().then(function () { settle(true); }).catch(function () { settle(true); }); else settle(true); };
        img.onerror = function () { settle(false); };
        img.src = src;
      });
    } else if (typeof cfg.render === 'function') {
      // drawn sequences are built in slices so a slow machine never locks up mid-build
      var n = cfg.count, i2 = 0; frames = [];
      (function chunk() {
        var end = Math.min(n, i2 + 8);
        for (; i2 < end; i2++) frames.push(cfg.render(i2, n));
        if (i2 < n) setTimeout(chunk, 0); else start(n);
      })();
    }
  }
  return { init: init };
})();
