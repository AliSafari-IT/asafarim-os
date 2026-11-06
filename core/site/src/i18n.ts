/**
 * asafarim.site in English, Dutch, French and German (@asafarim/locale's languages). English lives at /, the
 * others at /nl/, /fr/ and /de/. This file holds the page's own words; progress-i18n.ts translates the
 * progress file's apps, screenshots, roadmap and links. The shipped milestones are a changelog of merged
 * pull requests and stay in English on every page (marked lang="en"), like the legal texts until a
 * reviewed translation exists.
 */
import type { Locale } from "../../../packages/locale/src/index.ts";

export type { Locale };
export const SITE_LOCALES = ["en", "nl", "fr", "de"] as const satisfies readonly Locale[];

/** A page's path for a locale: "" is the home page, "privacy" a legal page. Always ends without a slash for pages. */
export function localePath(locale: Locale, page = ""): string {
  const prefix = locale === "en" ? "/" : `/${locale}/`;
  return `${prefix}${page}`;
}

/** Where ASafariM's products are in each language (their sites don't all have four). */
export const PRODUCT_HREFS: Readonly<Record<"breinhap" | "breinhapWeb" | "igs", Record<Locale, string>>> = {
  breinhap: {
    en: "https://breinhap.asafarim.site/en/",
    nl: "https://breinhap.asafarim.site/",
    fr: "https://breinhap.asafarim.site/en/",
    de: "https://breinhap.asafarim.site/en/",
  },
  breinhapWeb: {
    en: "https://breinhap.com/en/",
    nl: "https://breinhap.com/",
    fr: "https://breinhap.com/en/",
    de: "https://breinhap.com/en/",
  },
  igs: {
    en: "https://igs.asafarim.site/en/",
    nl: "https://igs.asafarim.site/nl/",
    fr: "https://igs.asafarim.site/fr/",
    de: "https://igs.asafarim.site/de/",
  },
};

export interface SiteText {
  title: string;
  description: string;
  months: readonly string[];
  nav: {
    main: string;
    open: string;
    apps: string;
    workspace: string;
    workspaceLead: string;
    docs: string;
    flow: string;
    breinhapWeb: string;
    breinhapManagement: string;
    appsFoot: string;
    everyApp: string;
    products: string;
    moreFrom: string;
    explore: string;
    breinhap: string;
    igs: string;
    productsFoot: string;
    platform: string;
    signIn: string;
  };
  /** The hero's sign-in hint, as HTML with the three links filled in. */
  access: (signIn: string, docs: string, flow: string) => string;
  badge: (date: string) => string;
  lead: string;
  benefitsLabel: string;
  benefits: readonly string[];
  note: string;
  linksLabel: string;
  apps: {
    title: string;
    lead: string;
    os: string;
    products: string;
    productsLead: string;
    whereToFind: (name: string) => string;
  };
  status: { live: string; "early-access": string; testing: string; "in-development": string; "staff-only": string };
  shipped: { title: string; lead: string; prs: string; inEnglish: string };
  screenshots: { title: string; lead: string };
  roadmap: { title: string };
  footer: { website: string; source: string };
  legal: {
    labels: { privacy: string; cookies: string; terms: string };
    titles: { privacy: string; cookies: string; terms: string };
    onThisPage: string;
    updated: (date: string) => string;
    seeAlso: string;
    /** Above an English legal text on a translated page. Empty in English. */
    inEnglish: string;
  };
}

