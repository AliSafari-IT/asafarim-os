import { getLocale } from "@asafarim/locale/next";
import { LocaleSelector } from "@asafarim/locale/react";
import { ThemeToggle } from "@asafarim/theme/react";
import { messagesFor } from "@/lib/i18n";
import { signOutAction } from "./actions";

/** 403: signed in, but without flow.read. A plain page: no workflows, runs or counts. */
export default async function Forbidden() {
  const locale = await getLocale();
  const m = messagesFor(locale);
  return (
    <main className="signin" data-testid="forbidden">
      <span className="corner-toggle">
        <LocaleSelector locale={locale} />
        <ThemeToggle locale={locale} />
      </span>
      <div className="card signin-card">
        <h1>{m.noAccess}</h1>
        <p className="muted">
          {m.needsBefore} <span className="perm">flow.read</span>. {m.askAdminFor}{" "}
          <span className="perm">flow.viewer</span>.
        </p>
        <form action={signOutAction}>
          <button type="submit" className="secondary">
            {m.signOut}
          </button>
        </form>
      </div>
    </main>
  );
}
