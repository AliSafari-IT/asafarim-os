import { ThemeToggle } from "@asafarim/theme/react";
import { signInAction } from "./actions";

/** 401 (#79): what anyone not signed in sees, on every page. Nothing about the documents. */
export default function Unauthorized() {
  return (
    <main className="signin" data-testid="signin">
      <ThemeToggle className="corner-toggle" />
      <div className="signin-card">
        <span className="glyph" aria-hidden="true">
          DC
        </span>
        <h1>Docs</h1>
        <p className="muted">A private reader for documentation. Sign in with your ASafariM account.</p>
        <form action={signInAction}>
          <button type="submit" className="wide">
            Sign in
          </button>
        </form>
        <p className="signin-foot muted">Only people who have been given access can read the documents.</p>
      </div>
    </main>
  );
}