const EN: SiteText = {
  title: "ASafariM OS: the operating system apps plug into",
  description:
    "ASafariM OS is a base platform that apps plug into. Every app gets sign-in, permissions, routing, events, lifecycle and monitoring from the OS instead of building them itself.",
  months: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  nav: {
    main: "Main",
    open: "Open navigation",
    apps: "Apps",
    workspace: "Your workspace",
    workspaceLead: "Tools connected to ASafariM OS",
    docs: "Guides and your workspace",
    flow: "Automate work with workflows",
    breinhapWeb: "Website; browser missions are coming later",
    breinhapManagement: "Workspace for invited adults",
    appsFoot: "One sign-in. A connected workspace.",
    everyApp: "Every app",
    products: "Products",
    moreFrom: "More from ASafariM",
    explore: "Explore our products",
    breinhap: "Short study missions for secondary school",
    igs: "Belgian online pharmacy with a pharmacist",
    productsFoot: "Webshop, Android app and status",
    platform: "Platform",
    signIn: "Sign in",
  },
  access: (signIn, docs, flow) =>
    `Have access? ${signIn}, then open ${docs} or
        ${flow}, if your account has access.
        No access yet? Sign in with your email and choose <em>Request connection</em>: an admin approves it.`,
  badge: (date) => `In development · updated ${date}`,
  lead: "A base platform: an operating system that apps plug into. Every app gets the OS's advantages without building them itself.",
  benefitsLabel: "What every app gets from the OS",
  benefits: ["Sign-in", "Permissions", "Routing", "Events", "Lifecycle", "Monitoring"],
  note: "ASafariM OS is a new system with its own apps. It is not a migration of the asafarim.com platform, which keeps running as it is.",
  linksLabel: "Links",
  apps: {
    title: "Apps",
    lead: "What runs on ASafariM OS, and the products built alongside it: every place you can reach each one, and how far it is.",
    os: "Built into the OS",
    products: "Products built by ASafariM",
    productsLead: "Their own code and domains, with the OS's look; their project pages are served by the OS stack.",
    whereToFind: (name) => `Where to find ${name}`,
  },
  status: {
    live: "Live",
    "early-access": "Early access",
    testing: "Testing",
    "in-development": "In development",
    "staff-only": "Staff only",
  },
  shipped: {
    title: "Shipped",
    lead: "What is built and merged so far, phase by phase.",
    prs: "Merged pull requests:",
    inEnglish: "",
  },
  screenshots: {
    title: "Screenshots",
    lead: "Taken by Playwright from the end-to-end test environment, not drawn by hand.",
  },
  roadmap: { title: "Roadmap" },
  footer: { website: "Website", source: "Source on GitHub" },
  legal: {
    labels: { privacy: "Privacy", cookies: "Cookies", terms: "Terms" },
    titles: { privacy: "Privacy policy", cookies: "Cookie policy", terms: "Terms of use" },
    onThisPage: "On this page",
    updated: (date) => `Last updated ${date}.`,
    seeAlso: "See also",
    inEnglish: "",
  },
};

const NL: SiteText = {
  title: "ASafariM OS: het besturingssysteem waar apps op aansluiten",
  description:
    "ASafariM OS is een basisplatform waar apps op aansluiten. Elke app krijgt aanmelden, rechten, routering, events, levenscyclus en monitoring van het OS, in plaats van ze zelf te bouwen.",
  months: ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"],
  nav: {
    main: "Hoofdmenu",
    open: "Menu openen",
    apps: "Apps",
    workspace: "Je werkruimte",
    workspaceLead: "Tools verbonden met ASafariM OS",
    docs: "Handleidingen en je werkruimte",
    flow: "Werk automatiseren met workflows",
    breinhapWeb: "Website; missies in de browser volgen later",
    breinhapManagement: "Werkruimte voor uitgenodigde volwassenen",
    appsFoot: "Eén keer aanmelden. Een verbonden werkruimte.",
    everyApp: "Alle apps",
    products: "Producten",
    moreFrom: "Meer van ASafariM",
    explore: "Ontdek onze producten",
    breinhap: "Korte studiemissies voor het secundair onderwijs",
    igs: "Belgische onlineapotheek met een apotheker",
    productsFoot: "Webshop, Android-app en status",
    platform: "Platform",
    signIn: "Aanmelden",
  },
  access: (signIn, docs, flow) =>
    `Heb je toegang? ${signIn} en open dan ${docs} of
        ${flow}, als je account er toegang toe heeft.
        Nog geen toegang? Meld je aan met je e-mailadres en kies <em>Request connection</em>: een beheerder keurt het goed.`,
  badge: (date) => `In ontwikkeling · bijgewerkt op ${date}`,
  lead: "Een basisplatform: een besturingssysteem waar apps op aansluiten. Elke app krijgt de voordelen van het OS zonder ze zelf te bouwen.",
  benefitsLabel: "Wat elke app van het OS krijgt",
  benefits: ["Aanmelden", "Rechten", "Routering", "Events", "Levenscyclus", "Monitoring"],
  note: "ASafariM OS is een nieuw systeem met eigen apps. Het is geen migratie van het asafarim.com-platform, dat blijft werken zoals het is.",
  linksLabel: "Links",
  apps: {
    title: "Apps",
    lead: "Wat er op ASafariM OS draait, en de producten die ernaast gebouwd worden: waar je elk ervan vindt, en hoe ver het staat.",
    os: "Ingebouwd in het OS",
    products: "Producten van ASafariM",
    productsLead:
      "Met hun eigen code en domeinen, in de stijl van het OS; hun projectpagina's worden door het OS geserveerd.",
    whereToFind: (name) => `Waar je ${name} vindt`,
  },
  status: {
    live: "Live",
    "early-access": "Vroege toegang",
    testing: "In test",
    "in-development": "In ontwikkeling",
    "staff-only": "Alleen personeel",
  },
  shipped: {
    title: "Opgeleverd",
    lead: "Wat er tot nu toe gebouwd en samengevoegd is, fase per fase.",
    prs: "Samengevoegde pull requests:",
    inEnglish: "Deze lijst is een changelog van de code en staat in het Engels.",
  },
  screenshots: {
    title: "Schermafbeeldingen",
    lead: "Gemaakt door Playwright in de end-to-end-testomgeving, niet met de hand getekend.",
  },
  roadmap: { title: "Roadmap" },
  footer: { website: "Website", source: "Broncode op GitHub" },
  legal: {
    labels: { privacy: "Privacy", cookies: "Cookies", terms: "Voorwaarden" },
    titles: { privacy: "Privacybeleid", cookies: "Cookiebeleid", terms: "Gebruiksvoorwaarden" },
    onThisPage: "Op deze pagina",
    updated: (date) => `Laatst bijgewerkt op ${date}.`,
    seeAlso: "Zie ook",
    inEnglish: "Deze tekst is voorlopig alleen in het Engels beschikbaar. De Engelse tekst geldt.",
  },
};

