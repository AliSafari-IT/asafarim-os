/**
 * The words of the shared shell components (AppSwitcher, UserMenu) in the OS's four languages. A component takes
 * `locale` ("en" by default); apps read the visitor's language with @asafarim/locale. The links to asafarim.site
 * and to the products follow the language too, where those sites have it.
 */
export type ShellLocale = "en" | "nl" | "fr" | "de";

export interface ShellText {
  yourApps: string;
  switchApp: (name: string) => string;
  switchTitle: string;
  choose: string;
  apps: string;
  noApps: string;
  open: string;
  moreNote: string;
  moreFrom: string;
  osHome: string;
  breinhap: string;
  igs: string;
  observatory: string;
  accountMenu: string;
  signedIn: string;
  yourAccount: string;
}

const EN: ShellText = {
  yourApps: "Your apps",
  switchApp: (name) => `${name}: switch app`,
  switchTitle: "Switch app",
  choose: "Choose an app to open.",
  apps: "Apps",
  noApps: "No apps to show right now.",
  open: "Open",
  moreNote: "More apps appear here as you get access to them.",
  moreFrom: "More from ASafariM",
  osHome: "ASafariM OS home",
  breinhap: "Study app for Flemish students (Android)",
  igs: "Online pharmacy for Belgium, and its Android app",
  observatory: "Workspace observations and AI summaries",
  accountMenu: "Your account menu",
  signedIn: "Signed in",
  yourAccount: "Your account",
};

const NL: ShellText = {
  yourApps: "Je apps",
  switchApp: (name) => `${name}: van app wisselen`,
  switchTitle: "Van app wisselen",
  choose: "Kies een app om te openen.",
  apps: "Apps",
  noApps: "Er zijn nu geen apps om te tonen.",
  open: "Open",
  moreNote: "Meer apps verschijnen hier zodra je er toegang toe krijgt.",
  moreFrom: "Meer van ASafariM",
  osHome: "Startpagina van ASafariM OS",
  breinhap: "Studie-app voor Vlaamse leerlingen (Android)",
  igs: "Onlineapotheek voor België, en de Android-app",
  observatory: "Werkruimteobservaties en AI-samenvattingen",
  accountMenu: "Je accountmenu",
  signedIn: "Aangemeld",
  yourAccount: "Je account",
};

const FR: ShellText = {
  yourApps: "Vos applications",
  switchApp: (name) => `${name} : changer d’application`,
  switchTitle: "Changer d’application",
  choose: "Choisissez une application à ouvrir.",
  apps: "Applications",
  noApps: "Aucune application à afficher pour l’instant.",
  open: "Ouverte",
  moreNote: "D’autres applications apparaissent ici dès que vous y avez accès.",
  moreFrom: "Plus d’ASafariM",
  osHome: "Accueil d’ASafariM OS",
  breinhap: "Application d’étude pour les élèves flamands (Android)",
  igs: "Pharmacie en ligne pour la Belgique, et son application Android",
  observatory: "Observations de travail et résumés IA",
  accountMenu: "Menu de votre compte",
  signedIn: "Connecté",
  yourAccount: "Votre compte",
};

const DE: ShellText = {
  yourApps: "Ihre Apps",
  switchApp: (name) => `${name}: App wechseln`,
  switchTitle: "App wechseln",
  choose: "Wählen Sie eine App zum Öffnen.",
  apps: "Apps",
  noApps: "Im Moment gibt es keine Apps zum Anzeigen.",
  open: "Geöffnet",
  moreNote: "Weitere Apps erscheinen hier, sobald Sie Zugang dazu haben.",
  moreFrom: "Mehr von ASafariM",
  osHome: "Startseite von ASafariM OS",
  breinhap: "Lern-App für flämische Schülerinnen und Schüler (Android)",
  igs: "Online-Apotheke für Belgien, und ihre Android-App",
  observatory: "Arbeitsbereichsbeobachtungen und KI-Zusammenfassungen",
  accountMenu: "Ihr Kontomenü",
  signedIn: "Angemeldet",
  yourAccount: "Ihr Konto",
};

const TEXT: Readonly<Record<ShellLocale, ShellText>> = { en: EN, nl: NL, fr: FR, de: DE };

export const shellText = (locale: ShellLocale = "en"): ShellText => TEXT[locale] ?? EN;

/** asafarim.site in a language (English at the root, the others under /nl/, /fr/, /de/). */
export const osHomeHref = (locale: ShellLocale = "en") =>
  `https://asafarim.site/${locale === "en" ? "" : `${locale}/`}`;

/** The products' pages in a language, where their sites have it (Breinhap: Dutch or English only). */
export const productHref = (product: "breinhap" | "igs" | "observatory", locale: ShellLocale = "en") =>
  product === "observatory"
    ? "https://observatory.asafarim.site/"
    : product === "igs"
      ? `https://igs.asafarim.site/${locale}/`
      : locale === "nl"
        ? "https://breinhap.asafarim.site/"
        : "https://breinhap.asafarim.site/en/";
