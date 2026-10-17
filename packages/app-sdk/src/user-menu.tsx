"use client";
/**
 * The signed-in person's menu for the top bar: an avatar with their initials that opens a small card
 * with their name and email, a link to their account (on identity), the way back to the OS homepage,
 * and whatever the app adds at the foot (its Sign out form, which has to be a server action).
 *
 *   <UserMenu name={session.user.name} email={session.user.email}
 *     signOut={<form action={signOutAction}><button type="submit">Sign out</button></form>} />
 *
 * It never shows an account id: with no name or email it says "Signed in". Keyboard: Enter/Space/
 * ArrowDown open it on the first item; ArrowUp/Down, Home/End move; Escape closes and returns focus
 * to the avatar; Tab leaves. A click outside closes it. The avatar's ring turns slowly on hover and
 * the card pops in; with "reduce motion" nothing moves.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { HomeIcon, moveIndex, OS_HOME } from "./app-switcher.tsx";
import { safeHref } from "./safe-href.ts";

interface Focusable {
  focus(): void;
}
interface QueryRoot {
  querySelectorAll(selector: string): ArrayLike<unknown>;
  contains(node: unknown): boolean;
}
interface Doc {
  activeElement: unknown;
  addEventListener(type: "pointerdown", listener: (e: { target: unknown }) => void): void;
  removeEventListener(type: "pointerdown", listener: (e: { target: unknown }) => void): void;
}
const focusOn = (el: unknown) => (el as Focusable | null | undefined)?.focus();
const browserDocument = () => (globalThis as unknown as { document?: Doc }).document;

export const ACCOUNT_URL = "https://id.asafarim.site/account";

export interface UserMenuProps {
  name?: string | null;
  email?: string | null;
  /** The person's account page on identity. */
  accountHref?: string;
  /** The link back to the OS homepage (default: asafarim.site); null for none. */
  home?: { href: string; label: string } | null;
  /** The app's Sign out control, shown at the foot (a form with a submit button). */
  signOut?: ReactNode;
  /** The avatar button's accessible name. */
  label?: string;
}

/** Two letters for an avatar: "ali.safari@x" → "AS", "ali@x" → "AL"; "#" for no letters, "?" for nothing. */
export function initialsOf(label: string | null | undefined): string {
  if (!label) return "?";
  const local = label.includes("@") ? label.slice(0, label.indexOf("@")) : label;
  const words = local.split(/[^\p{L}\p{N}]+/u).filter((w) => /\p{L}/u.test(w));
  if (words.length === 0) return "#";
  const first = words[0]!;
  const second = words[1];
  return (second ? first[0]! + second[0]! : first.slice(0, 2)).toUpperCase();
}

/** A stable hue for a person, so their avatar has the same colour in every app. */
export function hueOf(label: string | null | undefined): number {
  let h = 0;
  for (const ch of label ?? "") h = (h * 31 + ch.codePointAt(0)!) % 360;
  return h;
}

