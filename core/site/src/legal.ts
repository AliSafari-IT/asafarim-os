/**
 * The OS's legal pages, served by asafarim.site at /privacy, /cookies and /terms and linked from the footer of
 * every OS host (asafarim.site, id.asafarim.site, the Admin console, Docs, Notes; @asafarim/theme's LEGAL_LINKS).
 *
 * The text must match what the code really does. The cookie table is an inventory of every cookie the OS sets:
 * add a row when a new one appears (packages/theme, core/identity, packages/app-sdk, Auth.js in the Next.js apps).
 * Breinhap has its own policies at breinhap.asafarim.site, IGS-Pharma at igs.asafarim.site.
 *
 * Drafted for Ali's review (asafarim-os, October 2026): not legal advice. A lawyer should read it before it is relied on.
 *
 * Strings are trusted HTML written here (links, <code>, <strong>), never user input.
 */

export const CONTACT_EMAIL = "privacy@asafarim.site";
/** The day the text last changed in substance (YYYY-MM-DD). */
export const LEGAL_UPDATED = "2026-10-23";

export type LegalSlug = "privacy" | "cookies" | "terms";

export interface LegalTable {
  caption: string;
  head: string[];
  rows: string[][];
}
export type LegalBlock = string | { list: string[] } | { table: LegalTable };

export interface LegalDoc {
  slug: LegalSlug;
  /** Short name, for links and the footer. */
  label: string;
  title: string;
  description: string;
  lead: string;
  sections: { id: string; heading: string; blocks: LegalBlock[] }[];
}

const mail = `<a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>`;
const DPA =
  '<a href="https://www.dataprotectionauthority.be/">Belgian Data Protection Authority</a> (Gegevensbeschermingsautoriteit / Autorité de protection des données)';

