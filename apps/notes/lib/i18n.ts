/**
 * Notes in English, Dutch, French and German. The page's language comes from @asafarim/locale (the shared
 * asafarim-locale cookie, then the browser, then English); English is the default and the e2e tests' language.
 * Permission names, roles and states (`notes.write`, `active`) are identifiers, not words, and stay as they are.
 */
import type { Locale } from "@asafarim/locale";

export interface Messages {
  signInIntro: string;
  signIn: string;
  signOut: string;
  errors: Record<string, string>;
  permissionsUnavailable: string;
  stateBefore: string;
  stateAfter: string;
  yourRoles: string;
  permissions: string;
  none: string;
  title: string;
  note: string;
  addNote: string;
  needsWrite: string;
  noNotes: string;
  needsRead: string;
  askAdmin: string;
}

const EN: Messages = {
  signInIntro: "Sign in with your ASafariM account to read and write notes.",
  signIn: "Sign in",
  signOut: "Sign out",
  errors: {
    forbidden: "403 Forbidden: you don't have the permission",
    invalid_note: "A title of 1–200 characters is required.",
    limit_reached: "The app has reached its note limit.",
    app_inactive: "The app isn't active.",
    unauthenticated: "Sign in first.",
    permissions_unavailable: "Permissions can't be checked right now.",
  },
  permissionsUnavailable: "Permissions can't be checked right now (core-api is unreachable).",
  stateBefore: "This app is ",
  stateAfter: ". An admin has to activate it.",
  yourRoles: "Your roles",
  permissions: "permissions",
  none: "none",
  title: "Title",
  note: "Note",
  addNote: "Add note",
  needsWrite: "Adding notes needs the permission",
  noNotes: "No notes yet.",
  needsRead: "Reading notes needs the permission",
  askAdmin: "Ask an admin for the",
};

const NL: Messages = {
  signInIntro: "Meld je aan met je ASafariM-account om notities te lezen en te schrijven.",
  signIn: "Aanmelden",
  signOut: "Afmelden",
  errors: {
    forbidden: "403 Verboden: je hebt de nodige toestemming niet",
    invalid_note: "Een titel van 1 tot 200 tekens is verplicht.",
    limit_reached: "De app heeft zijn limiet aan notities bereikt.",
    app_inactive: "De app is niet actief.",
    unauthenticated: "Meld je eerst aan.",
    permissions_unavailable: "De toestemmingen kunnen nu niet worden gecontroleerd.",
  },
  permissionsUnavailable: "De toestemmingen kunnen nu niet worden gecontroleerd (core-api is onbereikbaar).",
  stateBefore: "Deze app is ",
  stateAfter: ". Een beheerder moet ze activeren.",
  yourRoles: "Je rollen",
  permissions: "toestemmingen",
  none: "geen",
  title: "Titel",
  note: "Notitie",
  addNote: "Notitie toevoegen",
  needsWrite: "Notities toevoegen vraagt de toestemming",
  noNotes: "Nog geen notities.",
  needsRead: "Notities lezen vraagt de toestemming",
  askAdmin: "Vraag een beheerder om de rol",
};

const FR: Messages = {
  signInIntro: "Connectez-vous avec votre compte ASafariM pour lire et écrire des notes.",
  signIn: "Se connecter",
  signOut: "Se déconnecter",
  errors: {
    forbidden: "403 Interdit : vous n’avez pas l’autorisation requise",
    invalid_note: "Un titre de 1 à 200 caractères est obligatoire.",
    limit_reached: "L’application a atteint sa limite de notes.",
    app_inactive: "L’application n’est pas active.",
    unauthenticated: "Connectez-vous d’abord.",
    permissions_unavailable: "Les autorisations ne peuvent pas être vérifiées pour le moment.",
  },
  permissionsUnavailable: "Les autorisations ne peuvent pas être vérifiées pour le moment (core-api est injoignable).",
  stateBefore: "Cette application est ",
  stateAfter: ". Un administrateur doit l’activer.",
  yourRoles: "Vos rôles",
  permissions: "autorisations",
  none: "aucun",
  title: "Titre",
  note: "Note",
  addNote: "Ajouter la note",
  needsWrite: "Ajouter des notes nécessite l’autorisation",
  noNotes: "Aucune note pour l’instant.",
  needsRead: "Lire les notes nécessite l’autorisation",
  askAdmin: "Demandez à un administrateur le rôle",
};

const DE: Messages = {
  signInIntro: "Melden Sie sich mit Ihrem ASafariM-Konto an, um Notizen zu lesen und zu schreiben.",
  signIn: "Anmelden",
  signOut: "Abmelden",
  errors: {
    forbidden: "403 Verboten: Ihnen fehlt die nötige Berechtigung",
    invalid_note: "Ein Titel mit 1 bis 200 Zeichen ist erforderlich.",
    limit_reached: "Die App hat ihr Notizlimit erreicht.",
    app_inactive: "Die App ist nicht aktiv.",
    unauthenticated: "Bitte melden Sie sich zuerst an.",
    permissions_unavailable: "Die Berechtigungen können gerade nicht geprüft werden.",
  },
  permissionsUnavailable: "Die Berechtigungen können gerade nicht geprüft werden (core-api ist nicht erreichbar).",
  stateBefore: "Diese App ist ",
  stateAfter: ". Ein Administrator muss sie aktivieren.",
  yourRoles: "Ihre Rollen",
  permissions: "Berechtigungen",
  none: "keine",
  title: "Titel",
  note: "Notiz",
  addNote: "Notiz hinzufügen",
  needsWrite: "Zum Hinzufügen von Notizen ist die Berechtigung nötig:",
  noNotes: "Noch keine Notizen.",
  needsRead: "Zum Lesen von Notizen ist die Berechtigung nötig:",
  askAdmin: "Bitten Sie einen Administrator um die Rolle",
};

export const MESSAGES: Readonly<Record<Locale, Messages>> = { en: EN, nl: NL, fr: FR, de: DE };

export const messagesFor = (locale: Locale): Messages => MESSAGES[locale] ?? EN;
