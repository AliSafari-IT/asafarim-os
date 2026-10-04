import { signOut } from "@/lib/auth";

async function signOutAction() {
  "use server";
  await signOut({ redirectTo: "/signin" });
}

/** Shown (with a real 403) to a signed-in person who doesn't hold core.admin. */
export default function Forbidden() {
  return (
    <main className="center" id="main">
      <h1>403: not allowed</h1>
      <div className="card" role="alert">
        <p>
          The Admin console needs the platform role <code>core.admin</code>, and your account doesn&apos;t hold it. Ask
          an administrator to grant it.
        </p>
        <form action={signOutAction}>
          <button type="submit" className="secondary">
            Sign out
          </button>
        </form>
      </div>
    </main>
  );
}