const privacy: LegalDoc = {
  slug: "privacy",
  label: "Privacy",
  title: "Privacy policy",
  description:
    "What personal data ASafariM OS uses, why, for how long, who else sees it, and your rights under the GDPR.",
  lead: "ASafariM OS keeps as little about you as it can: what it needs to sign you in, to decide what you may open, and to keep the system secure. No ads, no analytics, no tracking.",
  sections: [
    {
      id: "who",
      heading: "Who we are",
      blocks: [
        `ASafariM, in Belgium, runs ASafariM OS and is the controller of the personal data described here. For anything about your data, email ${mail}.`,
        'This policy covers asafarim.site, id.asafarim.site (sign-in and accounts), admin.asafarim.site (the Admin console), docs.asafarim.site, Notes, and any other app on asafarim.site that links to it. Breinhap has <a href="https://breinhap.asafarim.site/en/privacy/">its own privacy policy</a>, and so does IGS-Pharma (<a href="https://igs.asafarim.site/en/privacy/">its landing page and Android app</a>). The asafarim.com platform is a separate service with its own policy.',
      ],
    },
    {
      id: "what",
      heading: "What we use, and why",
      blocks: [
        {
          table: {
            caption: "Personal data, its purpose and the legal basis (GDPR article 6)",
            head: ["Data", "Why", "Legal basis"],
            rows: [
              [
                "Your email address (or phone number, where sign-in by text message is offered) and an account id",
                "To create your account, send you sign-in codes and recognise you when you come back",
                "Contract: providing the service you asked for (6(1)(b))",
              ],
              [
                "Passkeys: the public key, the name you gave it, when it was added and last used",
                "To let you sign in with a passkey. The private key never leaves your device.",
                "Contract (6(1)(b))",
              ],
              [
                "Whether you have access, your roles and permissions, and who approved them",
                "To decide what you may open, and to let an administrator approve or end access",
                "Contract (6(1)(b))",
              ],
              [
                "Sign-in and access events (an append-only security log). Addresses and identifiers in it are stored as keyed hashes, not in plain text.",
                "To protect accounts, limit abuse (for example too many sign-in attempts) and investigate incidents",
                "Legitimate interest: keeping the service secure (6(1)(f))",
              ],
              [
                "What you write in an app, such as study notes in Docs or Notes",
                "To store it and show it to you. Notes are private to you.",
                "Contract (6(1)(b))",
              ],
              [
                "Technical data a server always receives: IP address, browser, the page asked for, errors",
                "To deliver pages, keep the service running and find faults. Kept briefly.",
                "Legitimate interest (6(1)(f))",
              ],
              [
                "Your light or dark theme choice",
                'To show the theme you picked. See the <a href="/cookies">cookie policy</a>.',
                "Your request (a cookie you set yourself)",
              ],
            ],
          },
        },
        "We do not use your data for advertising or profiling, we do not sell it, and we make no automated decisions about you that have legal or similarly significant effects.",
      ],
    },
    {
      id: "share",
      heading: "Who else sees it",
      blocks: [
        "Only the people and companies that help run the service, and only for that:",
        {
          list: [
            "<strong>Our hosting provider</strong>, which runs the servers the OS and its databases are on.",
            "<strong>Our email provider</strong>, which delivers your sign-in codes.",
            "<strong>Administrators of ASafariM OS</strong>, who see account and access records to approve access and keep the system safe. They do not read your private notes.",
            "<strong>Only if you choose to turn a note into a GitHub issue in Docs:</strong> the note and the quoted text go to Anthropic (Claude), which drafts the issue, and the issue is published on GitHub. Both companies are in the United States. Nothing is sent unless you start this yourself.",
          ],
        },
        "We may also disclose data when the law requires it, for example to a court or the police with a valid order.",
      ],
    },
    {
      id: "transfers",
      heading: "Data outside the EU",
      blocks: [
        "We keep data in the European Economic Area where we can. When a provider handles it outside the EEA (as with Anthropic and GitHub above), we rely on an adequacy decision of the European Commission, such as the EU-US Data Privacy Framework, or on the Commission's standard contractual clauses. Email us for a copy of the safeguards.",
      ],
    },
    {
      id: "retention",
      heading: "How long we keep it",
      blocks: [
        {
          list: [
            "<strong>Your account</strong> (email or phone, passkeys, access): until you ask us to delete it.",
            "<strong>Sign-in codes:</strong> 5 minutes, and only as a hash.",
            "<strong>Sign-in sessions:</strong> up to 12 hours on id.asafarim.site; an app's session ends no later.",
            "<strong>Your notes:</strong> until you delete them or your account.",
            "<strong>Security log:</strong> kept for accountability. It cannot be changed afterwards, and it holds no email address or IP address in plain text.",
            "<strong>Server logs:</strong> a short time, then they are overwritten.",
          ],
        },
      ],
    },
    {
      id: "rights",
      heading: "Your rights",
      blocks: [
        "Under the GDPR you may ask us for a copy of your data, to correct it, to delete it, to limit how we use it, to object to a use based on legitimate interest, and to receive it in a portable format. Email " +
          mail +
          " from the address on your account. We answer within one month.",
        `If you think we handle your data wrongly, please tell us first. You can always complain to the ${DPA}, Drukpersstraat 35, 1000 Brussels.`,
      ],
    },
    {
      id: "security",
      heading: "Security",
      blocks: [
        "Connections are encrypted (HTTPS). Sessions are kept in cookies other sites and other apps cannot read. Sign-in codes are short-lived and stored hashed, passkeys use public keys only, and access is checked on every request.",
      ],
    },
    {
      id: "children",
      heading: "Children",
      blocks: [
        "ASafariM OS is not meant for children: access is by approval, for people aged 16 or over. Breinhap, our app for teenagers, follows its own stricter policy.",
      ],
    },
    {
      id: "changes",
      heading: "Changes",
      blocks: [
        "When what we do with your data changes, we update this page and the date below first. For a change that matters to you, we tell you when you next sign in.",
      ],
    },
  ],
};

