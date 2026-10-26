import { ThemeToggle } from "@asafarim/theme/react";
import { signOutAction } from "./actions";

/** 403: signed in, but without flow.read. A plain page: no workflows, runs or counts. */
export default function Forbidden() {
  return (
    <main className="signin" data-testid="forbidden">
      <ThemeToggle className="corner-toggle" />
      <div className="card signin-card">
        <h1>You don&apos;t have access</h1>
        <p className="muted">
          Flow needs the permission <span className="perm">flow.read</span>. Ask an admin for the{" "}
          <span className="perm">flow.viewer</span> role.
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
