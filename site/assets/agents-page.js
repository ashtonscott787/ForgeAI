/* The agents page draws its sequence rather than playing recorded frames. */
(function () {
  var N = 132;
  var start = function () {
    Seq.init({
      track: '#track', canvas: '#stage', caps: '.cap',
      render: function (i, n) { return AgentsScene.render(i, n, { w: 1440, h: 820 }); },
      count: N, scrollPerFrame: 26, chrome: false, captionSpace: 0.30
    });
  };
  // Wait for Inter before drawing: the frames bake their text in, so a late font swap would be invisible.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(start, start);
  else start();
})();
