/** The stub's two pages. Plain, clearly marked DEV ONLY. */
export interface SeedUser {
  id: string;
  email: string;
  name: string | null;
  isActive: boolean;
  roles: string[];
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const STYLE = `body{font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;color:#1d1b16;background:#f6f4ef}
.dev{display:inline-block;background:#b91c1c;color:#fff;font-weight:700;padding:2px 8px;border-radius:6px;font-size:.8rem}
h1{font-size:1.3rem}form{margin:0}button{width:100%;text-align:left;border:1px solid #e4dfd3;background:#fff;border-radius:10px;
padding:12px 14px;margin:6px 0;font:inherit;cursor:pointer}button:hover{border-color:#9f4a07}.muted{color:#5d584d;font-size:.9rem}`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · ASafariM dev</title><style>${STYLE}</style></head><body><p><span class="dev">DEV ONLY</span></p>${body}</body></html>`;
}

/** Pick a seeded synthetic user. Each button posts the (still valid) ticket and the user id. */
export function chooseUserPage(ticket: string, users: SeedUser[]): string {
  const buttons = users
    .map(
      (u) => `<form method="post" action="/oidc/continue/select">
<input type="hidden" name="ticket" value="${escapeHtml(ticket)}"><input type="hidden" name="sub" value="${escapeHtml(u.id)}">
<button type="submit"><strong>${escapeHtml(u.name ?? u.id)}</strong> · ${escapeHtml(u.email)}<br>
<span class="muted">${escapeHtml(u.roles.join(", ") || "no roles")}${u.isActive ? "" : " · inactive (the identity service will refuse it)"}</span></button></form>`,
    )
    .join("\n");
  return page(
    "Sign in as",
    `<h1>Sign in as a seeded dev user</h1><p class="muted">The local stand-in for Hub. No password: these are synthetic users.</p>${buttons}`,
  );
}

export function autoPostPage(target: string, assertion: string): string {
  return page(
    "Signing in",
    `<h1>Signing in…</h1><form id="handoff" method="post" action="${escapeHtml(target)}">
<input type="hidden" name="assertion" value="${escapeHtml(assertion)}"><button type="submit">Continue</button></form>
<script>document.getElementById("handoff").submit();</script>`,
  );
}

export function errorPage(message: string): string {
  return page(
    "Dev hub error",
    `<h1>Can't continue</h1><p>${escapeHtml(message)}</p><p class="muted">Start the sign-in again from the app.</p>`,
  );
}
