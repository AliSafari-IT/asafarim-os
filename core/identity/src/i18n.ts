/**
 * id.asafarim.site in English, Dutch, French and German (@asafarim/locale's languages, one choice across
 * *.asafarim.site). Each request runs with its language (the URL's ?lang=, then the asafarim-locale cookie,
 * then the browser's, then English) in an AsyncLocalStorage, so every page, message and code e-mail built
 * while handling it reads `msg()` without the language being passed around.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { type Locale, DEFAULT_LOCALE, LOCALES, localeCookie, negotiateLocale, parseLocale } from "@asafarim/locale";

export type { Locale };
export { LOCALES };

interface RequestLocale {
  locale: Locale;
  /** The GET URL of the page being shown, in another language (for the selector's links). */
  href: (locale: Locale) => string;
}

const store = new AsyncLocalStorage<RequestLocale>();

/** The current request's language (English outside a request). */
export const currentLocale = (): Locale => store.getStore()?.locale ?? DEFAULT_LOCALE;

/** The current request's words. */
export const msg = (): Messages => MESSAGES[currentLocale()];

/** The words of one language (an e-mail to someone who chose it earlier). */
export const messagesFor = (locale: string | null | undefined): Messages =>
  MESSAGES[parseLocale(locale) ?? DEFAULT_LOCALE];

/** Where the current page is in `locale`: the same GET path with ?lang= (a POST's page maps to its GET page). */
export const hrefFor = (locale: Locale): string => store.getStore()?.href(locale) ?? `/?lang=${locale}`;

/** A form POST shows the page of a GET route: the selector links there. */
function pagePathOf(method: string, path: string): string {
  if (method === "GET") return path;
  if (path === "/login/start" || path === "/login/resend" || path === "/login/verify") return "/login/code";
  if (path.startsWith("/account")) return "/account";
  if (path.startsWith("/admin")) return "/admin";
  if (path.startsWith("/interaction/")) return path.replace(/\/(login|confirm|abort)$/, "");
  return "/login";
}

export interface LocaleRequest {
  method: string;
  path: string;
  /** The raw query string, without "?". */
  querystring: string;
  get(field: string): string;
}

/**
 * Runs `next` with the request's language. When the URL chose one (?lang=), `remember` gets the Set-Cookie
 * value that keeps it for every *.asafarim.site host (`issuerHost` gives the parent domain).
 */
export function withRequestLocale<T>(
  req: LocaleRequest,
  issuerHost: string,
  remember: (setCookie: string) => void,
  next: () => Promise<T>,
): Promise<T> {
  const params = new URLSearchParams(req.querystring);
  const { locale, source } = negotiateLocale({
    query: params.get("lang"),
    cookieHeader: req.get("cookie"),
    acceptLanguage: req.get("accept-language"),
  });
  if (source === "query") remember(localeCookie(locale, issuerHost));
  const path = pagePathOf(req.method, req.path);
  const keep = req.method === "GET" ? params : new URLSearchParams();
  const href = (l: Locale) => {
    const q = new URLSearchParams(keep);
    q.set("lang", l);
    return `${path}?${q.toString()}`;
  };
  return store.run({ locale, href }, next);
}

/** Runs `fn` as if a request in `locale` (tests, and anything built outside a request). */
export const inLocale = <T>(locale: Locale, fn: () => T): T => store.run({ locale, href: (l) => `/?lang=${l}` }, fn);

/** The site's pages in a language: asafarim.site/privacy, asafarim.site/nl/privacy, …. */
export const sitePage = (locale: Locale, page = "") =>
  `https://asafarim.site/${locale === "en" ? "" : `${locale}/`}${page}`;

/** ASafariM's products in a language, where their sites have it. */
export const productHref = (product: "breinhap" | "igs", locale: Locale) =>
  product === "igs"
    ? `https://igs.asafarim.site/${locale}/`
    : locale === "nl"
      ? "https://breinhap.asafarim.site/"
      : "https://breinhap.asafarim.site/en/";

export interface Messages {
  common: {
    home: string;
    signOut: string;
    continue: string;
    tagline: string;
    legal: { privacy: string; cookies: string; terms: string };
    products: { breinhap: string; igs: string };
    goHome: string;
  };
  errors: {
    title: string;
    again: string;
    unprocessable: string;
    linkExpired: string;
    linkMismatch: string;
    expired: string;
    noAssertion: string;
    unverified: string;
    inactive: string;
    browser: string;
  };
  logout: { title: string; heading: string; text: string; confirm: string; stay: string };
  signedOut: { title: string; heading: string; text: string; again: string };
  signingIn: { title: string; heading: string; text: string };
  signedIn: { title: string; heading: string; text: string };
  login: {
    title: string;
    google: string;
    passkey: string;
    email: string;
    emailPlaceholder: string;
    emailSubmit: string;
    mobile: string;
    smsSubmit: string;
    useMobile: string;
    or: string;
    ways: { google: string; passkey: string; email: string; sms: string };
    /** "a", "a or b", "a, b or c". */
    listOr: (items: string[]) => string;
    eyebrow: string;
    howTitle: string;
    steps: readonly [title: string, text: (ways: string) => string][];
    onlyProves: string;
    continueTo: (app: string) => string;
    signInTo: (app: string) => string;
    appLead: (app: string) => string;
    welcome: string;
    /** HTML: the terms and privacy links filled in. */
    fine: (terms: string, privacy: string) => string;
  };
  code: {
    title: string;
    checkEmail: string;
    checkPhone: string;
    /** HTML: `masked` is already escaped. */
    sent: (via: "email" | "sms", masked: string, minutes: number) => string;
    label: string;
    verify: string;
    resend: string;
    another: string;
    spam: string;
  };
  nav: { account: string; connections: string; adminConsole: string; main: string };
  next: { title: string; os: string; osText: string; appsConnected: string; appsNotConnected: string; more: string };
  request: {
    which: string;
    note: string;
    optional: string;
    placeholder: string;
    waiting: string;
    sent: string;
    apps: string;
    justAccount: string;
    update: string;
    send: string;
  };
  account: {
    title: string;
    added: string;
    lastUsed: string;
    remove: string;
    noPasskeys: string;
    connected: string;
    waitingApproval: string;
    notConnected: string;
    accessRequest: string;
    changeRequest: string;
    needAnother: string;
    access: string;
    notConnectedText: string;
    seeRequest: string;
    ask: string;
    accountId: string;
    copy: string;
    copied: string;
    copyFailed: string;
    idHint: string;
    howSignIn: string;
    methodsLabel: string;
    methods: { google: string; email: string; phone: string; passkey: string };
    passkeys: string;
    passkeyHint: string;
    addPasskey: string;
    passkeyWaiting: string;
    passkeyCancelled: string;
    passkeyFailed: string;
  };
  progress: { label: string; steps: readonly [string, string, string, string] };
  notConnected: {
    pendingTitle: string;
    justSent: string;
    already: string;
    review: string;
    askTitle: string;
    askText: string;
    /** HTML: `label` is already escaped. */
    signedInAs: (label: string) => string;
  };
  flow: {
    expiredTitle: string;
    expiredText: string;
    startAgain: string;
    tooManyTitle: string;
    tooManyText: string;
    tooManyCodes: (minutes: number) => string;
    cooldown: string;
    googleExpired: string;
    sendFailed: string;
    tooManyCodeTries: string;
    enterCode: (via: "email" | "sms") => string;
    noLongerValid: string;
    wrongCode: (via: "email" | "sms") => string;
    codeExpired: string;
    googleCancelled: string;
    googleFailed: string;
    tryAgain: string;
    tooManyTries: string;
    reload: string;
    passkeyUnusable: string;
    signInFirst: string;
    passkeyNotAdded: string;
    removed: string;
    requested: string;
    unchanged: string;
    signedOutText: string;
    noAccessTitle: string;
    noAccessText: string;
    invalidEmail: string;
    invalidPhone: string;
    smsCountry: string;
    somethingWrong: string;
  };
  admin: {
    title: string;
    lead: string;
    who: string;
    apps: string;
    note: string;
    requested: string;
    status: string;
    granted: string;
    lastSignIn: string;
    when: string;
    event: string;
    details: string;
    approve: string;
    reject: string;
    connectedPill: string;
    noRequests: string;
    revoke: string;
    reconnect: string;
    you: string;
    adminSuffix: string;
    statuses: { active: string; revoked: string };
    noConnections: string;
    nothingYet: string;
    none: string;
    pending: string;
    connected: string;
    revoked: string;
    grantHint: string;
    requestsTitle: string;
    connectTitle: string;
    connectPlaceholder: string;
    connectLabel: string;
    connect: string;
    connectionsTitle: string;
    activity: string;
    enterIdentifier: string;
    notices: Record<"approved" | "rejected" | "revoked" | "reconnected" | "added" | "stale" | "self", string>;
  };
  mail: {
    codeSubject: (code: string) => string;
    codeText: (code: string, minutes: number, host: string) => string;
    sms: (code: string, minutes: number) => string;
    approvedSubject: string;
    approvedText: (names: string, url: string) => string;
    rejectedSubject: string;
    rejectedText: (names: string, url: string) => string;
  };
}