const FR: SiteText = {
  title: "ASafariM OS : le système d’exploitation auquel les applications se branchent",
  description:
    "ASafariM OS est une plateforme de base à laquelle les applications se branchent. Chaque application reçoit de l’OS la connexion, les autorisations, le routage, les événements, le cycle de vie et la surveillance, au lieu de les construire elle-même.",
  months: ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."],
  nav: {
    main: "Menu principal",
    open: "Ouvrir le menu",
    apps: "Applications",
    workspace: "Votre espace de travail",
    workspaceLead: "Outils connectés à ASafariM OS",
    docs: "Guides et votre espace de travail",
    flow: "Automatiser le travail avec des workflows",
    breinhapWeb: "Site web ; les missions dans le navigateur arrivent plus tard",
    breinhapManagement: "Espace de travail pour les adultes invités",
    appsFoot: "Une seule connexion. Un espace de travail connecté.",
    everyApp: "Toutes les applications",
    products: "Produits",
    moreFrom: "Plus d’ASafariM",
    explore: "Découvrez nos produits",
    breinhap: "De courtes missions d’étude pour le secondaire",
    igs: "Pharmacie en ligne belge, avec un pharmacien",
    productsFoot: "Webshop, application Android et statut",
    platform: "Plateforme",
    signIn: "Se connecter",
  },
  access: (signIn, docs, flow) =>
    `Vous avez accès ? ${signIn}, puis ouvrez ${docs} ou
        ${flow}, si votre compte y a accès.
        Pas encore d’accès ? Connectez-vous avec votre adresse e-mail et choisissez <em>Request connection</em> : un administrateur l’approuve.`,
  badge: (date) => `En développement · mis à jour le ${date}`,
  lead: "Une plateforme de base : un système d’exploitation auquel les applications se branchent. Chaque application profite des avantages de l’OS sans les construire elle-même.",
  benefitsLabel: "Ce que chaque application reçoit de l’OS",
  benefits: ["Connexion", "Autorisations", "Routage", "Événements", "Cycle de vie", "Surveillance"],
  note: "ASafariM OS est un nouveau système avec ses propres applications. Ce n’est pas une migration de la plateforme asafarim.com, qui continue de fonctionner telle quelle.",
  linksLabel: "Liens",
  apps: {
    title: "Applications",
    lead: "Ce qui tourne sur ASafariM OS, et les produits construits à côté : où trouver chacun, et où il en est.",
    os: "Intégrées à l’OS",
    products: "Produits créés par ASafariM",
    productsLead:
      "Avec leur propre code et leurs propres domaines, dans le style de l’OS ; leurs pages de projet sont servies par l’OS.",
    whereToFind: (name) => `Où trouver ${name}`,
  },
  status: {
    live: "En ligne",
    "early-access": "Accès anticipé",
    testing: "En test",
    "in-development": "En développement",
    "staff-only": "Personnel uniquement",
  },
  shipped: {
    title: "Livré",
    lead: "Ce qui est construit et fusionné jusqu’ici, phase par phase.",
    prs: "Pull requests fusionnées :",
    inEnglish: "Cette liste est un journal des modifications du code, en anglais.",
  },
  screenshots: {
    title: "Captures d’écran",
    lead: "Prises par Playwright dans l’environnement de test de bout en bout, pas dessinées à la main.",
  },
  roadmap: { title: "Feuille de route" },
  footer: { website: "Site web", source: "Code source sur GitHub" },
  legal: {
    labels: { privacy: "Confidentialité", cookies: "Cookies", terms: "Conditions" },
    titles: {
      privacy: "Politique de confidentialité",
      cookies: "Politique en matière de cookies",
      terms: "Conditions d’utilisation",
    },
    onThisPage: "Sur cette page",
    updated: (date) => `Dernière mise à jour le ${date}.`,
    seeAlso: "Voir aussi",
    inEnglish: "Ce texte n’est pour l’instant disponible qu’en anglais. La version anglaise fait foi.",
  },
};

