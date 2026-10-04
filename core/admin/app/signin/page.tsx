import { redirect } from "next/navigation";
import { signIn } from "@/lib/auth";
import { adminState } from "@/lib/session";

export const dynamic = "force-dynamic";

async function signInAction() {
  "use server";
  await signIn("asafarim", { redirectTo: "/admin" });
}

export default async function SignIn() {
  if ((await adminState()).state === "ok") redirect("/admin");
  return (
    <main className="center" id="main">
      <h1>ASafariM OS Admin</h1>
      <div className="card">
        <p>Sign in with your ASafariM account. Only platform administrators can use the console.</p>
        <form action={signInAction}>
          <button type="submit">Sign in</button>
        </form>
      </div>
    </main>
  );
}
