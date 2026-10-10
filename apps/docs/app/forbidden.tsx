import { signOutAction } from "./actions";

/**
 * 403 (#79): signed in, but without docs.read (the docs.owner role). A plain page on purpose: no file
 * tree, titles or counts, so nothing about the documents leaks to someone who can't read them.
 */
export default function Forbidden() {
  return (
    <div className="signin" data-testid="forbidden">
      <h1>You don&apos;t have access</h1>
      <p className="muted">
        Reading needs the permission <span className="mono">docs.read</span>.
      </p>
      <form action={signOutAction}>
        <button type="submit" className="secondary">
          Sign out
        </button>
      </form>
    </div>
  );
}
