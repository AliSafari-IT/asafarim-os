import { signInAction } from "./actions";

/** 401 (#79): what anyone not signed in sees, on every page. Nothing about the documents. */
export default function Unauthorized() {
  return (
    <div className="signin" data-testid="signin">
      <h1>Docs</h1>
      <p className="muted">A private reader for documentation. Sign in with your ASafariM account.</p>
      <form action={signInAction}>
        <button type="submit">Sign in</button>
      </form>
    </div>
  );
}
