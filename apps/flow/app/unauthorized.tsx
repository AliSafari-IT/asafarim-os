import { ThemeToggle } from "@asafarim/theme/react";
import { signInAction } from "./actions";

/** 401: what anyone not signed in sees, on every page. Nothing about workflows or runs. */
export default function Unauthorized() {
  return (
    <main className="signin" data-testid="signin">
      <ThemeToggle className="corner-toggle" />
      <div className="card signin-card">
        <span className="glyph" aria-hidden="true">
          FL
        </span>
        <h1>Flow</h1>
        <p className="muted">Workflows across your ASafariM apps. Sign in with your ASafariM account.</p>
        <form action={signInAction}>
          <button type="submit">Sign in</button>
        </form>
      </div>
    </main>
  );
}