/** Every cookie the OS sets, by host. Keep in step with the code (see the comment at the top). */
const cookieRows: string[][] = [
  [
    "<code>asafarim-theme</code>",
    "All *.asafarim.site hosts",
    "Remembers whether you chose the light or dark theme. Set only when you press the theme button.",
    "1 year",
  ],
  [
    "<code>identity_auth</code>",
    "id.asafarim.site",
    "Keeps you signed in to your ASafariM account.",
    "12 hours, or until you sign out",
  ],
  ["<code>identity_login</code>", "id.asafarim.site", "Holds one sign-in while you enter your code.", "15 minutes"],
  [
    "<code>identity_complete</code>",
    "id.asafarim.site",
    "Proves the last step of a sign-in comes from the browser that started it.",
    "1 minute",
  ],
  [
    "<code>_session</code>, <code>_session.sig</code>",
    "id.asafarim.site",
    "Lets apps sign you in with your account (OpenID Connect) without asking again.",
    "14 days, or until you sign out",
  ],
  [
    "<code>_interaction</code>, <code>_interaction_resume</code> (and <code>.sig</code>)",
    "id.asafarim.site",
    "Connects a sign-in to the app that asked for it.",
    "10 minutes",
  ],
  [
    "<code>__Host-asafarim.session-token</code>",
    "Each app (Admin, Docs, Notes), on its own host",
    "Keeps you signed in to that app. It may be split into numbered parts (<code>.0</code>, <code>.1</code>) when large.",
    "Up to 12 hours",
  ],
  [
    "<code>__Host-authjs.csrf-token</code>",
    "Each app, on its own host",
    "Protects sign-in and sign-out forms against forged requests.",
    "Until you close the browser",
  ],
  [
    "<code>__Secure-authjs.callback-url</code>",
    "Each app, on its own host",
    "Remembers the page to return to after sign-in.",
    "Until you close the browser",
  ],
  [
    "<code>__Secure-authjs.state</code>, <code>.pkce.code_verifier</code>, <code>.nonce</code>",
    "Each app, on its own host",
    "Security checks that tie a sign-in reply to the request that started it.",
    "15 minutes",
  ],
  [
    "<code>__Host-asafarim.access</code>",
    "Docs and Notes, on their own host",
    "A short-lived pass the OS checks before it lets a request through to the app.",
    "Up to 10 minutes",
  ],
];

const cookies: LegalDoc = {
  slug: "cookies",
  label: "Cookies",
  title: "Cookie policy",
  description:
    "Every cookie ASafariM OS sets, what it is for and how long it lasts. No tracking or advertising cookies.",
  lead: "ASafariM OS uses only cookies it needs to work, plus one that remembers your theme. There are no analytics, advertising or tracking cookies, and nothing from other companies, so there is no cookie banner.",
  sections: [
    {
      id: "what",
      heading: "What a cookie is",
      blocks: [
        "A cookie is a small piece of text a website asks your browser to keep and send back. Belgian law (article 129 of the Electronic Communications Act) and the GDPR allow cookies without consent when they are strictly necessary for a service you asked for. Every cookie below is of that kind.",
      ],
    },
    {
      id: "list",
      heading: "The cookies we set",
      blocks: [
        {
          table: {
            caption:
              "All cookies, by host. All are first-party; the sign-in ones are HttpOnly (scripts can't read them) and Secure (HTTPS only).",
            head: ["Cookie", "Where", "What it does", "How long"],
            rows: cookieRows,
          },
        },
        "Cookies on <code>__Host-</code> names stay on the one host that set them: another app or subdomain cannot read them. Only <code>asafarim-theme</code> is shared across *.asafarim.site, so your theme choice follows you.",
      ],
    },
    {
      id: "storage",
      heading: "Other storage on your device",
      blocks: [
        "The OS's pages keep nothing in your browser's local storage or session storage, and load no third-party scripts, fonts or pixels.",
      ],
    },
    {
      id: "control",
      heading: "Your choice",
      blocks: [
        "You can see and delete cookies in your browser's settings, or block them. Deleting the sign-in cookies signs you out; blocking them means you cannot sign in. Deleting <code>asafarim-theme</code> makes pages follow your system's light or dark setting again.",
        `Questions? Email ${mail}. How we handle personal data in general is in the <a href="/privacy">privacy policy</a>.`,
      ],
    },
  ],
};