const DE: SiteText = {
  title: "ASafariM OS: das Betriebssystem, an das Apps andocken",
  description:
    "ASafariM OS ist eine Basisplattform, an die Apps andocken. Jede App bekommt Anmeldung, Berechtigungen, Routing, Events, Lebenszyklus und Monitoring vom OS, statt sie selbst zu bauen.",
  months: ["Jan.", "Feb.", "März", "Apr.", "Mai", "Juni", "Juli", "Aug.", "Sept.", "Okt.", "Nov.", "Dez."],
  nav: {
    main: "Hauptmenü",
    open: "Menü öffnen",
    apps: "Apps",
    workspace: "Ihr Arbeitsbereich",
    workspaceLead: "Mit ASafariM OS verbundene Tools",
    docs: "Anleitungen und Ihr Arbeitsbereich",
    flow: "Arbeit mit Workflows automatisieren",
    breinhapWeb: "Website; Missionen im Browser folgen später",
    breinhapManagement: "Arbeitsbereich für eingeladene Erwachsene",
    appsFoot: "Eine Anmeldung. Ein verbundener Arbeitsbereich.",
    everyApp: "Alle Apps",
    products: "Produkte",
    moreFrom: "Mehr von ASafariM",
    explore: "Entdecken Sie unsere Produkte",
    breinhap: "Kurze Lernmissionen für die Sekundarschule",
    igs: "Belgische Online-Apotheke mit Apotheker",
    productsFoot: "Webshop, Android-App und Status",
    platform: "Plattform",
    signIn: "Anmelden",
  },
  access: (signIn, docs, flow) =>
    `Sie haben Zugang? ${signIn} und öffnen Sie dann ${docs} oder
        ${flow}, wenn Ihr Konto Zugang hat.
        Noch kein Zugang? Melden Sie sich mit Ihrer E-Mail-Adresse an und wählen Sie <em>Request connection</em>: Ein Administrator genehmigt es.`,
  badge: (date) => `In Entwicklung · aktualisiert am ${date}`,
  lead: "Eine Basisplattform: ein Betriebssystem, an das Apps andocken. Jede App bekommt die Vorteile des OS, ohne sie selbst zu bauen.",
  benefitsLabel: "Was jede App vom OS bekommt",
  benefits: ["Anmeldung", "Berechtigungen", "Routing", "Events", "Lebenszyklus", "Monitoring"],
  note: "ASafariM OS ist ein neues System mit eigenen Apps. Es ist keine Migration der Plattform asafarim.com, die unverändert weiterläuft.",
  linksLabel: "Links",
  apps: {
    title: "Apps",
    lead: "Was auf ASafariM OS läuft, und die Produkte, die daneben entstehen: wo Sie jedes finden und wie weit es ist.",
    os: "Im OS enthalten",
    products: "Produkte von ASafariM",
    productsLead:
      "Mit eigenem Code und eigenen Domains, im Stil des OS; ihre Projektseiten werden vom OS ausgeliefert.",
    whereToFind: (name) => `Wo Sie ${name} finden`,
  },
  status: {
    live: "Live",
    "early-access": "Früher Zugang",
    testing: "Im Test",
    "in-development": "In Entwicklung",
    "staff-only": "Nur Personal",
  },
  shipped: {
    title: "Ausgeliefert",
    lead: "Was bisher gebaut und zusammengeführt ist, Phase für Phase.",
    prs: "Zusammengeführte Pull Requests:",
    inEnglish: "Diese Liste ist ein Änderungsprotokoll des Codes und auf Englisch.",
  },
  screenshots: {
    title: "Screenshots",
    lead: "Von Playwright in der End-to-End-Testumgebung aufgenommen, nicht von Hand gezeichnet.",
  },
  roadmap: { title: "Roadmap" },
  footer: { website: "Website", source: "Quellcode auf GitHub" },
  legal: {
    labels: { privacy: "Datenschutz", cookies: "Cookies", terms: "Nutzungsbedingungen" },
    titles: { privacy: "Datenschutzerklärung", cookies: "Cookie-Richtlinie", terms: "Nutzungsbedingungen" },
    onThisPage: "Auf dieser Seite",
    updated: (date) => `Zuletzt aktualisiert am ${date}.`,
    seeAlso: "Siehe auch",
    inEnglish: "Dieser Text ist vorerst nur auf Englisch verfügbar. Es gilt die englische Fassung.",
  },
};

export const TEXT: Readonly<Record<Locale, SiteText>> = { en: EN, nl: NL, fr: FR, de: DE };
