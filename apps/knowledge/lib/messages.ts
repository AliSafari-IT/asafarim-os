/** What the studio says after an action, keyed by the `error` / `done` query value the actions redirect with. */
export const ERRORS: Record<string, string> = {
  forbidden: "You don't have permission to do that with this article.",
  not_found: "That article doesn't exist, or it isn't yours.",
  slug_taken: "Another article already uses that address. Choose a different slug.",
  conflict:
    "Someone saved a newer revision while you were editing. Nothing was overwritten: your text is still in the form. Compare it with the newest revision in the history, then save again to put your text on top of it.",
  unauthenticated: "Your session ended. Sign in again; your text is still in the form, so copy it first.",
  unknown_revision: "That revision doesn't belong to this article.",
  not_published: "The article isn't published.",
  title_required: "A title is required.",
  title_too_long: "The title can be at most 200 characters.",
  summary_too_long: "The summary can be at most 500 characters.",
  body_too_long: "The body can be at most 200 000 characters.",
  invalid_slug: "The slug can only use lower-case letters, digits and single dashes.",
  app_inactive: "ASafariM Knowledge isn't active right now.",
  permissions_unavailable: "Permissions can't be checked right now. Try again in a moment.",
};

export const DONE: Record<string, string> = {
  created: "Draft created.",
  saved: "Draft saved as a new revision.",
  published: "Published. Guests now see this revision.",
  withdrawn: "Withdrawn. The article is no longer public.",
};
