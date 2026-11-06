import { getLocale } from "@asafarim/locale/next";
import { LocaleSelector } from "@asafarim/locale/react";
import { ThemeToggle } from "@asafarim/theme/react";
import { messagesFor } from "@/lib/i18n";
import { signInAction } from "./actions";

/** 401 (#79): what anyone not signed in sees, on every page. Nothing about the documents. */
export default async function Unauthorized() {
  const locale = await getLocale();
  const m = messagesFor(locale);
  return (
    <main className="signin" data-testid="signin">
      <span className="corner-toggle">
        <LocaleSelector locale={locale} />
        <ThemeToggle locale={locale} />
      </span>
      <div className="signin-card">
        <span className="glyph" aria-hidden="true">
          DC
        </span>
        <h1>Docs</h1>
        <p className="muted">{m.signInIntro}</p>
        <form action={signInAction}>
          <button type="submit" className="wide">
            {m.signIn}
          </button>
        </form>
        <p className="signin-foot muted">{m.signInFoot}</p>
      </div>
    </main>
  );
}