const orList = (or: string) => (items: string[]) =>
  items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} ${or} ${items[items.length - 1]}`;

const EN: Messages = {
  common: {
    home: "Home",
    signOut: "Sign out",
    continue: "Continue",
    tagline: "sign-in and accounts for ASafariM apps",
    legal: { privacy: "Privacy", cookies: "Cookies", terms: "Terms" },
    products: {
      breinhap: "Study app for Flemish students (Android).",
      igs: "Online pharmacy for Belgium, and its Android app.",
    },
    goHome: "Go to ASafariM OS home",
  },
  errors: {
    title: "Sign-in didn't complete",
    again: "Go back to the app and start signing in again.",
    unprocessable: "The sign-in request couldn't be processed.",
    linkExpired: "This sign-in link has expired.",
    linkMismatch: "This sign-in link doesn't match your session.",
    expired: "This sign-in has expired.",
    noAssertion: "Hub didn't send a sign-in assertion.",
    unverified: "Your sign-in couldn't be verified.",
    inactive: "This account can't sign in.",
    browser: "This sign-in can't be completed in this browser.",
  },
  logout: {
    title: "Sign out",
    heading: "Sign out of ASafariM?",
    text: "This signs you out of your ASafariM account on this device, so the next sign-in asks who you are. Apps you already opened keep their own session until you sign out there.",
    confirm: "Sign out",
    stay: "Stay signed in",
  },
  signedOut: {
    title: "Signed out",
    heading: "You're signed out",
    text: "You can close this tab, or carry on to the ASafariM OS home page.",
    again: "Sign in again",
  },
  signingIn: { title: "Signing you in", heading: "Signing you in…", text: "Taking you back to the app." },
  signedIn: { title: "Signed in", heading: "You're signed in", text: "Taking you on…" },
  login: {
    title: "Sign in",
    google: "Continue with Google",
    passkey: "Sign in with a passkey",
    email: "Email address",
    emailPlaceholder: "you@example.com",
    emailSubmit: "Email me a sign-in code",
    mobile: "Mobile number",
    smsSubmit: "Text me a code",
    useMobile: "Use a mobile number instead",
    or: "or get a one-time code",
    ways: { google: "Google", passkey: "a passkey", email: "a code by email", sms: "a code by SMS" },
    listOr: orList("or"),
    eyebrow: "Your ASafariM account",
    howTitle: "One sign-in for every ASafariM app",
    steps: [
      ["Sign in", (ways) => `With ${ways}. The first time creates your account.`],
      ["Ask for access", () => "Pick the apps you need and tell the admin why."],
      ["An admin approves", () => "You get an email, and your apps open with this same sign-in."],
    ],
    onlyProves: "Signing in only proves who you are. No app opens until an administrator gives you access.",
    continueTo: (app) => `Continue to ${app}`,
    signInTo: (app) => `Sign in to ${app}`,
    appLead: (app) => `${app} uses your ASafariM account. New here? Signing in creates your account.`,
    welcome: "Welcome to ASafariM. New here? Signing in creates your account.",
    fine: (terms, privacy) =>
      `By continuing you accept the <a href="${terms}">terms</a> and the\n<a href="${privacy}">privacy notice</a>.`,
  },
  code: {
    title: "Enter your code",
    checkEmail: "Check your email",
    checkPhone: "Check your phone",
    sent: (via, masked, minutes) =>
      `If ${via === "email" ? "this address" : "this number"} can sign in, ${via === "email" ? "an email" : "an SMS"} with a 6-digit code is on its way to <strong>${masked}</strong>. It expires in ${minutes} minutes.`,
    label: "Sign-in code",
    verify: "Verify and sign in",
    resend: "Send a new code",
    another: "Use another way",
    spam: "No email? Check your spam folder. Codes come from ASafariM and are never asked for by anyone.",
  },
  nav: { account: "Account", connections: "Connections", adminConsole: "Admin console", main: "Main" },
  next: {
    title: "Where to next",
    os: "ASafariM OS",
    osText: "The home page: what the OS is, and what's new.",
    appsConnected: "An app opens once an admin has given your account access to it.",
    appsNotConnected: "Apps open once your account is connected and an admin has given it access.",
    more: "More from ASafariM",
  },
  request: {
    which: "Which apps do you need?",
    note: "Anything the admin should know?",
    optional: "(optional)",
    placeholder: "For example: I'm on the IGS-Pharma team and need Docs.",
    waiting: "Waiting for an admin",
    sent: "sent",
    apps: "Apps:",
    justAccount: "Just an account",
    update: "Update request",
    send: "Send request",
  },
  account: {
    title: "Your account",
    added: "Added",
    lastUsed: "Last used",
    remove: "Remove",
    noPasskeys: "No passkeys yet.",
    connected: "Connected",
    waitingApproval: "Waiting for approval",
    notConnected: "Not connected yet",
    accessRequest: "Access request",
    changeRequest: "Add apps or change your note",
    needAnother: "Need another app? Ask for access",
    access: "Access",
    notConnectedText: "Your account isn't connected yet. Ask an administrator for access to start using ASafariM apps.",
    seeRequest: "See or change your request",
    ask: "Ask for access",
    accountId: "Account id:",
    copy: "Copy account ID",
    copied: "Account ID copied.",
    copyFailed: "Could not copy. The account ID is selected; copy it manually.",
    idHint: "An admin uses your account ID to give you access to an app.",
    howSignIn: "How you sign in",
    methodsLabel: "Sign-in methods",
    methods: { google: "Google", email: "Email code", phone: "SMS code", passkey: "Passkey" },
    passkeys: "Passkeys",
    passkeyHint: "A passkey lets you sign in with your fingerprint, face or device PIN instead of a code.",
    addPasskey: "Add a passkey",
    passkeyWaiting: "Waiting for your passkey…",
    passkeyCancelled: "Cancelled.",
    passkeyFailed: "That didn't work.",
  },
  progress: { label: "Your progress", steps: ["Signed in", "Ask for access", "Admin review", "Open your apps"] },
  notConnected: {
    pendingTitle: "Request pending",
    justSent: "Your request has been sent.",
    already: "You've already asked for access.",
    review: "An administrator will review it, and you'll get an email when it's decided. Then sign in again.",
    askTitle: "Ask for access",
    askText:
      "You're signed in, but your account isn't connected to ASafariM yet. Tell an administrator what you need: they'll review it and you'll get an email.",
    signedInAs: (label) => `Signed in as <strong>${label}</strong>`,
  },
  flow: {
    expiredTitle: "This page has expired",
    expiredText: "For your security, sign-in pages are only valid for a short time.",
    startAgain: "Start again",
    tooManyTitle: "Too many attempts",
    tooManyText: "Please wait a while before trying to sign in again.",
    tooManyCodes: (m) => `Too many codes were requested. Try again in ${m} minute${m === 1 ? "" : "s"}.`,
    cooldown: "A code was just sent. Wait a minute before asking for another one.",
    googleExpired: "That Google sign-in has expired. Please try again.",
    sendFailed: "We couldn't send a code right now. Please try again in a few minutes.",
    tooManyCodeTries: "Too many tries. Wait a while, then ask for a new code.",
    enterCode: (via) => `Enter the 6-digit code from ${via === "email" ? "the email" : "the SMS"}.`,
    noLongerValid: "This code is no longer valid. Send a new code.",
    wrongCode: (via) => `That code isn't right. Check ${via === "email" ? "the email" : "the SMS"} and try again.`,
    codeExpired: "This code has expired or had too many wrong tries. Send a new code.",
    googleCancelled: "Google sign-in was cancelled. Try again, or use another way.",
    googleFailed: "Google couldn't sign you in. Try again, or use another way.",
    tryAgain: "Something went wrong while signing you in. Please try again.",
    tooManyTries: "Too many tries. Wait a while and try again.",
    reload: "This page has expired. Reload it.",
    passkeyUnusable: "That passkey couldn't be used here. Try again, or use a code.",
    signInFirst: "Sign in first.",
    passkeyNotAdded: "That passkey couldn't be added. Try again.",
    removed: "Passkey removed.",
    requested: "Request sent. An administrator will review it, and you'll get an email.",
    unchanged: "Your request already has those apps.",
    signedOutText:
      "You're signed out of your ASafariM account on this device, so the next sign-in asks who you are. Apps you already opened keep their own session until you sign out there.",
    noAccessTitle: "No access",
    noAccessText: "This page is for ASafariM administrators.",
    invalidEmail: "Enter a valid email address.",
    invalidPhone: "Enter your full mobile number with its country code, for example +32 470 12 34 56.",
    smsCountry: "Sign-in by SMS isn't available for numbers in this country.",
    somethingWrong: "Something went wrong.",
  },
  admin: {
    title: "Connections",
    lead: "Who may sign in to ASafariM apps. Approving connects an account; what each person may do inside an app is a role you grant in the Admin console.",
    who: "Who",
    apps: "Apps",
    note: "Note",
    requested: "Requested",
    status: "Status",
    granted: "Granted",
    lastSignIn: "Last sign-in",
    when: "When",
    event: "Event",
    details: "Details",
    approve: "Approve",
    reject: "Reject",
    connectedPill: "connected",
    noRequests: "No pending requests. You're all caught up.",
    revoke: "Revoke",
    reconnect: "Reconnect",
    you: "you",
    adminSuffix: "(admin)",
    statuses: { active: "active", revoked: "revoked" },
    noConnections: "No connections.",
    nothingYet: "Nothing yet.",
    none: "none",
    pending: "pending",
    connected: "connected",
    revoked: "revoked",
    grantHint: "Give them roles for their apps in the Admin console",
    requestsTitle: "Access requests",
    connectTitle: "Connect someone",
    connectPlaceholder: "email or +32 470 12 34 56",
    connectLabel: "Email address or mobile number",
    connect: "Connect",
    connectionsTitle: "Connections",
    activity: "Recent activity",
    enterIdentifier: "Enter an email address, or a mobile number with its country code (+32 …).",
    notices: {
      approved: "Request approved: they're now connected, and they've been emailed.",
      rejected: "Request rejected. They've been emailed.",
      revoked: "Connection revoked. Their sign-in sessions have ended.",
      reconnected: "Reconnected.",
      added: "Connected.",
      stale: "That request or connection had already changed. Nothing was done.",
      self: "You can't revoke your own connection.",
    },
  },
  mail: {
    codeSubject: (code) => `Your ASafariM sign-in code: ${code}`,
    codeText: (code, minutes, host) =>
      `Your ASafariM sign-in code is ${code}.\n\nIt expires in ${minutes} minutes and works once. Never share it with anyone: ASafariM will never ask you for it.\n\nIf you didn't try to sign in at ${host}, you can ignore this email.\n`,
    sms: (code, minutes) =>
      `Your ASafariM sign-in code is ${code}. It expires in ${minutes} minutes. Never share it with anyone.`,
    approvedSubject: "ASafariM: your access request was approved",
    approvedText: (names, url) =>
      `Good news: an administrator approved your access request${names ? ` for ${names}` : ""}.\n\nSign in at ${url}/account to see your apps. If an app still says you have no access, its roles are being set up: try again a little later.\n`,
    rejectedSubject: "ASafariM: your access request",
    rejectedText: (names, url) =>
      `An administrator didn't approve your access request${names ? ` for ${names}` : ""}.\n\nIf you think this is a mistake, sign in at ${url}/login and send a new request with a note.\n`,
  },
};

