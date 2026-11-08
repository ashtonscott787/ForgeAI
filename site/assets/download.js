/* Highlights the download that matches this computer. */
(function () {
  var ua = navigator.userAgent;
  var plat = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  var os = /Windows/i.test(ua) ? 'win' : (/Mac/i.test(plat) || /Mac/i.test(ua)) ? 'mac-as' : /Linux|X11/i.test(plat) ? 'linux' : null;
  if (os === 'mac-as') {
    // Apple Silicon and Intel look identical in the user agent; the GPU name gives it away in most browsers.
    try {
      var c = document.createElement('canvas'), gl = c.getContext('webgl');
      var dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
      var r = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '';
      if (/Intel|AMD|Radeon/i.test(r) && !/Apple/i.test(r)) os = 'mac-intel';
    } catch (e) {}
  }
  if (!os) return;
  var card = document.querySelector('.dl .card[data-os="' + os + '"]');
  if (card) card.classList.add('rec');
})();