export const USER_MENU_CSS = `
.asafarim-user{--u-bg:var(--card,#fff);--u-ink:var(--ink,#1d1b16);--u-muted:var(--muted,#6b6559);--u-line:var(--line,#e4dfd3);--u-accent:var(--accent,#7c3aed);position:relative;display:inline-block}
@media (prefers-color-scheme:dark){.asafarim-user{--u-bg:var(--card,#1f1c17);--u-ink:var(--ink,#f1ece2);--u-muted:var(--muted,#a39c8e);--u-line:var(--line,#37322a);--u-accent:var(--accent,#a78bfa)}}
.asafarim-user__button{position:relative;display:inline-grid;place-items:center;width:2.5rem;height:2.5rem;padding:0;border:0;border-radius:50%;background:transparent;cursor:pointer}
.asafarim-user__button::before{content:"";position:absolute;inset:0;border-radius:50%;background:conic-gradient(from 0deg,var(--u-accent),hsl(var(--u-hue) 70% 55%),transparent 70%,var(--u-accent));opacity:.55;transition:opacity .2s}
.asafarim-user__button:hover::before,.asafarim-user__button[aria-expanded="true"]::before{opacity:1;animation:asafarim-spin 2.4s linear infinite}
.asafarim-user__button:focus-visible,.asafarim-user__item:focus-visible{outline:2px solid var(--u-accent);outline-offset:2px}
.asafarim-user__avatar{position:relative;display:inline-grid;place-items:center;width:2.125rem;height:2.125rem;border-radius:50%;background:linear-gradient(135deg,hsl(var(--u-hue) 65% 52%),hsl(calc(var(--u-hue) + 40) 70% 38%));color:#fff;font-size:.8rem;font-weight:700;letter-spacing:.02em;box-shadow:0 0 0 2px var(--u-bg)}
.asafarim-user__dot{position:absolute;right:1px;bottom:1px;width:.6rem;height:.6rem;border-radius:50%;background:#22c55e;box-shadow:0 0 0 2px var(--u-bg)}
.asafarim-user__dot::after{content:"";position:absolute;inset:0;border-radius:50%;background:#22c55e;animation:asafarim-ping 2.2s cubic-bezier(0,0,.2,1) infinite}
.asafarim-user__menu{position:absolute;z-index:50;top:calc(100% + 8px);right:0;width:max-content;min-width:16rem;max-width:min(20rem,calc(100vw - 2rem));padding:.375rem;border:1px solid var(--u-line);border-radius:14px;background:var(--u-bg);color:var(--u-ink);box-shadow:0 14px 36px rgb(0 0 0 / .25);transform-origin:top right;animation:asafarim-pop .18s cubic-bezier(.2,.8,.2,1)}
.asafarim-user__card{display:flex;align-items:center;gap:.75rem;padding:.625rem .5rem .75rem;border-bottom:1px solid var(--u-line);margin-bottom:.25rem}
.asafarim-user__card .asafarim-user__avatar{width:2.75rem;height:2.75rem;font-size:1rem}
.asafarim-user__who{display:grid;min-width:0}
.asafarim-user__name{font-weight:700;line-height:1.3;overflow-wrap:anywhere}
.asafarim-user__email{color:var(--u-muted);font-size:.8rem;overflow-wrap:anywhere}
.asafarim-user__item{display:flex;align-items:center;gap:.625rem;width:100%;padding:.5rem;border:0;border-radius:8px;background:transparent;color:var(--u-ink);font:inherit;font-size:.9rem;text-align:left;text-decoration:none;cursor:pointer;transition:background-color .12s,transform .12s}
.asafarim-user__item:hover{background:color-mix(in srgb,var(--u-accent) 12%,transparent);transform:translateX(2px)}
.asafarim-user__item svg{flex:none;width:1.1rem;height:1.1rem;color:var(--u-muted)}
.asafarim-user__menu>*{animation:asafarim-rise .22s cubic-bezier(.2,.8,.2,1) both;animation-delay:calc(var(--i,0) * 35ms)}
.asafarim-user__foot{margin-top:.25rem;padding-top:.25rem;border-top:1px solid var(--u-line)}
.asafarim-user__foot form{margin:0}
.asafarim-user__foot button{display:flex;align-items:center;gap:.625rem;width:100%;padding:.5rem;border:0;border-radius:8px;background:transparent;color:var(--u-ink);font:inherit;font-size:.9rem;text-align:left;cursor:pointer}
.asafarim-user__foot button:hover{background:color-mix(in srgb,#dc2626 12%,transparent);color:#dc2626}
.asafarim-user__foot button:focus-visible{outline:2px solid var(--u-accent);outline-offset:2px}
@keyframes asafarim-pop{from{opacity:0;transform:translateY(-6px) scale(.97)}to{opacity:1;transform:none}}
@keyframes asafarim-rise{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@keyframes asafarim-spin{to{transform:rotate(1turn)}}
@keyframes asafarim-ping{75%,100%{opacity:0;transform:scale(2.2)}}
@media (prefers-reduced-motion:reduce){.asafarim-user *,.asafarim-user *::before,.asafarim-user *::after{animation:none!important;transition:none!important}}
`;

function PersonIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <circle cx="10" cy="7" r="3.25" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M3.5 17c.9-3.2 3.4-5 6.5-5s5.6 1.8 6.5 5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

const ITEMS = "a[href],button:not([disabled])";

export function UserMenu({
  name,
  email,
  accountHref = ACCOUNT_URL,
  home = OS_HOME,
  signOut,
  label = "Your account menu",
}: UserMenuProps) {
  const shownName = name || email || "Signed in";
  const shownEmail = email && email !== shownName ? email : null;
  const initials = initialsOf(name || email);
  const hue = { "--u-hue": hueOf(email || name) } as object;
  const account = safeHref(accountHref);
  const homeHref = home ? safeHref(home.href) : undefined;

  const [open, setOpen] = useState(false);
  const [focusFirst, setFocusFirst] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const items = () => {
    const menu = menuRef.current as unknown as QueryRoot | null;
    return menu ? Array.from(menu.querySelectorAll(ITEMS)) : [];
  };

  useEffect(() => {
    if (open && focusFirst) focusOn(items()[0]);
  }, [open, focusFirst]);

  useEffect(() => {
    const doc = browserDocument();
    if (!open || !doc) return;
    const onDown = (e: { target: unknown }) => {
      const root = rootRef.current as unknown as QueryRoot | null;
      if (!root?.contains(e.target)) setOpen(false);
    };
    doc.addEventListener("pointerdown", onDown);
    return () => doc.removeEventListener("pointerdown", onDown);
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    setFocusFirst(false);
    if (refocus) focusOn(buttonRef.current);
  };
  const openMenu = (withFocus: boolean) => {
    setOpen(true);
    setFocusFirst(withFocus);
  };

  const onButtonKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      e.preventDefault();
      if (open && e.key !== "ArrowDown") close(false);
      else openMenu(true);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      close(true);
    }
  };
  const onMenuKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
      return;
    }
    if (e.key === "Tab") {
      close(false);
      return;
    }
    const list = items();
    const index = list.indexOf(browserDocument()?.activeElement);
    const next = moveIndex(e.key, index, list.length);
    if (next !== undefined) {
      e.preventDefault();
      focusOn(list[next]);
    }
  };

  return (
    <div className="asafarim-user" ref={rootRef} style={hue} data-testid="user-menu">
      <style>{USER_MENU_CSS}</style>
      <button
        ref={buttonRef}
        type="button"
        className="asafarim-user__button"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`${label}: ${shownName}`}
        title={shownName}
        onClick={() => (open ? close(false) : openMenu(false))}
        onKeyDown={onButtonKey}
      >
        <span className="asafarim-user__avatar" aria-hidden="true">
          {initials}
          <span className="asafarim-user__dot" />
        </span>
      </button>
      {open ? (
        <div
          id={menuId}
          ref={menuRef}
          className="asafarim-user__menu"
          role="group"
          aria-label={label}
          onKeyDown={onMenuKey}
        >
          <div className="asafarim-user__card">
            <span className="asafarim-user__avatar" aria-hidden="true">
              {initials}
            </span>
            <span className="asafarim-user__who">
              <span className="asafarim-user__name" data-testid="user-menu-name">
                {shownName}
              </span>
              {shownEmail ? <span className="asafarim-user__email">{shownEmail}</span> : null}
            </span>
          </div>
          {account ? (
            <a
              className="asafarim-user__item"
              href={account}
              style={{ "--i": 1 } as object}
              data-testid="user-menu-account"
            >
              <PersonIcon />
              Your account
            </a>
          ) : null}
          {homeHref && home ? (
            <a
              className="asafarim-user__item"
              href={homeHref}
              style={{ "--i": 2 } as object}
              data-testid="user-menu-home"
            >
              <HomeIcon />
              {home.label}
            </a>
          ) : null}
          {signOut ? (
            <div className="asafarim-user__foot" style={{ "--i": 3 } as object}>
              {signOut}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
