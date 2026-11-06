import { getLocale } from "@asafarim/locale/next";
import { LocaleSelector } from "@asafarim/locale/react";
import { ThemeToggle } from "@asafarim/theme/react";
import { messagesFor } from "@/lib/i18n";
import { AdminLogo } from "@/components/AdminLogo";
import { signOutAction } from "@/lib/sign-out";

/** Shown (with a real 403) to a signed-in person who doesn't hold core.admin. */
export default async function Forbidden() {
  const locale = await getLocale();
  const m = messagesFor(locale);
  return (
    <main className="center" id="main">
      <span className="center-toggle">
        <LocaleSelector locale={locale} />
        <ThemeToggle locale={locale} />
      </span>
      <div className="center-mark">
        <AdminLogo size={72} />
      </div>
      <h1>{m.forbiddenTitle}</h1>
      <div className="card" role="alert">
        <p>
          {m.forbiddenBefore} <code>core.admin</code>, {m.forbiddenAfter}
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
