import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getLocale } from "@asafarim/locale/next";
import { LocaleSelector } from "@asafarim/locale/react";
import { ThemeToggle } from "@asafarim/theme/react";
import { messagesFor } from "@/lib/i18n";
import { AdminLogo } from "@/components/AdminLogo";
import { SIGNED_OUT_COOKIE, signIn } from "@/lib/auth";
import { adminState } from "@/lib/session";

export const dynamic = "force-dynamic";

async function signInAction() {
  "use server";
  (await cookies()).delete({ name: SIGNED_OUT_COOKIE, path: "/signin" });
  await signIn("asafarim", { redirectTo: "/admin" });
}

export default async function SignIn() {
  if ((await adminState()).state === "ok") redirect("/admin");
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
      <h1>ASafariM OS Admin</h1>
      <div className="card">
        <p>{m.signInIntro}</p>
        <form action={signInAction}>
          <button type="submit">{m.signIn}</button>
        </form>
      </div>
    </main>
  );
}