const NL: Messages = {
  common: {
    home: "Home",
    signOut: "Afmelden",
    continue: "Verder",
    tagline: "aanmelden en accounts voor ASafariM-apps",
    legal: { privacy: "Privacy", cookies: "Cookies", terms: "Voorwaarden" },
    products: {
      breinhap: "Studie-app voor Vlaamse leerlingen (Android).",
      igs: "Onlineapotheek voor België, en de Android-app.",
    },
    goHome: "Naar de startpagina van ASafariM OS",
  },
  errors: {
    title: "Aanmelden is niet gelukt",
    again: "Ga terug naar de app en begin opnieuw met aanmelden.",
    unprocessable: "Het aanmeldverzoek kon niet worden verwerkt.",
    linkExpired: "Deze aanmeldlink is verlopen.",
    linkMismatch: "Deze aanmeldlink hoort niet bij je sessie.",
    expired: "Deze aanmelding is verlopen.",
    noAssertion: "Hub heeft geen aanmeldbewijs gestuurd.",
    unverified: "Je aanmelding kon niet worden gecontroleerd.",
    inactive: "Dit account kan zich niet aanmelden.",
    browser: "Deze aanmelding kan niet in deze browser worden afgerond.",
  },
  logout: {
    title: "Afmelden",
    heading: "Afmelden bij ASafariM?",
    text: "Hiermee meld je je op dit toestel af bij je ASafariM-account, zodat de volgende aanmelding weer vraagt wie je bent. Apps die je al opende, houden hun eigen sessie tot je je daar afmeldt.",
    confirm: "Afmelden",
    stay: "Aangemeld blijven",
  },
  signedOut: {
    title: "Afgemeld",
    heading: "Je bent afgemeld",
    text: "Je kunt dit tabblad sluiten, of verdergaan naar de startpagina van ASafariM OS.",
    again: "Opnieuw aanmelden",
  },
  signingIn: { title: "Je wordt aangemeld", heading: "Je wordt aangemeld…", text: "We brengen je terug naar de app." },
  signedIn: { title: "Aangemeld", heading: "Je bent aangemeld", text: "We brengen je verder…" },
  login: {
    title: "Aanmelden",
    google: "Doorgaan met Google",
    passkey: "Aanmelden met een passkey",
    email: "E-mailadres",
    emailPlaceholder: "jij@voorbeeld.be",
    emailSubmit: "Mail me een aanmeldcode",
    mobile: "Gsm-nummer",
    smsSubmit: "Sms me een code",
    useMobile: "Liever met je gsm-nummer",
    or: "of krijg een eenmalige code",
    ways: { google: "Google", passkey: "een passkey", email: "een code per e-mail", sms: "een code per sms" },
    listOr: orList("of"),
    eyebrow: "Je ASafariM-account",
    howTitle: "Eén aanmelding voor elke ASafariM-app",
    steps: [
      ["Meld je aan", (ways) => `Met ${ways}. De eerste keer maakt je account aan.`],
      ["Vraag toegang", () => "Kies de apps die je nodig hebt en vertel de beheerder waarom."],
      ["Een beheerder keurt goed", () => "Je krijgt een e-mail, en je apps openen met dezelfde aanmelding."],
    ],
    onlyProves: "Aanmelden bewijst alleen wie je bent. Geen enkele app opent tot een beheerder je toegang geeft.",
    continueTo: (app) => `Verder naar ${app}`,
    signInTo: (app) => `Aanmelden bij ${app}`,
    appLead: (app) => `${app} gebruikt je ASafariM-account. Nieuw hier? Door je aan te melden maak je je account aan.`,
    welcome: "Welkom bij ASafariM. Nieuw hier? Door je aan te melden maak je je account aan.",
    fine: (terms, privacy) =>
      `Door verder te gaan aanvaard je de <a href="${terms}">voorwaarden</a> en de\n<a href="${privacy}">privacyverklaring</a>.`,
  },
  code: {
    title: "Voer je code in",
    checkEmail: "Kijk in je mailbox",
    checkPhone: "Kijk op je gsm",
    sent: (via, masked, minutes) =>
      `Als ${via === "email" ? "dit adres" : "dit nummer"} zich kan aanmelden, is ${via === "email" ? "een e-mail" : "een sms"} met een code van 6 cijfers onderweg naar <strong>${masked}</strong>. De code vervalt na ${minutes} minuten.`,
    label: "Aanmeldcode",
    verify: "Controleren en aanmelden",
    resend: "Stuur een nieuwe code",
    another: "Op een andere manier",
    spam: "Geen e-mail? Kijk in je spammap. Codes komen van ASafariM en niemand zal er ooit om vragen.",
  },
  nav: { account: "Account", connections: "Verbindingen", adminConsole: "Beheerconsole", main: "Hoofdmenu" },
  next: {
    title: "Waar naartoe?",
    os: "ASafariM OS",
    osText: "De startpagina: wat het OS is, en wat er nieuw is.",
    appsConnected: "Een app opent zodra een beheerder je account er toegang toe gaf.",
    appsNotConnected: "Apps openen zodra je account verbonden is en een beheerder je toegang gaf.",
    more: "Meer van ASafariM",
  },
  request: {
    which: "Welke apps heb je nodig?",
    note: "Moet de beheerder nog iets weten?",
    optional: "(optioneel)",
    placeholder: "Bijvoorbeeld: ik zit in het IGS-Pharma-team en heb Docs nodig.",
    waiting: "Wacht op een beheerder",
    sent: "verstuurd",
    apps: "Apps:",
    justAccount: "Alleen een account",
    update: "Aanvraag bijwerken",
    send: "Aanvraag versturen",
  },
  account: {
    title: "Je account",
    added: "Toegevoegd",
    lastUsed: "Laatst gebruikt",
    remove: "Verwijderen",
    noPasskeys: "Nog geen passkeys.",
    connected: "Verbonden",
    waitingApproval: "Wacht op goedkeuring",
    notConnected: "Nog niet verbonden",
    accessRequest: "Toegangsaanvraag",
    changeRequest: "Apps toevoegen of je toelichting wijzigen",
    needAnother: "Nog een app nodig? Vraag toegang",
    access: "Toegang",
    notConnectedText:
      "Je account is nog niet verbonden. Vraag een beheerder om toegang om ASafariM-apps te kunnen gebruiken.",
    seeRequest: "Je aanvraag bekijken of wijzigen",
    ask: "Toegang vragen",
    accountId: "Account-id:",
    copy: "Account-id kopiëren",
    copied: "Account-id gekopieerd.",
    copyFailed: "Kopiëren lukte niet. De account-id is geselecteerd; kopieer hem zelf.",
    idHint: "Een beheerder gebruikt je account-id om je toegang tot een app te geven.",
    howSignIn: "Hoe je je aanmeldt",
    methodsLabel: "Aanmeldmethoden",
    methods: { google: "Google", email: "E-mailcode", phone: "Sms-code", passkey: "Passkey" },
    passkeys: "Passkeys",
    passkeyHint:
      "Met een passkey meld je je aan met je vingerafdruk, gezicht of de pincode van je toestel, in plaats van met een code.",
    addPasskey: "Passkey toevoegen",
    passkeyWaiting: "Wachten op je passkey…",
    passkeyCancelled: "Geannuleerd.",
    passkeyFailed: "Dat lukte niet.",
  },
  progress: {
    label: "Je voortgang",
    steps: ["Aangemeld", "Toegang vragen", "Beoordeling", "Je apps openen"],
  },
  notConnected: {
    pendingTitle: "Aanvraag in behandeling",
    justSent: "Je aanvraag is verstuurd.",
    already: "Je hebt al toegang gevraagd.",
    review: "Een beheerder bekijkt ze, en je krijgt een e-mail zodra er beslist is. Meld je dan opnieuw aan.",
    askTitle: "Toegang vragen",
    askText:
      "Je bent aangemeld, maar je account is nog niet verbonden met ASafariM. Vertel een beheerder wat je nodig hebt: die bekijkt het en je krijgt een e-mail.",
    signedInAs: (label) => `Aangemeld als <strong>${label}</strong>`,
  },
  flow: {
    expiredTitle: "Deze pagina is verlopen",
    expiredText: "Voor je veiligheid zijn aanmeldpagina's maar kort geldig.",
    startAgain: "Opnieuw beginnen",
    tooManyTitle: "Te veel pogingen",
    tooManyText: "Wacht even voor je opnieuw probeert aan te melden.",
    tooManyCodes: (m) =>
      `Er zijn te veel codes gevraagd. Probeer het over ${m} ${m === 1 ? "minuut" : "minuten"} opnieuw.`,
    cooldown: "Er is net een code verstuurd. Wacht een minuut voor je een nieuwe vraagt.",
    googleExpired: "Die aanmelding met Google is verlopen. Probeer opnieuw.",
    sendFailed: "We konden nu geen code sturen. Probeer het over een paar minuten opnieuw.",
    tooManyCodeTries: "Te veel pogingen. Wacht even en vraag dan een nieuwe code.",
    enterCode: (via) => `Vul de code van 6 cijfers uit ${via === "email" ? "de e-mail" : "de sms"} in.`,
    noLongerValid: "Deze code is niet meer geldig. Stuur een nieuwe code.",
    wrongCode: (via) => `Die code klopt niet. Kijk ${via === "email" ? "de e-mail" : "de sms"} na en probeer opnieuw.`,
    codeExpired: "Deze code is verlopen of te vaak fout ingevuld. Stuur een nieuwe code.",
    googleCancelled: "Aanmelden met Google is geannuleerd. Probeer opnieuw, of op een andere manier.",
    googleFailed: "Google kon je niet aanmelden. Probeer opnieuw, of op een andere manier.",
    tryAgain: "Er ging iets mis bij het aanmelden. Probeer het opnieuw.",
    tooManyTries: "Te veel pogingen. Wacht even en probeer opnieuw.",
    reload: "Deze pagina is verlopen. Laad ze opnieuw.",
    passkeyUnusable: "Die passkey kan hier niet gebruikt worden. Probeer opnieuw, of gebruik een code.",
    signInFirst: "Meld je eerst aan.",
    passkeyNotAdded: "Die passkey kon niet worden toegevoegd. Probeer opnieuw.",
    removed: "Passkey verwijderd.",
    requested: "Aanvraag verstuurd. Een beheerder bekijkt ze, en je krijgt een e-mail.",
    unchanged: "Je aanvraag bevat die apps al.",
    signedOutText:
      "Je bent op dit toestel afgemeld bij je ASafariM-account, zodat de volgende aanmelding weer vraagt wie je bent. Apps die je al opende, houden hun eigen sessie tot je je daar afmeldt.",
    noAccessTitle: "Geen toegang",
    noAccessText: "Deze pagina is voor beheerders van ASafariM.",
    invalidEmail: "Vul een geldig e-mailadres in.",
    invalidPhone: "Vul je volledige gsm-nummer met landcode in, bijvoorbeeld +32 470 12 34 56.",
    smsCountry: "Aanmelden per sms is niet beschikbaar voor nummers uit dit land.",
    somethingWrong: "Er ging iets mis.",
  },
  admin: {
    title: "Verbindingen",
    lead: "Wie zich mag aanmelden bij ASafariM-apps. Goedkeuren verbindt een account; wat iemand in een app mag doen, is een rol die je in de beheerconsole toekent.",
    who: "Wie",
    apps: "Apps",
    note: "Toelichting",
    requested: "Aangevraagd",
    status: "Status",
    granted: "Toegekend",
    lastSignIn: "Laatst aangemeld",
    when: "Wanneer",
    event: "Gebeurtenis",
    details: "Details",
    approve: "Goedkeuren",
    reject: "Weigeren",
    connectedPill: "verbonden",
    noRequests: "Geen openstaande aanvragen. Alles is bij.",
    revoke: "Intrekken",
    reconnect: "Opnieuw verbinden",
    you: "jij",
    adminSuffix: "(beheerder)",
    statuses: { active: "actief", revoked: "ingetrokken" },
    noConnections: "Geen verbindingen.",
    nothingYet: "Nog niets.",
    none: "geen",
    pending: "openstaand",
    connected: "verbonden",
    revoked: "ingetrokken",
    grantHint: "Geef ze rollen voor hun apps in de beheerconsole",
    requestsTitle: "Toegangsaanvragen",
    connectTitle: "Iemand verbinden",
    connectPlaceholder: "e-mail of +32 470 12 34 56",
    connectLabel: "E-mailadres of gsm-nummer",
    connect: "Verbinden",
    connectionsTitle: "Verbindingen",
    activity: "Recente activiteit",
    enterIdentifier: "Vul een e-mailadres in, of een gsm-nummer met landcode (+32 …).",
    notices: {
      approved: "Aanvraag goedgekeurd: de persoon is nu verbonden en kreeg een e-mail.",
      rejected: "Aanvraag geweigerd. De persoon kreeg een e-mail.",
      revoked: "Verbinding ingetrokken. De aanmeldsessies zijn beëindigd.",
      reconnected: "Opnieuw verbonden.",
      added: "Verbonden.",
      stale: "Die aanvraag of verbinding was al gewijzigd. Er is niets gedaan.",
      self: "Je kunt je eigen verbinding niet intrekken.",
    },
  },
  mail: {
    codeSubject: (code) => `Je aanmeldcode voor ASafariM: ${code}`,
    codeText: (code, minutes, host) =>
      `Je aanmeldcode voor ASafariM is ${code}.\n\nDe code vervalt na ${minutes} minuten en werkt één keer. Geef hem aan niemand: ASafariM zal er nooit om vragen.\n\nProbeerde je niet aan te melden op ${host}? Dan kun je deze e-mail negeren.\n`,
    sms: (code, minutes) =>
      `Je aanmeldcode voor ASafariM is ${code}. Hij vervalt na ${minutes} minuten. Geef hem aan niemand.`,
    approvedSubject: "ASafariM: je toegangsaanvraag is goedgekeurd",
    approvedText: (names, url) =>
      `Goed nieuws: een beheerder heeft je toegangsaanvraag${names ? ` voor ${names}` : ""} goedgekeurd.\n\nMeld je aan op ${url}/account om je apps te zien. Zegt een app nog dat je geen toegang hebt? Dan worden de rollen nog ingesteld: probeer het iets later opnieuw.\n`,
    rejectedSubject: "ASafariM: je toegangsaanvraag",
    rejectedText: (names, url) =>
      `Een beheerder heeft je toegangsaanvraag${names ? ` voor ${names}` : ""} niet goedgekeurd.\n\nDenk je dat dit een vergissing is? Meld je aan op ${url}/login en stuur een nieuwe aanvraag met een toelichting.\n`,
  },
};

