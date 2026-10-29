/* global document */
// asafarim.site: who is signed in. Asks identity's /whoami (a credentialed GET that identity answers
// with CORS for this origin only) and, when someone is signed in, swaps the top bar's "Sign in" for
// their avatar and a small menu, and the hero's sign-in hint for a "signed in as" line. Signed out,
// offline or blocked, the page stays exactly as served. It only ever sets textContent (never HTML)
// and colours through the CSSOM, so the CSP needs no inline scripts or styles.
(() => {
  "use strict";
  // Fixed here, not read from the page: every link this script builds is a constant.
  const identity = "https://id.asafarim.site";
  const slot = document.getElementById("account");
  if (!slot) return;

  const DOCS = "https://docs.asafarim.site/";
  const FLOW = "https://flow.asafarim.site/";
  const ACCOUNT = identity + "/account";
  // The Admin console, offered only when identity says this person is an admin (it checks core.admin itself).
  const ADMIN = "https://admin.asafarim.site/";

  const el = (tag, attrs, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
    for (const c of children) node.append(c);
    return node;
  };
  const hueOf = (label) => {
    let h = 0;
    for (const ch of label) h = (h * 31 + ch.codePointAt(0)) % 360;
    return h;
  };
  const icon = (d) => {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.append(path);
    return svg;
  };
  const ICONS = {
    docs: "M5 2.5h6.5L15 6v11.5H5zM11 2.5V6.5h4M7.5 10h5M7.5 13h5",
    flow: "M4 4h4v4H4zM12 12h4v4h-4zM12 4h4v4h-4zM8 6h3a1 1 0 0 1 1 1v4",
    account: "M10 10.25a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5zM3.5 17c.9-3.2 3.4-5 6.5-5s5.6 1.8 6.5 5",
    request: "M10 3.5v13M3.5 10h13",
    admin: "M10 2.5l6 2.25v4.5c0 3.9-2.55 6.9-6 8.25-3.45-1.35-6-4.35-6-8.25v-4.5zM7.25 10l2 2 3.5-3.75",
  };

  function render(me) {
    const label = typeof me.label === "string" && me.label ? me.label : "Signed in";
    const initials = typeof me.initials === "string" && me.initials ? me.initials.slice(0, 2) : "?";
    const hue = String(hueOf(label));

    const avatar = (cls) => {
      const a = el("span", { class: cls, "aria-hidden": "true" }, initials);
      a.style.setProperty("--hue", hue);
      return a;
    };
    const item = (href, text, iconKey, testid) => {
      const a = el("a", { href, class: "user-item", "data-testid": testid }, icon(ICONS[iconKey]), text);
      return a;
    };

    const button = el(
      "button",
      {
        type: "button",
        class: "user-button",
        "aria-expanded": "false",
        "aria-controls": "user-menu",
        "aria-label": "Your account menu: " + label,
        title: label,
        "data-testid": "user-button",
      },
      avatar("avatar"),
    );
    button.firstChild.append(el("span", { class: "avatar-dot" }));

    const who = el("span", { class: "user-who" }, el("strong", { "data-testid": "user-name" }, label));
    who.append(el("small", {}, me.connected ? "Signed in" : "Signed in · no access yet"));
    const menu = el(
      "div",
      { id: "user-menu", class: "user-menu", role: "group", "aria-label": "Your account menu", hidden: "" },
      el("div", { class: "user-card" }, avatar("avatar avatar-lg"), who),
      ...(me.connected
        ? [item(DOCS, "Open Docs", "docs", "user-docs"), item(FLOW, "Open Flow", "flow", "user-flow")]
        : [item(identity + "/connect", "Request access", "request", "user-request")]),
      ...(me.admin === true ? [item(ADMIN, "Admin console", "admin", "user-admin")] : []),
      item(ACCOUNT, "Account and sign out", "account", "user-account"),
    );
    const root = el("div", { class: "user", "data-testid": "user" }, button, menu);
    slot.replaceChildren(root);

    const items = () => Array.from(menu.querySelectorAll("a"));
    const setOpen = (open, focusFirst) => {
      button.setAttribute("aria-expanded", String(open));
      menu.hidden = !open;
      if (open && focusFirst) items()[0].focus();
    };
    const isOpen = () => !menu.hidden;
    button.addEventListener("click", () => setOpen(!isOpen(), false));
    button.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || ((e.key === "Enter" || e.key === " ") && !isOpen())) {
        e.preventDefault();
        setOpen(true, true);
      } else if (e.key === "Escape" && isOpen()) {
        e.preventDefault();
        setOpen(false);
      }
    });
    menu.addEventListener("keydown", (e) => {
      const list = items();
      const i = list.indexOf(document.activeElement);
      let next;
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        button.focus();
        return;
      }
      if (e.key === "Tab") return setOpen(false);
      if (e.key === "ArrowDown") next = (i + 1) % list.length;
      else if (e.key === "ArrowUp") next = i < 0 ? list.length - 1 : (i - 1 + list.length) % list.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = list.length - 1;
      if (next !== undefined) {
        e.preventDefault();
        list[next].focus();
      }
    });
    document.addEventListener("pointerdown", (e) => {
      if (isOpen() && !root.contains(e.target)) setOpen(false);
    });

    // The hero's "Have access? Sign in…" hint becomes who is signed in.
    const access = document.getElementById("access");
    if (access) {
      const hint = me.connected
        ? [
            "You're signed in as ",
            el("strong", {}, label),
            ". ",
            el("a", { href: DOCS }, "Open Docs"),
            " or ",
            el("a", { href: FLOW }, "Flow"),
            " if your account has access.",
          ]
        : [
            "You're signed in as ",
            el("strong", {}, label),
            ", without access yet. ",
            el("a", { href: identity + "/connect" }, "Request access"),
            ": an admin approves it.",
          ];
      access.replaceChildren(...hint);
      access.classList.add("access-signed-in");
    }
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  fetch(identity + "/whoami", { credentials: "include", cache: "no-store", signal: ctrl.signal })
    .then((r) => (r.ok ? r.json() : null))
    .then((me) => {
      if (me && me.signedIn === true) render(me);
    })
    .catch(() => {})
    .finally(() => clearTimeout(timer));
})();
