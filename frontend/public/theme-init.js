// Paint the right palette on the very first frame, before the bundle
// boots. A separate same-origin file rather than an inline <script>: the
// CSP is script-src 'self', which refuses inline scripts -- the inline
// version never ran in production.
//
// Without this the class lands in a React effect, so the page flashes the wrong theme
// while the bundle boots. Mirrors resolveTheme() in src/lib/theme.ts
// -- this cannot import, so keep the two in step.
(function () {
  function prefersDark() {
    try { return !!window.matchMedia('(prefers-color-scheme: dark)').matches }
    catch (e) { return false }
  }
  var stored = null;
  // Reading storage THROWS in a private window or with site data
  // blocked; it does not merely return null.
  try { stored = window.localStorage.getItem('theme') } catch (e) {}
  var dark = stored === 'dark' || (stored !== 'light' && prefersDark());
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
})();
