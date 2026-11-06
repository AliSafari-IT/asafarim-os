/**
 * The Admin console's chrome in English, Dutch, French and German: the top bar, navigation, sign-in and 403
 * pages. English is the default. The data pages (audit, events, status, roles & grants tables) show
 * identifiers, events and operator text and stay in English for now. Safe in client components.
 */
import type { Locale } from "@asafarim/locale";

export interface Messages {
  skipToContent: string;
  adminNav: string;
  nav: { apps: string; status: string; events: string; roles: string; audit: string };
  signOut: string;
  signInIntro: string;
  signIn: string;
  forbiddenTitle: string;
  forbiddenBefore: string;
  forbiddenAfter: string;
}

const EN: Messages = {
  skipToContent: "Skip to content",
  adminNav: "Admin",
  nav: { apps: "Apps", status: "Status", events: "Events", roles: "Roles & grants", audit: "Audit" },
  signOut: "Sign out",
  signInIntro: "Sign in with your ASafariM account. Only platform administrators can use the console.",
  signIn: "Sign in",
  forbiddenTitle: "403: not allowed",
  forbiddenBefore: "The Admin console needs the platform role",
  forbiddenAfter: "and your account doesn't hold it. Ask an administrator to grant it.",
};

const NL: Messages = {
  skipToContent: "Ga naar de inhoud",
  adminNav: "Beheer",
  nav: { apps: "Apps", status: "Status", events: "Gebeurtenissen", roles: "Rollen & rechten", audit: "Audit" },
  signOut: "Afmelden",
  signInIntro: "Meld je aan met je ASafariM-account. Alleen platformbeheerders kunnen de console gebruiken.",
  signIn: "Aanmelden",
  forbiddenTitle: "403: niet toegestaan",
  forbiddenBefore: "De beheerconsole vraagt de platformrol",
  forbiddenAfter: "en je account heeft die niet. Vraag een beheerder om ze toe te kennen.",
};

const FR: Messages = {
  skipToContent: "Aller au contenu",
  adminNav: "Administration",
  nav: { apps: "Applications", status: "État", events: "Événements", roles: "Rôles et droits", audit: "Audit" },
  signOut: "Se déconnecter",
  signInIntro:
    "Connectez-vous avec votre compte ASafariM. Seuls les administrateurs de la plateforme peuvent utiliser la console.",
  signIn: "Se connecter",
  forbiddenTitle: "403 : non autorisé",
  forbiddenBefore: "La console d’administration nécessite le rôle de plateforme",
  forbiddenAfter: "et votre compte ne l’a pas. Demandez à un administrateur de vous l’attribuer.",
};

const DE: Messages = {
  skipToContent: "Zum Inhalt springen",
  adminNav: "Administration",
  nav: { apps: "Apps", status: "Status", events: "Ereignisse", roles: "Rollen & Rechte", audit: "Audit" },
  signOut: "Abmelden",
  signInIntro: "Melden Sie sich mit Ihrem ASafariM-Konto an. Nur Plattform-Administratoren können die Konsole nutzen.",
  signIn: "Anmelden",
  forbiddenTitle: "403: nicht erlaubt",
  forbiddenBefore: "Die Admin-Konsole braucht die Plattformrolle",
  forbiddenAfter: "und Ihr Konto hat sie nicht. Bitten Sie einen Administrator, sie zu erteilen.",
};

export const MESSAGES: Readonly<Record<Locale, Messages>> = { en: EN, nl: NL, fr: FR, de: DE };

export const messagesFor = (locale: Locale): Messages => MESSAGES[locale] ?? EN;
