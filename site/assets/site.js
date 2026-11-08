/* Shared behaviour: sticky nav, mobile menu, scroll reveals. */
(function () {
  'use strict';
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  var top = document.querySelector('header.top');
  if (top) {
    var onScroll = function () { top.classList.toggle('stuck', (window.pageYOffset || 0) > 10); };
    addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    var mb = top.querySelector('.menubtn'), links = top.querySelector('.links');
    if (mb && links) {
      mb.addEventListener('click', function () { links.classList.toggle('open'); });
      links.addEventListener('click', function (e) { if (e.target.tagName === 'A') links.classList.remove('open'); });
    }
    // mark the current page in the nav
    var here = location.pathname.split('/').pop() || 'index.html';
    [].forEach.call(top.querySelectorAll('a.lnk'), function (a) {
      if (a.getAttribute('href') === here) a.classList.add('on');
    });
  }

  var rv = [].slice.call(document.querySelectorAll('.rv'));
  if (reduce || !('IntersectionObserver' in window)) {
    rv.forEach(function (el) { el.classList.add('in'); });
  } else {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.12 });
    rv.forEach(function (el) { io.observe(el); });
  }
})();