const FR: Messages = {
  common: {
    home: "Accueil",
    signOut: "Se déconnecter",
    continue: "Continuer",
    tagline: "connexion et comptes pour les applications ASafariM",
    legal: { privacy: "Confidentialité", cookies: "Cookies", terms: "Conditions" },
    products: {
      breinhap: "Application d’étude pour les élèves flamands (Android).",
      igs: "Pharmacie en ligne pour la Belgique, et son application Android.",
    },
    goHome: "Aller à l’accueil d’ASafariM OS",
  },
  errors: {
    title: "La connexion n’a pas abouti",
    again: "Retournez dans l’application et recommencez la connexion.",
    unprocessable: "La demande de connexion n’a pas pu être traitée.",
    linkExpired: "Ce lien de connexion a expiré.",
    linkMismatch: "Ce lien de connexion ne correspond pas à votre session.",
    expired: "Cette connexion a expiré.",
    noAssertion: "Hub n’a pas envoyé de preuve de connexion.",
    unverified: "Votre connexion n’a pas pu être vérifiée.",
    inactive: "Ce compte ne peut pas se connecter.",
    browser: "Cette connexion ne peut pas être terminée dans ce navigateur.",
  },
  logout: {
    title: "Se déconnecter",
    heading: "Se déconnecter d’ASafariM ?",
    text: "Vous serez déconnecté de votre compte ASafariM sur cet appareil : la prochaine connexion vous redemandera qui vous êtes. Les applications déjà ouvertes gardent leur propre session jusqu’à ce que vous vous y déconnectiez.",
    confirm: "Se déconnecter",
    stay: "Rester connecté",
  },
  signedOut: {
    title: "Déconnecté",
    heading: "Vous êtes déconnecté",
    text: "Vous pouvez fermer cet onglet, ou continuer vers l’accueil d’ASafariM OS.",
    again: "Se reconnecter",
  },
  signingIn: { title: "Connexion en cours", heading: "Connexion en cours…", text: "Retour vers l’application." },
  signedIn: { title: "Connecté", heading: "Vous êtes connecté", text: "Nous vous redirigeons…" },
  login: {
    title: "Se connecter",
    google: "Continuer avec Google",
    passkey: "Se connecter avec une clé d’accès",
    email: "Adresse e-mail",
    emailPlaceholder: "vous@exemple.be",
    emailSubmit: "M’envoyer un code par e-mail",
    mobile: "Numéro de portable",
    smsSubmit: "M’envoyer un code par SMS",
    useMobile: "Utiliser plutôt un numéro de portable",
    or: "ou recevez un code à usage unique",
    ways: { google: "Google", passkey: "une clé d’accès", email: "un code par e-mail", sms: "un code par SMS" },
    listOr: orList("ou"),
    eyebrow: "Votre compte ASafariM",
    howTitle: "Une seule connexion pour toutes les applications ASafariM",
    steps: [
      ["Connectez-vous", (ways) => `Avec ${ways}. La première fois crée votre compte.`],
      [
        "Demandez l’accès",
        () => "Choisissez les applications dont vous avez besoin et dites pourquoi à l’administrateur.",
      ],
      [
        "Un administrateur approuve",
        () => "Vous recevez un e-mail, et vos applications s’ouvrent avec cette même connexion.",
      ],
    ],
    onlyProves:
      "Se connecter prouve seulement qui vous êtes. Aucune application ne s’ouvre avant qu’un administrateur vous donne l’accès.",
    continueTo: (app) => `Continuer vers ${app}`,
    signInTo: (app) => `Se connecter à ${app}`,
    appLead: (app) => `${app} utilise votre compte ASafariM. Vous êtes nouveau ? Vous connecter crée votre compte.`,
    welcome: "Bienvenue sur ASafariM. Vous êtes nouveau ? Vous connecter crée votre compte.",
    fine: (terms, privacy) =>
      `En continuant, vous acceptez les <a href="${terms}">conditions</a> et la\n<a href="${privacy}">politique de confidentialité</a>.`,
  },
  code: {
    title: "Saisissez votre code",
    checkEmail: "Consultez vos e-mails",
    checkPhone: "Consultez votre téléphone",
    sent: (via, masked, minutes) =>
      `Si ${via === "email" ? "cette adresse" : "ce numéro"} peut se connecter, ${via === "email" ? "un e-mail" : "un SMS"} avec un code à 6 chiffres est en route vers <strong>${masked}</strong>. Il expire dans ${minutes} minutes.`,
    label: "Code de connexion",
    verify: "Vérifier et se connecter",
    resend: "Envoyer un nouveau code",
    another: "Utiliser un autre moyen",
    spam: "Pas d’e-mail ? Regardez dans vos spams. Les codes viennent d’ASafariM et personne ne vous les demandera jamais.",
  },
  nav: {
    account: "Compte",
    connections: "Connexions",
    adminConsole: "Console d’administration",
    main: "Menu principal",
  },
  next: {
    title: "Et maintenant ?",
    os: "ASafariM OS",
    osText: "La page d’accueil : ce qu’est l’OS, et les nouveautés.",
    appsConnected: "Une application s’ouvre dès qu’un administrateur a donné l’accès à votre compte.",
    appsNotConnected:
      "Les applications s’ouvrent dès que votre compte est connecté et qu’un administrateur lui a donné l’accès.",
    more: "Plus d’ASafariM",
  },
  request: {
    which: "De quelles applications avez-vous besoin ?",
    note: "L’administrateur doit-il savoir quelque chose ?",
    optional: "(facultatif)",
    placeholder: "Par exemple : je fais partie de l’équipe IGS-Pharma et j’ai besoin de Docs.",
    waiting: "En attente d’un administrateur",
    sent: "envoyée",
    apps: "Applications :",
    justAccount: "Juste un compte",
    update: "Mettre à jour la demande",
    send: "Envoyer la demande",
  },
  account: {
    title: "Votre compte",
    added: "Ajoutée",
    lastUsed: "Dernière utilisation",
    remove: "Supprimer",
    noPasskeys: "Pas encore de clé d’accès.",
    connected: "Connecté",
    waitingApproval: "En attente d’approbation",
    notConnected: "Pas encore connecté",
    accessRequest: "Demande d’accès",
    changeRequest: "Ajouter des applications ou modifier votre message",
    needAnother: "Besoin d’une autre application ? Demandez l’accès",
    access: "Accès",
    notConnectedText:
      "Votre compte n’est pas encore connecté. Demandez l’accès à un administrateur pour commencer à utiliser les applications ASafariM.",
    seeRequest: "Voir ou modifier votre demande",
    ask: "Demander l’accès",
    accountId: "Identifiant du compte :",
    copy: "Copier l’identifiant du compte",
    copied: "Identifiant du compte copié.",
    copyFailed: "La copie a échoué. L’identifiant est sélectionné ; copiez-le vous-même.",
    idHint: "Un administrateur utilise l’identifiant de votre compte pour vous donner accès à une application.",
    howSignIn: "Comment vous vous connectez",
    methodsLabel: "Méthodes de connexion",
    methods: { google: "Google", email: "Code par e-mail", phone: "Code par SMS", passkey: "Clé d’accès" },
    passkeys: "Clés d’accès",
    passkeyHint:
      "Une clé d’accès vous permet de vous connecter avec votre empreinte, votre visage ou le code PIN de votre appareil, au lieu d’un code.",
    addPasskey: "Ajouter une clé d’accès",
    passkeyWaiting: "En attente de votre clé d’accès…",
    passkeyCancelled: "Annulé.",
    passkeyFailed: "Cela n’a pas fonctionné.",
  },
  progress: {
    label: "Votre progression",
    steps: ["Connecté", "Demander l’accès", "Examen", "Ouvrir vos applications"],
  },
  notConnected: {
    pendingTitle: "Demande en attente",
    justSent: "Votre demande a été envoyée.",
    already: "Vous avez déjà demandé l’accès.",
    review:
      "Un administrateur va l’examiner, et vous recevrez un e-mail une fois la décision prise. Reconnectez-vous ensuite.",
    askTitle: "Demander l’accès",
    askText:
      "Vous êtes connecté, mais votre compte n’est pas encore relié à ASafariM. Dites à un administrateur ce dont vous avez besoin : il examinera votre demande et vous recevrez un e-mail.",
    signedInAs: (label) => `Connecté en tant que <strong>${label}</strong>`,
  },
  flow: {
    expiredTitle: "Cette page a expiré",
    expiredText: "Pour votre sécurité, les pages de connexion ne sont valables que peu de temps.",
    startAgain: "Recommencer",
    tooManyTitle: "Trop de tentatives",
    tooManyText: "Patientez un peu avant de réessayer de vous connecter.",
    tooManyCodes: (m) => `Trop de codes ont été demandés. Réessayez dans ${m} minute${m === 1 ? "" : "s"}.`,
    cooldown: "Un code vient d’être envoyé. Attendez une minute avant d’en demander un autre.",
    googleExpired: "Cette connexion avec Google a expiré. Réessayez.",
    sendFailed: "Nous n’avons pas pu envoyer de code pour l’instant. Réessayez dans quelques minutes.",
    tooManyCodeTries: "Trop de tentatives. Patientez un peu, puis demandez un nouveau code.",
    enterCode: (via) => `Saisissez le code à 6 chiffres reçu par ${via === "email" ? "e-mail" : "SMS"}.`,
    noLongerValid: "Ce code n’est plus valable. Envoyez un nouveau code.",
    wrongCode: (via) => `Ce code n’est pas correct. Vérifiez ${via === "email" ? "l’e-mail" : "le SMS"} et réessayez.`,
    codeExpired: "Ce code a expiré ou a reçu trop de tentatives erronées. Envoyez un nouveau code.",
    googleCancelled: "La connexion avec Google a été annulée. Réessayez, ou utilisez un autre moyen.",
    googleFailed: "Google n’a pas pu vous connecter. Réessayez, ou utilisez un autre moyen.",
    tryAgain: "Un problème est survenu lors de la connexion. Veuillez réessayer.",
    tooManyTries: "Trop de tentatives. Patientez un peu et réessayez.",
    reload: "Cette page a expiré. Rechargez-la.",
    passkeyUnusable: "Cette clé d’accès ne peut pas être utilisée ici. Réessayez, ou utilisez un code.",
    signInFirst: "Connectez-vous d’abord.",
    passkeyNotAdded: "Cette clé d’accès n’a pas pu être ajoutée. Réessayez.",
    removed: "Clé d’accès supprimée.",
    requested: "Demande envoyée. Un administrateur va l’examiner, et vous recevrez un e-mail.",
    unchanged: "Votre demande contient déjà ces applications.",
    signedOutText:
      "Vous êtes déconnecté de votre compte ASafariM sur cet appareil : la prochaine connexion vous redemandera qui vous êtes. Les applications déjà ouvertes gardent leur propre session jusqu’à ce que vous vous y déconnectiez.",
    noAccessTitle: "Pas d’accès",
    noAccessText: "Cette page est réservée aux administrateurs d’ASafariM.",
    invalidEmail: "Saisissez une adresse e-mail valide.",
    invalidPhone: "Saisissez votre numéro de portable complet avec l’indicatif du pays, par exemple +32 470 12 34 56.",
    smsCountry: "La connexion par SMS n’est pas disponible pour les numéros de ce pays.",
    somethingWrong: "Une erreur s’est produite.",
  },
  admin: {
    title: "Connexions",
    lead: "Qui peut se connecter aux applications ASafariM. Approuver connecte un compte ; ce que chacun peut faire dans une application est un rôle que vous attribuez dans la console d’administration.",
    who: "Qui",
    apps: "Applications",
    note: "Message",
    requested: "Demandé",
    status: "Statut",
    granted: "Accordé",
    lastSignIn: "Dernière connexion",
    when: "Quand",
    event: "Événement",
    details: "Détails",
    approve: "Approuver",
    reject: "Refuser",
    connectedPill: "connecté",
    noRequests: "Aucune demande en attente. Tout est à jour.",
    revoke: "Révoquer",
    reconnect: "Reconnecter",
    you: "vous",
    adminSuffix: "(admin)",
    statuses: { active: "actif", revoked: "révoqué" },
    noConnections: "Aucune connexion.",
    nothingYet: "Rien pour l’instant.",
    none: "aucun",
    pending: "en attente",
    connected: "connectés",
    revoked: "révoqués",
    grantHint: "Donnez-leur des rôles pour leurs applications dans la console d’administration",
    requestsTitle: "Demandes d’accès",
    connectTitle: "Connecter quelqu’un",
    connectPlaceholder: "e-mail ou +32 470 12 34 56",
    connectLabel: "Adresse e-mail ou numéro de portable",
    connect: "Connecter",
    connectionsTitle: "Connexions",
    activity: "Activité récente",
    enterIdentifier: "Saisissez une adresse e-mail, ou un numéro de portable avec l’indicatif du pays (+32 …).",
    notices: {
      approved: "Demande approuvée : la personne est maintenant connectée et a reçu un e-mail.",
      rejected: "Demande refusée. La personne a reçu un e-mail.",
      revoked: "Connexion révoquée. Ses sessions de connexion ont pris fin.",
      reconnected: "Reconnecté.",
      added: "Connecté.",
      stale: "Cette demande ou connexion avait déjà changé. Rien n’a été fait.",
      self: "Vous ne pouvez pas révoquer votre propre connexion.",
    },
  },
  mail: {
    codeSubject: (code) => `Votre code de connexion ASafariM : ${code}`,
    codeText: (code, minutes, host) =>
      `Votre code de connexion ASafariM est ${code}.\n\nIl expire dans ${minutes} minutes et ne fonctionne qu’une fois. Ne le communiquez à personne : ASafariM ne vous le demandera jamais.\n\nSi vous n’avez pas essayé de vous connecter sur ${host}, vous pouvez ignorer cet e-mail.\n`,
    sms: (code, minutes) =>
      `Votre code de connexion ASafariM est ${code}. Il expire dans ${minutes} minutes. Ne le communiquez à personne.`,
    approvedSubject: "ASafariM : votre demande d’accès a été approuvée",
    approvedText: (names, url) =>
      `Bonne nouvelle : un administrateur a approuvé votre demande d’accès${names ? ` pour ${names}` : ""}.\n\nConnectez-vous sur ${url}/account pour voir vos applications. Si une application indique encore que vous n’avez pas accès, ses rôles sont en cours de configuration : réessayez un peu plus tard.\n`,
    rejectedSubject: "ASafariM : votre demande d’accès",
    rejectedText: (names, url) =>
      `Un administrateur n’a pas approuvé votre demande d’accès${names ? ` pour ${names}` : ""}.\n\nSi vous pensez qu’il s’agit d’une erreur, connectez-vous sur ${url}/login et envoyez une nouvelle demande avec un message.\n`,
  },
};

