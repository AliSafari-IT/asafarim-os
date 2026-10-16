/**
 * The only script the service serves (GET /static/passkey.js, `script-src 'self'`): it calls
 * navigator.credentials for the passkey buttons and posts the result back. Buttons carry
 * `data-passkey="login" | "register"` and the CSRF token in `data-csrf`; they stay hidden where
 * the browser has no WebAuthn.
 */
export const PASSKEY_JS = `"use strict";
(function () {
  if (!window.PublicKeyCredential || !navigator.credentials) return;
  var enc = function (buf) {
    var s = "", b = new Uint8Array(buf);
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  };
  var dec = function (str) {
    var s = str.replace(/-/g, "+").replace(/_/g, "/");
    s += "===".slice((s.length + 3) % 4);
    var raw = atob(s), out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  };
  var post = function (url, csrf, body) {
    return fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j && j.error ? j.error : "Something went wrong.");
        return j;
      });
    });
  };
  var status = function (msg) {
    var el = document.querySelector("[data-passkey-status]");
    if (el) el.textContent = msg;
  };
  var login = function (csrf) {
    return post("/passkeys/login/options", csrf).then(function (o) {
      return navigator.credentials.get({
        publicKey: { challenge: dec(o.challenge), rpId: o.rpId, timeout: o.timeout, userVerification: o.userVerification }
      });
    }).then(function (c) {
      var r = c.response;
      return post("/passkeys/login/verify", csrf, {
        id: c.id, rawId: enc(c.rawId), type: c.type,
        response: {
          clientDataJSON: enc(r.clientDataJSON),
          authenticatorData: enc(r.authenticatorData),
          signature: enc(r.signature),
          userHandle: r.userHandle ? enc(r.userHandle) : null
        }
      });
    }).then(function (j) { window.location.assign(j.redirect); });
  };
  var register = function (csrf) {
    return post("/passkeys/register/options", csrf).then(function (o) {
      o.challenge = dec(o.challenge);
      o.user.id = dec(o.user.id);
      o.excludeCredentials = o.excludeCredentials.map(function (x) { return { type: x.type, id: dec(x.id) }; });
      return navigator.credentials.create({ publicKey: o });
    }).then(function (c) {
      var r = c.response;
      return post("/passkeys/register/verify", csrf, {
        id: c.id, rawId: enc(c.rawId), type: c.type,
        response: {
          clientDataJSON: enc(r.clientDataJSON),
          attestationObject: enc(r.attestationObject),
          transports: r.getTransports ? r.getTransports() : []
        }
      });
    }).then(function () { window.location.reload(); });
  };
  document.querySelectorAll("[data-passkey]").forEach(function (button) {
    button.hidden = false;
    button.addEventListener("click", function () {
      var csrf = button.getAttribute("data-csrf") || "";
      var run = button.getAttribute("data-passkey") === "register" ? register : login;
      button.disabled = true;
      status("Waiting for your passkey…");
      run(csrf).catch(function (e) {
        status(e && e.name === "NotAllowedError" ? "Cancelled." : (e && e.message) || "That didn't work.");
      }).then(function () { button.disabled = false; });
    });
  });
})();
`;
