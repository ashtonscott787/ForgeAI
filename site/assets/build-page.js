(function () {
  var start = function () {
    Seq.init({ track: '#track', canvas: '#stage', caps: '.cap',
      render: function (i, n) { return BuildScene.render(i, n, { w: 1440, h: 820 }); },
      count: 134, scrollPerFrame: 26, chrome: false, captionSpace: 0.30 });
  };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(start, start); else start();
})();
