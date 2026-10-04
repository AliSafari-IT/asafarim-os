import { createNoteAction, signInAction, signOutAction } from "./actions";
import { auth } from "@/lib/auth";
import { listNotes } from "@/lib/db";
import { describeAccess } from "@/lib/gate";

export const dynamic = "force-dynamic";

const MESSAGES: Record<string, string> = {
  forbidden: "403 Forbidden: you don't have the permission",
  invalid_note: "A title of 1–200 characters is required.",
  limit_reached: "The app has reached its note limit.",
  app_inactive: "The app isn't active.",
  unauthenticated: "Sign in first.",
  permissions_unavailable: "Permissions can't be checked right now.",
};

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { error, permission } = await searchParams;
  const session = await auth();
  const subject = session?.user?.id;

  if (!subject) {
    return (
      <main>
        <header>
          <h1>Notes</h1>
        </header>
        <div className="card">
          <p>Sign in with your ASafariM account to read and write notes.</p>
          <form action={signInAction}>
            <button type="submit">Sign in</button>
          </form>
        </div>
      </main>
    );
  }

  const access = await describeAccess(subject);
  const canRead = access.permissions.includes("notes.read");
  const canWrite = access.permissions.includes("notes.write");
  const notes = access.state === "active" && canRead ? await listNotes(100) : [];

  return (
    <main>
      <header>
        <div>
          <h1>Notes</h1>
          <span className="muted" data-testid="who">
            Signed in as {session?.user?.name ?? subject}
          </span>
        </div>
        <form action={signOutAction}>
          <button type="submit" className="secondary">
            Sign out
          </button>
        </form>
      </header>

      {error ? (
        <div className="notice bad" role="alert" data-testid="error">
          {MESSAGES[error] ?? error}
          {permission ? (
            <>
              {" "}
              <span className="perm">{permission}</span>
            </>
          ) : null}
        </div>
      ) : null}

      {!access.available ? (
        <div className="notice bad" data-testid="state">
          Permissions can&apos;t be checked right now (core-api is unreachable).
        </div>
      ) : access.state !== "active" ? (
        <div className="notice bad" data-testid="state">
          This app is <strong>{access.state}</strong>. An admin has to activate it.
        </div>
      ) : (
        <>
          <p className="muted" data-testid="access">
            Your roles: {access.roles.join(", ") || "none"} · permissions:{" "}
            <span className="perm">{access.permissions.join(", ") || "none"}</span>
          </p>

          <form action={createNoteAction} className="card" data-testid="new-note">
            <label>
              Title
              <input name="title" maxLength={200} required />
            </label>
            <label>
              Note
              <textarea name="body" rows={3} maxLength={10000} />
            </label>
            <button type="submit">Add note</button>
            {!canWrite ? (
              <span className="muted">
                {" "}
                Adding notes needs the permission <span className="perm">notes.write</span>.
              </span>
            ) : null}
          </form>

          {canRead ? (
            notes.length ? (
              notes.map((n) => (
                <article className="card" key={n.id} data-testid="note">
                  <h2>{n.title}</h2>
                  <span className="muted">
                    {n.author} · {n.created_at.toISOString().slice(0, 16).replace("T", " ")}
                  </span>
                  {n.body ? <p>{n.body}</p> : null}
                </article>
              ))
            ) : (
              <p className="muted" data-testid="empty">
                No notes yet.
              </p>
            )
          ) : (
            <div className="notice" data-testid="no-read">
              Reading notes needs the permission <span className="perm">notes.read</span>. Ask an admin for the{" "}
              <span className="perm">notes.viewer</span> role.
            </div>
          )}
        </>
      )}
    </main>
  );
}
