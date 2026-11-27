"use client";
/**
 * "Copy link": the one share action that needs a little script. It uses the clipboard API, falls back to the
 * older selection-based copy where that isn't available, and says what happened (also to screen readers).
 */
import { useEffect, useRef, useState } from "react";
import { trackShare } from "@/lib/analytics/beacon";

type State = "idle" | "copied" | "failed";

function legacyCopy(text: string): boolean {
  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "");
  el.style.position = "fixed";
  el.style.opacity = "0";
  document.body.appendChild(el);
  el.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(el);
  return ok;
}

export function CopyLinkButton({ url, slug }: { url: string; slug: string }) {
  const [state, setState] = useState<State>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    let ok = false;
    try {
      await navigator.clipboard.writeText(url);
      ok = true;
    } catch {
      ok = legacyCopy(url);
    }
    setState(ok ? "copied" : "failed");
    if (ok) trackShare(slug, "copy");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2500);
  }

  return (
    <>
      <button type="button" className="share-btn" onClick={copy} data-testid="share-copy">
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          aria-hidden="true"
          focusable="false"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M5 15V6a2 2 0 0 1 2-2h9" />
        </svg>
        <span>{state === "copied" ? "Copied" : state === "failed" ? "Couldn't copy" : "Copy link"}</span>
      </button>
      <span className="visually-hidden" role="status" aria-live="polite">
        {state === "copied" ? "Link copied" : state === "failed" ? "Couldn't copy the link" : ""}
      </span>
    </>
  );
}
