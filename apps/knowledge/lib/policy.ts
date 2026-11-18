/**
 * Who may do what to an article. Pure, so every rule is unit-tested: the permissions come from core-api
 * (granted to the person by an admin, never by the app), ownership comes from the item. The studio gate
 * checks `knowledge.content.create` first; these rules decide the rest per item, on every mutation.
 */

export const PERMISSIONS = {
  create: "knowledge.content.create",
  editOwn: "knowledge.content.edit.own",
  editAny: "knowledge.content.edit.any",
  publishOwn: "knowledge.content.publish.own",
  publishAny: "knowledge.content.publish.any",
} as const;

/** The signed-in person, as the studio gate established them. */
export interface Actor {
  subject: string;
  permissions: readonly string[];
}

const has = (actor: Actor, permission: string) => actor.permissions.includes(permission);
const owns = (actor: Actor, item: { ownerSubject: string }) => item.ownerSubject === actor.subject;

export function canCreate(actor: Actor): boolean {
  return has(actor, PERMISSIONS.create);
}

/** Sees the item in the studio at all. Anyone else gets "not found", so ids of others' drafts leak nothing. */
export function canView(actor: Actor, item: { ownerSubject: string }): boolean {
  return canEdit(actor, item) || canPublish(actor, item);
}

export function canEdit(actor: Actor, item: { ownerSubject: string }): boolean {
  return has(actor, PERMISSIONS.editAny) || (has(actor, PERMISSIONS.editOwn) && owns(actor, item));
}

/** Publishing and withdrawing are one capability: whoever may make a revision public may take it down. */
export function canPublish(actor: Actor, item: { ownerSubject: string }): boolean {
  return has(actor, PERMISSIONS.publishAny) || (has(actor, PERMISSIONS.publishOwn) && owns(actor, item));
}

/** Lists every item in the studio, not only the person's own. */
export function seesAll(actor: Actor): boolean {
  return has(actor, PERMISSIONS.editAny) || has(actor, PERMISSIONS.publishAny);
}
