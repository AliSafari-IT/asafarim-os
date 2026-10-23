/* global window, document, location */
/*
 * @asafarim/theme's browser script: the light/dark choice. Load it in <head> (a plain <script src>, it needs
 * no inline script, so it fits a `script-src 'self'` CSP) or import it from a client component.
 *
 * - Applies the remembered choice (the asafarim-theme cookie) as data-theme on <html> before paint, unless
 *   the server already set one.
 * - Any element with data-theme-toggle flips the theme on click (one listener on the document, so buttons
 *   rendered later work too) and shows the state with aria-pressed ("Dark theme": pressed when dark).
 * - The cookie is set for the parent domain (asafarim.site), so one choice holds on every *.asafarim.site
 *   host; on localhost and IP addresses it stays on the host.
 *
 * Exposes window.asafarimTheme = { current, set, sync, cookieDomain }.
 */
(function () {
  if (typeof window === "undefined" || typeof document === "undefined" || window.asafarimTheme) return;
  var COOKIE = "asafarim-theme";
  var root = document.documentElement;

  function saved() {
    var m = /(?:^|;\s*)asafarim-theme=(light|dark)(?:;|$)/.exec(document.cookie);
    return m ? m[1] : null;
  }
  function systemDark() {
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }
  function current() {
    var t = root.getAttribute("data-theme");
    if (t === "light" || t === "dark") return t;
    return systemDark() ? "dark" : "light";
  }
  /** The domain to share the cookie on: the host's last two labels, or none for localhost and IPs. */
  function cookieDomain(host) {
    if (!host || host === "localhost" || /\.localhost$/.test(host) || /^[\d.]+$/.test(host) || host.indexOf(":") >= 0)
      return "";
    var labels = host.split(".");
    return labels.length < 2 ? "" : labels.slice(-2).join(".");
  }
  function sync() {
    var dark = current() === "dark";
    var toggles = document.querySelectorAll("[data-theme-toggle]");
    for (var i = 0; i < toggles.length; i++) toggles[i].setAttribute("aria-pressed", dark ? "true" : "false");
  }
  function set(theme) {
    if (theme !== "light" && theme !== "dark") return;
    root.setAttribute("data-theme", theme);
    var domain = cookieDomain(location.hostname);
    document.cookie =
      COOKIE +
      "=" +
      theme +
      "; path=/; max-age=31536000; samesite=lax" +
      (domain ? "; domain=" + domain : "") +
      (location.protocol === "https:" ? "; secure" : "");
    sync();
  }

  var remembered = saved();
  if (remembered && !root.hasAttribute("data-theme")) root.setAttribute("data-theme", remembered);

  document.addEventListener("click", function (e) {
    var el = e.target;
    var toggle = el && el.closest ? el.closest("[data-theme-toggle]") : null;
    if (toggle) set(current() === "dark" ? "light" : "dark");
  });
  if (window.matchMedia) {
    var mq = window.matchMedia("(prefers-color-scheme: dark)");
    if (mq.addEventListener) mq.addEventListener("change", sync);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", sync);
  else sync();

  window.asafarimTheme = { current: current, set: set, sync: sync, cookieDomain: cookieDomain };
})();
