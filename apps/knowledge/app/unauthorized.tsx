import { signInAction } from "./actions";

/** 401: someone not signed in asked for the studio. Nothing about any article. */
export default function Unauthorized() {
  return (
    <main className="signin" data-testid="signin">
      <div className="card">
        <h1>ASafariM Knowledge Studio</h1>
        <p className="muted">Sign in with your ASafariM account to write and publish.</p>
        <form action={signInAction}>
          <input type="hidden" name="next" value="/studio" />
          <button type="submit">Sign in</button>
        </form>
      </div>
    </main>
  );
}