const DE: Messages = {
  common: {
    home: "Startseite",
    signOut: "Abmelden",
    continue: "Weiter",
    tagline: "Anmeldung und Konten für ASafariM-Apps",
    legal: { privacy: "Datenschutz", cookies: "Cookies", terms: "Nutzungsbedingungen" },
    products: {
      breinhap: "Lern-App für flämische Schülerinnen und Schüler (Android).",
      igs: "Online-Apotheke für Belgien, und ihre Android-App.",
    },
    goHome: "Zur Startseite von ASafariM OS",
  },
  errors: {
    title: "Die Anmeldung wurde nicht abgeschlossen",
    again: "Gehen Sie zurück zur App und starten Sie die Anmeldung neu.",
    unprocessable: "Die Anmeldeanfrage konnte nicht verarbeitet werden.",
    linkExpired: "Dieser Anmeldelink ist abgelaufen.",
    linkMismatch: "Dieser Anmeldelink passt nicht zu Ihrer Sitzung.",
    expired: "Diese Anmeldung ist abgelaufen.",
    noAssertion: "Hub hat keinen Anmeldenachweis gesendet.",
    unverified: "Ihre Anmeldung konnte nicht überprüft werden.",
    inactive: "Dieses Konto kann sich nicht anmelden.",
    browser: "Diese Anmeldung kann in diesem Browser nicht abgeschlossen werden.",
  },
  logout: {
    title: "Abmelden",
    heading: "Von ASafariM abmelden?",
    text: "Damit melden Sie sich auf diesem Gerät von Ihrem ASafariM-Konto ab, und die nächste Anmeldung fragt wieder, wer Sie sind. Bereits geöffnete Apps behalten ihre eigene Sitzung, bis Sie sich dort abmelden.",
    confirm: "Abmelden",
    stay: "Angemeldet bleiben",
  },
  signedOut: {
    title: "Abgemeldet",
    heading: "Sie sind abgemeldet",
    text: "Sie können diesen Tab schließen oder zur Startseite von ASafariM OS weitergehen.",
    again: "Wieder anmelden",
  },
  signingIn: { title: "Sie werden angemeldet", heading: "Sie werden angemeldet…", text: "Zurück zur App." },
  signedIn: { title: "Angemeldet", heading: "Sie sind angemeldet", text: "Es geht weiter…" },
  login: {
    title: "Anmelden",
    google: "Weiter mit Google",
    passkey: "Mit einem Passkey anmelden",
    email: "E-Mail-Adresse",
    emailPlaceholder: "sie@beispiel.be",
    emailSubmit: "Anmeldecode per E-Mail senden",
    mobile: "Handynummer",
    smsSubmit: "Code per SMS senden",
    useMobile: "Lieber mit Handynummer",
    or: "oder einen Einmalcode erhalten",
    ways: { google: "Google", passkey: "einem Passkey", email: "einem Code per E-Mail", sms: "einem Code per SMS" },
    listOr: orList("oder"),
    eyebrow: "Ihr ASafariM-Konto",
    howTitle: "Eine Anmeldung für jede ASafariM-App",
    steps: [
      ["Anmelden", (ways) => `Mit ${ways}. Beim ersten Mal wird Ihr Konto erstellt.`],
      ["Zugang anfragen", () => "Wählen Sie die Apps, die Sie brauchen, und sagen Sie dem Administrator, warum."],
      [
        "Ein Administrator genehmigt",
        () => "Sie erhalten eine E-Mail, und Ihre Apps öffnen sich mit derselben Anmeldung.",
      ],
    ],
    onlyProves:
      "Die Anmeldung beweist nur, wer Sie sind. Keine App öffnet sich, bevor ein Administrator Ihnen Zugang gibt.",
    continueTo: (app) => `Weiter zu ${app}`,
    signInTo: (app) => `Bei ${app} anmelden`,
    appLead: (app) => `${app} nutzt Ihr ASafariM-Konto. Neu hier? Mit der Anmeldung wird Ihr Konto erstellt.`,
    welcome: "Willkommen bei ASafariM. Neu hier? Mit der Anmeldung wird Ihr Konto erstellt.",
    fine: (terms, privacy) =>
      `Wenn Sie fortfahren, akzeptieren Sie die <a href="${terms}">Nutzungsbedingungen</a> und die\n<a href="${privacy}">Datenschutzerklärung</a>.`,
  },
  code: {
    title: "Code eingeben",
    checkEmail: "Sehen Sie in Ihre E-Mails",
    checkPhone: "Sehen Sie auf Ihr Handy",
    sent: (via, masked, minutes) =>
      `Wenn sich ${via === "email" ? "diese Adresse" : "diese Nummer"} anmelden kann, ist ${via === "email" ? "eine E-Mail" : "eine SMS"} mit einem 6-stelligen Code unterwegs an <strong>${masked}</strong>. Er läuft in ${minutes} Minuten ab.`,
    label: "Anmeldecode",
    verify: "Prüfen und anmelden",
    resend: "Neuen Code senden",
    another: "Anderen Weg wählen",
    spam: "Keine E-Mail? Sehen Sie im Spam-Ordner nach. Codes kommen von ASafariM, und niemand wird Sie je danach fragen.",
  },
  nav: { account: "Konto", connections: "Verbindungen", adminConsole: "Admin-Konsole", main: "Hauptmenü" },
  next: {
    title: "Wie geht es weiter?",
    os: "ASafariM OS",
    osText: "Die Startseite: was das OS ist und was neu ist.",
    appsConnected: "Eine App öffnet sich, sobald ein Administrator Ihrem Konto Zugang gegeben hat.",
    appsNotConnected: "Apps öffnen sich, sobald Ihr Konto verbunden ist und ein Administrator ihm Zugang gegeben hat.",
    more: "Mehr von ASafariM",
  },
  request: {
    which: "Welche Apps brauchen Sie?",
    note: "Sollte der Administrator noch etwas wissen?",
    optional: "(optional)",
    placeholder: "Zum Beispiel: Ich bin im IGS-Pharma-Team und brauche Docs.",
    waiting: "Wartet auf einen Administrator",
    sent: "gesendet",
    apps: "Apps:",
    justAccount: "Nur ein Konto",
    update: "Anfrage aktualisieren",
    send: "Anfrage senden",
  },
  account: {
    title: "Ihr Konto",
    added: "Hinzugefügt",
    lastUsed: "Zuletzt verwendet",
    remove: "Entfernen",
    noPasskeys: "Noch keine Passkeys.",
    connected: "Verbunden",
    waitingApproval: "Wartet auf Genehmigung",
    notConnected: "Noch nicht verbunden",
    accessRequest: "Zugangsanfrage",
    changeRequest: "Apps hinzufügen oder Ihre Notiz ändern",
    needAnother: "Noch eine App nötig? Zugang anfragen",
    access: "Zugang",
    notConnectedText:
      "Ihr Konto ist noch nicht verbunden. Bitten Sie einen Administrator um Zugang, um ASafariM-Apps zu nutzen.",
    seeRequest: "Ihre Anfrage ansehen oder ändern",
    ask: "Zugang anfragen",
    accountId: "Konto-ID:",
    copy: "Konto-ID kopieren",
    copied: "Konto-ID kopiert.",
    copyFailed: "Kopieren hat nicht geklappt. Die Konto-ID ist markiert; kopieren Sie sie selbst.",
    idHint: "Ein Administrator gibt Ihnen mit Ihrer Konto-ID Zugang zu einer App.",
    howSignIn: "Wie Sie sich anmelden",
    methodsLabel: "Anmeldemethoden",
    methods: { google: "Google", email: "E-Mail-Code", phone: "SMS-Code", passkey: "Passkey" },
    passkeys: "Passkeys",
    passkeyHint:
      "Mit einem Passkey melden Sie sich per Fingerabdruck, Gesicht oder Geräte-PIN an, statt mit einem Code.",
    addPasskey: "Passkey hinzufügen",
    passkeyWaiting: "Warten auf Ihren Passkey…",
    passkeyCancelled: "Abgebrochen.",
    passkeyFailed: "Das hat nicht geklappt.",
  },
  progress: {
    label: "Ihr Fortschritt",
    steps: ["Angemeldet", "Zugang anfragen", "Prüfung", "Apps öffnen"],
  },
  notConnected: {
    pendingTitle: "Anfrage in Bearbeitung",
    justSent: "Ihre Anfrage wurde gesendet.",
    already: "Sie haben bereits Zugang angefragt.",
    review:
      "Ein Administrator prüft sie, und Sie erhalten eine E-Mail, sobald entschieden ist. Melden Sie sich dann wieder an.",
    askTitle: "Zugang anfragen",
    askText:
      "Sie sind angemeldet, aber Ihr Konto ist noch nicht mit ASafariM verbunden. Sagen Sie einem Administrator, was Sie brauchen: Er prüft es, und Sie erhalten eine E-Mail.",
    signedInAs: (label) => `Angemeldet als <strong>${label}</strong>`,
  },
  flow: {
    expiredTitle: "Diese Seite ist abgelaufen",
    expiredText: "Zu Ihrer Sicherheit sind Anmeldeseiten nur kurz gültig.",
    startAgain: "Neu beginnen",
    tooManyTitle: "Zu viele Versuche",
    tooManyText: "Bitte warten Sie eine Weile, bevor Sie sich erneut anmelden.",
    tooManyCodes: (m) =>
      `Es wurden zu viele Codes angefordert. Versuchen Sie es in ${m} ${m === 1 ? "Minute" : "Minuten"} erneut.`,
    cooldown: "Gerade wurde ein Code gesendet. Warten Sie eine Minute, bevor Sie einen neuen anfordern.",
    googleExpired: "Diese Anmeldung mit Google ist abgelaufen. Bitte versuchen Sie es erneut.",
    sendFailed: "Wir konnten gerade keinen Code senden. Versuchen Sie es in ein paar Minuten erneut.",
    tooManyCodeTries: "Zu viele Versuche. Warten Sie eine Weile und fordern Sie dann einen neuen Code an.",
    enterCode: (via) => `Geben Sie den 6-stelligen Code aus ${via === "email" ? "der E-Mail" : "der SMS"} ein.`,
    noLongerValid: "Dieser Code ist nicht mehr gültig. Senden Sie einen neuen Code.",
    wrongCode: (via) =>
      `Dieser Code stimmt nicht. Prüfen Sie ${via === "email" ? "die E-Mail" : "die SMS"} und versuchen Sie es erneut.`,
    codeExpired: "Dieser Code ist abgelaufen oder wurde zu oft falsch eingegeben. Senden Sie einen neuen Code.",
    googleCancelled:
      "Die Anmeldung mit Google wurde abgebrochen. Versuchen Sie es erneut oder wählen Sie einen anderen Weg.",
    googleFailed: "Google konnte Sie nicht anmelden. Versuchen Sie es erneut oder wählen Sie einen anderen Weg.",
    tryAgain: "Bei der Anmeldung ist etwas schiefgelaufen. Bitte versuchen Sie es erneut.",
    tooManyTries: "Zu viele Versuche. Warten Sie eine Weile und versuchen Sie es erneut.",
    reload: "Diese Seite ist abgelaufen. Laden Sie sie neu.",
    passkeyUnusable:
      "Dieser Passkey kann hier nicht verwendet werden. Versuchen Sie es erneut oder nutzen Sie einen Code.",
    signInFirst: "Melden Sie sich zuerst an.",
    passkeyNotAdded: "Dieser Passkey konnte nicht hinzugefügt werden. Versuchen Sie es erneut.",
    removed: "Passkey entfernt.",
    requested: "Anfrage gesendet. Ein Administrator prüft sie, und Sie erhalten eine E-Mail.",
    unchanged: "Ihre Anfrage enthält diese Apps schon.",
    signedOutText:
      "Sie sind auf diesem Gerät von Ihrem ASafariM-Konto abgemeldet, und die nächste Anmeldung fragt wieder, wer Sie sind. Bereits geöffnete Apps behalten ihre eigene Sitzung, bis Sie sich dort abmelden.",
    noAccessTitle: "Kein Zugang",
    noAccessText: "Diese Seite ist für Administratoren von ASafariM.",
    invalidEmail: "Geben Sie eine gültige E-Mail-Adresse ein.",
    invalidPhone: "Geben Sie Ihre vollständige Handynummer mit Ländervorwahl ein, zum Beispiel +32 470 12 34 56.",
    smsCountry: "Die Anmeldung per SMS ist für Nummern aus diesem Land nicht verfügbar.",
    somethingWrong: "Etwas ist schiefgelaufen.",
  },
  admin: {
    title: "Verbindungen",
    lead: "Wer sich bei ASafariM-Apps anmelden darf. Genehmigen verbindet ein Konto; was jemand in einer App tun darf, ist eine Rolle, die Sie in der Admin-Konsole vergeben.",
    who: "Wer",
    apps: "Apps",
    note: "Notiz",
    requested: "Angefragt",
    status: "Status",
    granted: "Gewährt",
    lastSignIn: "Letzte Anmeldung",
    when: "Wann",
    event: "Ereignis",
    details: "Details",
    approve: "Genehmigen",
    reject: "Ablehnen",
    connectedPill: "verbunden",
    noRequests: "Keine offenen Anfragen. Alles erledigt.",
    revoke: "Widerrufen",
    reconnect: "Wieder verbinden",
    you: "Sie",
    adminSuffix: "(Admin)",
    statuses: { active: "aktiv", revoked: "widerrufen" },
    noConnections: "Keine Verbindungen.",
    nothingYet: "Noch nichts.",
    none: "keine",
    pending: "offen",
    connected: "verbunden",
    revoked: "widerrufen",
    grantHint: "Geben Sie ihnen in der Admin-Konsole Rollen für ihre Apps",
    requestsTitle: "Zugangsanfragen",
    connectTitle: "Jemanden verbinden",
    connectPlaceholder: "E-Mail oder +32 470 12 34 56",
    connectLabel: "E-Mail-Adresse oder Handynummer",
    connect: "Verbinden",
    connectionsTitle: "Verbindungen",
    activity: "Letzte Aktivität",
    enterIdentifier: "Geben Sie eine E-Mail-Adresse oder eine Handynummer mit Ländervorwahl ein (+32 …).",
    notices: {
      approved: "Anfrage genehmigt: Die Person ist jetzt verbunden und hat eine E-Mail erhalten.",
      rejected: "Anfrage abgelehnt. Die Person hat eine E-Mail erhalten.",
      revoked: "Verbindung widerrufen. Ihre Anmeldesitzungen wurden beendet.",
      reconnected: "Wieder verbunden.",
      added: "Verbunden.",
      stale: "Diese Anfrage oder Verbindung hatte sich schon geändert. Es wurde nichts getan.",
      self: "Sie können Ihre eigene Verbindung nicht widerrufen.",
    },
  },
  mail: {
    codeSubject: (code) => `Ihr ASafariM-Anmeldecode: ${code}`,
    codeText: (code, minutes, host) =>
      `Ihr ASafariM-Anmeldecode lautet ${code}.\n\nEr läuft in ${minutes} Minuten ab und funktioniert nur einmal. Geben Sie ihn niemandem weiter: ASafariM wird Sie nie danach fragen.\n\nWenn Sie nicht versucht haben, sich bei ${host} anzumelden, können Sie diese E-Mail ignorieren.\n`,
    sms: (code, minutes) =>
      `Ihr ASafariM-Anmeldecode lautet ${code}. Er läuft in ${minutes} Minuten ab. Geben Sie ihn niemandem weiter.`,
    approvedSubject: "ASafariM: Ihre Zugangsanfrage wurde genehmigt",
    approvedText: (names, url) =>
      `Gute Nachricht: Ein Administrator hat Ihre Zugangsanfrage${names ? ` für ${names}` : ""} genehmigt.\n\nMelden Sie sich unter ${url}/account an, um Ihre Apps zu sehen. Sagt eine App noch, dass Sie keinen Zugang haben, werden ihre Rollen gerade eingerichtet: Versuchen Sie es etwas später erneut.\n`,
    rejectedSubject: "ASafariM: Ihre Zugangsanfrage",
    rejectedText: (names, url) =>
      `Ein Administrator hat Ihre Zugangsanfrage${names ? ` für ${names}` : ""} nicht genehmigt.\n\nWenn Sie das für einen Irrtum halten, melden Sie sich unter ${url}/login an und senden Sie eine neue Anfrage mit einer Notiz.\n`,
  },
};

export const MESSAGES: Readonly<Record<Locale, Messages>> = { en: EN, nl: NL, fr: FR, de: DE };
