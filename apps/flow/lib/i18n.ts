/**
 * Flow's chrome in English, Dutch, French and German: the top bar, the tabs, the 401 and 403 pages. English is
 * the default. The pages themselves (workflows, runs, the builder, credentials) still read in English: they
 * show workflow definitions, step names and operator text.
 */
import type { Locale } from "@asafarim/locale";

export interface Messages {
  tabsLabel: string;
  tabs: { overview: string; runs: string; approvals: string; workflows: string; credentials: string; settings: string };
  signOut: string;
  signInIntro: string;
  signIn: string;
  noAccess: string;
  needsBefore: string;
  askAdminFor: string;
}

const EN: Messages = {
  tabsLabel: "Flow",
  tabs: {
    overview: "Overview",
    runs: "Runs",
    approvals: "Approvals",
    workflows: "Workflows",
    credentials: "Credentials",
    settings: "Settings",
  },
  signOut: "Sign out",
  signInIntro: "Workflows across your ASafariM apps. Sign in with your ASafariM account.",
  signIn: "Sign in",
  noAccess: "You don't have access",
  needsBefore: "Flow needs the permission",
  askAdminFor: "Ask an admin for the",
};

const NL: Messages = {
  tabsLabel: "Flow",
  tabs: {
    overview: "Overzicht",
    runs: "Uitvoeringen",
    approvals: "Goedkeuringen",
    workflows: "Workflows",
    credentials: "Inloggegevens",
    settings: "Instellingen",
  },
  signOut: "Afmelden",
  signInIntro: "Workflows over je ASafariM-apps heen. Meld je aan met je ASafariM-account.",
  signIn: "Aanmelden",
  noAccess: "Je hebt geen toegang",
  needsBefore: "Flow vraagt de toestemming",
  askAdminFor: "Vraag een beheerder om de rol",
};

const FR: Messages = {
  tabsLabel: "Flow",
  tabs: {
    overview: "Aperçu",
    runs: "Exécutions",
    approvals: "Approbations",
    workflows: "Workflows",
    credentials: "Identifiants",
    settings: "Paramètres",
  },
  signOut: "Se déconnecter",
  signInIntro: "Des workflows à travers vos applications ASafariM. Connectez-vous avec votre compte ASafariM.",
  signIn: "Se connecter",
  noAccess: "Vous n’avez pas accès",
  needsBefore: "Flow nécessite l’autorisation",
  askAdminFor: "Demandez à un administrateur le rôle",
};

const DE: Messages = {
  tabsLabel: "Flow",
  tabs: {
    overview: "Übersicht",
    runs: "Ausführungen",
    approvals: "Freigaben",
    workflows: "Workflows",
    credentials: "Zugangsdaten",
    settings: "Einstellungen",
  },
  signOut: "Abmelden",
  signInIntro: "Workflows über Ihre ASafariM-Apps hinweg. Melden Sie sich mit Ihrem ASafariM-Konto an.",
  signIn: "Anmelden",
  noAccess: "Sie haben keinen Zugriff",
  needsBefore: "Flow braucht die Berechtigung",
  askAdminFor: "Bitten Sie einen Administrator um die Rolle",
};

export const MESSAGES: Readonly<Record<Locale, Messages>> = { en: EN, nl: NL, fr: FR, de: DE };

export const messagesFor = (locale: Locale): Messages => MESSAGES[locale] ?? EN;
