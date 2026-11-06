/** Account ID copying stays in the browser; no account data is posted anywhere. */
export const ACCOUNT_JS = `"use strict";
(function () {
  var button = document.querySelector('[data-copy-account-id]');
  var value = document.querySelector('[data-account-id]');
  var status = document.querySelector('[data-copy-account-status]');
  if (!button || !value || !status || !navigator.clipboard || !navigator.clipboard.writeText) return;
  button.hidden = false;
  button.addEventListener('click', async function () {
    button.disabled = true;
    try {
      await navigator.clipboard.writeText(value.textContent.trim());
      status.textContent = status.getAttribute('data-msg-copied') || 'Account ID copied.';
    } catch (_) {
      var range = document.createRange();
      range.selectNodeContents(value);
      var selection = window.getSelection();
      if (selection) { selection.removeAllRanges(); selection.addRange(range); }
      status.textContent = status.getAttribute('data-msg-failed') || 'Could not copy. The account ID is selected; copy it manually.';
    } finally { button.disabled = false; }
  });
})();`;
