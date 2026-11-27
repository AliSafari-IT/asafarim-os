"use client";
/**
 * The studio's "New article" form. The inputs are uncontrolled, so what a person types before the page has
 * hydrated is never lost, and the server action still receives the same three fields as before.
 *
 * - The slug follows the title until the author types one of their own.
 * - "Create draft" stays disabled while the title is blank. It starts enabled in the server HTML, so the form
 *   still works without JavaScript (the `required` attribute and the server both check the title anyway).
 * - The summary shows how many of its characters are used.
 */
import { useEffect, useRef, useState } from "react";
import { LIMITS, slugify } from "@/lib/validation";

export function NewArticleForm({ action }: { action: (formData: FormData) => void | Promise<void> }) {
  const title = useRef<HTMLInputElement>(null);
  const slug = useRef<HTMLInputElement>(null);
  const summary = useRef<HTMLTextAreaElement>(null);
  // True once the author has typed their own slug; until then it follows the title.
  const ownSlug = useRef(false);
  const [hasTitle, setHasTitle] = useState(true);
  const [address, setAddress] = useState("");
  const [summaryLength, setSummaryLength] = useState(0);

  const followTitle = () => {
    const t = title.current?.value ?? "";
    setHasTitle(t.trim().length > 0);
    if (!ownSlug.current && slug.current) slug.current.value = slugify(t);
    setAddress(slug.current?.value ?? "");
  };

  const slugTyped = () => {
    const s = slug.current?.value ?? "";
    ownSlug.current = s !== "";
    setAddress(s);
  };

  // Pick up anything typed (or restored by the browser) before this component hydrated.
  useEffect(() => {
    ownSlug.current = (slug.current?.value ?? "") !== "";
    followTitle();
    setSummaryLength(summary.current?.value.length ?? 0);
  }, []);

  const near = summaryLength >= LIMITS.summary * 0.9;

  return (
    <form action={action} className="card studio-new" data-testid="new-article">
      <h2>New article</h2>
      <label>
        Title
        <input
          ref={title}
          name="title"
          maxLength={LIMITS.title}
          required
          placeholder="A clear, specific title"
          onInput={followTitle}
        />
      </label>
      <label>
        Slug <span className="muted">(optional; follows the title until you edit it)</span>
        <input
          ref={slug}
          name="slug"
          maxLength={LIMITS.slug}
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          placeholder="my-article-slug"
          aria-describedby="new-article-address"
          onInput={slugTyped}
        />
      </label>
      <p className="field-hint" id="new-article-address" data-testid="new-article-address">
        {address ? (
          <>
            Public address: <span className="perm">/articles/{address}</span>
          </>
        ) : (
          "The address is made from the title."
        )}
      </p>
      <label>
        Summary
        <textarea
          ref={summary}
          name="summary"
          rows={3}
          maxLength={LIMITS.summary}
          placeholder="One or two sentences for readers"
          aria-describedby="new-article-count"
          onInput={(e) => setSummaryLength(e.currentTarget.value.length)}
        />
      </label>
      <p className={`field-hint field-count${near ? " near" : ""}`} id="new-article-count" data-testid="summary-count">
        {summaryLength} / {LIMITS.summary}
      </p>
      <button
        type="submit"
        data-testid="create"
        disabled={!hasTitle}
        title={hasTitle ? undefined : "Enter a title to create a draft"}
      >
        Create draft
      </button>
    </form>
  );
}
