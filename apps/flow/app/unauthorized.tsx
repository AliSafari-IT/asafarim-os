import { getLocale } from "@asafarim/locale/next";
import { LocaleSelector } from "@asafarim/locale/react";
import { ThemeToggle } from "@asafarim/theme/react";
import { messagesFor } from "@/lib/i18n";
import { signInAction } from "./actions";

/** 401: what anyone not signed in sees, on every page. Nothing about workflows or runs. */
export default async function Unauthorized() {
  const locale = await getLocale();
  const m = messagesFor(locale);
  return (
    <main className="signin" data-testid="signin">
      <span className="corner-toggle">
        <LocaleSelector locale={locale} />
        <ThemeToggle locale={locale} />
      </span>
      <div className="card signin-card">
        <span className="glyph" aria-hidden="true">
          FL
        </span>
        <h1>Flow</h1>
        <p className="muted">{m.signInIntro}</p>
        <form action={signInAction}>
          <button type="submit">{m.signIn}</button>
        </form>
      </div>
    </main>
  );
}
