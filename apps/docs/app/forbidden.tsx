import { getLocale } from "@asafarim/locale/next";
import { LocaleSelector } from "@asafarim/locale/react";
import { ThemeToggle } from "@asafarim/theme/react";
import { messagesFor } from "@/lib/i18n";
import { signOutAction } from "./actions";

/**
 * 403 (#79): signed in, but without docs.read (the docs.owner role). A plain page on purpose: no file
 * tree, titles or counts, so nothing about the documents leaks to someone who can't read them.
 */
export default async function Forbidden() {
  const locale = await getLocale();
  const m = messagesFor(locale);
  return (
    <div className="signin" data-testid="forbidden">
      <span className="corner-toggle">
        <LocaleSelector locale={locale} />
        <ThemeToggle locale={locale} />
      </span>
      <div className="signin-card">
        <h1>{m.noAccess}</h1>
        <p className="muted">
          {m.readingNeeds} <span className="mono">docs.read</span>. {m.askAdminFor}{" "}
          <span className="mono">docs.owner</span>.
        </p>
        <form action={signOutAction}>
          <button type="submit" className="secondary">
            {m.signOut}
          </button>
        </form>
      </div>
    </div>
  );
}