const terms: LegalDoc = {
  slug: "terms",
  label: "Terms",
  title: "Terms of use",
  description: "The terms for using ASafariM OS and its apps on asafarim.site.",
  lead: "These terms apply when you use asafarim.site, id.asafarim.site and the ASafariM OS apps. Using them means you accept these terms.",
  sections: [
    {
      id: "who",
      heading: "Who we are",
      blocks: [`ASafariM OS is run by ASafariM, in Belgium. Contact: ${mail}.`],
    },
    {
      id: "service",
      heading: "The service",
      blocks: [
        "ASafariM OS is a platform in development that apps plug into. It is offered free of charge. Features may change, pause or stop, and there will be downtime. We will try to warn you before something you rely on goes away.",
        "Access to apps is by approval: you request a connection, and an administrator decides. We may refuse or end access.",
      ],
    },
    {
      id: "account",
      heading: "Your account",
      blocks: [
        {
          list: [
            "You must be 16 or older to have an account.",
            "Give a real email address that is yours, and keep access to it and to your passkeys safe. An account is for one person.",
            "Tell us at " + mail + " if you think someone else used your account.",
            "You can ask us to delete your account at any time.",
          ],
        },
      ],
    },
    {
      id: "use",
      heading: "Acceptable use",
      blocks: [
        "Do not:",
        {
          list: [
            "try to get into accounts, data or parts of the system you were not given access to, or test its security without our written permission (we welcome reports at " +
              mail +
              ");",
            "disrupt the service, overload it, or collect data from it automatically beyond normal use;",
            "use it for anything unlawful, or to store or share content that infringes someone's rights;",
            "pass your access on to someone else.",
          ],
        },
        "We may suspend an account that breaks these rules, and close it if it keeps doing so.",
      ],
    },
    {
      id: "content",
      heading: "Your content",
      blocks: [
        "What you write in an app (such as notes) stays yours. You allow us to store it and show it to you, only to run the service. You are responsible for what you write.",
      ],
    },
    {
      id: "ours",
      heading: "Our content and code",
      blocks: [
        'The ASafariM name, logo and the content of these sites are ours. The source code is published under its own licence, in the <a href="https://github.com/AliSafari-IT/asafarim-os">repository</a>; that licence, not these terms, says what you may do with the code.',
      ],
    },
    {
      id: "liability",
      heading: "No guarantee, and limits",
      blocks: [
        'The service is provided "as is", without a guarantee that it is always available, error-free or fit for a particular purpose. Keep your own copy of anything important.',
        "To the extent the law allows, we are not liable for indirect damage, such as lost data or lost profit. Nothing in these terms limits liability for intent, gross negligence, or death or personal injury, or takes away rights consumer law gives you.",
      ],
    },
    {
      id: "changes",
      heading: "Changes",
      blocks: [
        "We may update these terms. The date below shows the latest version. For a change that matters to you, we tell you before it applies; if you do not agree, you can stop using the service and ask us to delete your account.",
      ],
    },
    {
      id: "law",
      heading: "Law and disputes",
      blocks: [
        "Belgian law applies. Please contact us first; we will try to solve it together. If that fails, the Belgian courts are competent, without taking away the protection the law of the country where you live gives you as a consumer.",
      ],
    },
  ],
};

export const LEGAL_DOCS: readonly LegalDoc[] = [privacy, cookies, terms];
