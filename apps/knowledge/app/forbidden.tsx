import Link from "next/link";
import { signOutAction } from "./actions";

/** 403: signed in, but without knowledge.content.create. A plain page: no drafts, titles or counts. */
export default function Forbidden() {
  return (
    <main className="signin" data-testid="forbidden">
      <div className="card">
        <h1>No studio access</h1>
        <p className="muted">
          Writing needs the permission <span className="perm">knowledge.content.create</span>. Ask an administrator for
          the <span className="perm">knowledge.author</span> role.
        </p>
        <p>
          <Link href="/">Read the published articles</Link>
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
