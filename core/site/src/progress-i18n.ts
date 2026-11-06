/**
 * The progress file's apps, screenshots, roadmap and links in Dutch, French and German (English is
 * progress.json itself). Keyed by the progress file's ids; test/progress-i18n.test.ts fails when an entry
 * there has no translation here, or when its surfaces don't line up, so new content can't ship half-translated.
 * The shipped milestones stay English (see i18n.ts).
 */
import type { App, Progress } from "./progress.ts";
import { type Locale, PRODUCT_HREFS } from "./i18n.ts";

interface AppText {
  tagline: string;
  summary: string;
  /** Per surface, in the progress file's order. */
  surfaces: readonly { kind: string; address?: string; note: string }[];
}

export interface ProgressText {
  apps: Readonly<Record<string, AppText>>;
  screenshots: Readonly<Record<string, { title: string; alt: string; caption: string }>>;
  roadmap: Readonly<Record<string, { title: string; summary: string }>>;
  links: Readonly<Record<string, string>>;
}

type Translated = Exclude<Locale, "en">;

export const PROGRESS_TEXT: Readonly<Record<Translated, ProgressText>> = {
  nl: {
    apps: {
      identity: {
        tagline: "Eén keer aanmelden voor elke app",
        summary:
          "Meld je één keer aan met een e-mailcode, een passkey of Google, en elke OS-app weet wie je bent. Wie nieuw is, vraagt met een korte toelichting toegang tot de apps die hij of zij nodig heeft, en een beheerder keurt goed.",
        surfaces: [{ kind: "Webapp", note: "Aanmelden, je account en toegangsaanvragen." }],
      },
      docs: {
        tagline: "Je documentatie lezen, notities nemen",
        summary:
          "Een privélezer voor documentatierepository's: lees de Markdown, houd er studienotities bij en maak van een notitie een GitHub-issue in de repository waar het document bij hoort.",
        surfaces: [{ kind: "Webapp", note: "Voor wie van een beheerder een Docs-rol kreeg." }],
      },
      flow: {
        tagline: "Workflows die op events draaien",
        summary:
          "Bouw visueel een workflow, start hem vanuit een OS-event, een webhook of GitHub, en laat mensen een stap goedkeuren of weigeren voor hij verdergaat. Zes connectoren, een versleutelde opslag voor inloggegevens, en ontwerpen die Claude uit een issue schrijft en die nooit vanzelf draaien.",
        surfaces: [{ kind: "Webapp", note: "Voor wie van een beheerder een Flow-rol kreeg." }],
      },
      admin: {
        tagline: "Het OS beheren",
        summary:
          "De geïnstalleerde apps en hun toestand, rollen en toekenningen, toegangsaanvragen, en één auditcentrum voor aanmeldingen, toegangsbeslissingen en wijzigingen door beheerders.",
        surfaces: [{ kind: "Webapp", note: "Alleen voor beheerders, daarom hier niet gelinkt." }],
      },
      notes: {
        tagline: "De referentie-app",
        summary:
          "De kleinste app die het contract van begin tot eind toont: een manifest, een eigen database, zichzelf registreren, aanmelden via Identity, rollen toegekend door een beheerder.",
        surfaces: [
          {
            kind: "Voorbeeld",
            address: "Lokale ontwikkeling",
            note: "Draait in de ontwikkelomgeving; niet uitgerold.",
          },
        ],
      },
      "igs-pharma": {
        tagline: "Een onlineapotheek voor België",
        summary:
          "Gebouwd met een Belgische apotheek: een webshop voor producten zonder voorschrift met een apotheker die meekijkt, een back-office voor het apotheekteam en een gratis Android-app. Eigen code en domein, in de stijl van het OS; de projectpagina wordt door het OS geserveerd.",
        surfaces: [
          {
            kind: "Website",
            note: "Het project, in het Nederlands, Frans, Duits en Engels, met de privacypagina's van de app.",
          },
          {
            kind: "Webshop",
            note: "Gesloten tot de lancering: klanten die de apotheek uitnodigt of goedkeurt, zien hem al.",
          },
          {
            kind: "Android-app",
            note: "Bladeren, zoeken, een verpakking scannen en een lijst bijhouden; bestellen gaat via de webshop. In interne test.",
          },
          {
            kind: "Back-office",
            address: "Apotheekpersoneel",
            note: "Catalogus, prijzen, voorraad en terugroepingen, bestellingen, levering en vroege toegang, achter een passkey.",
          },
        ],
      },
      breinhap: {
        tagline: "Korte studiemissies voor het secundair onderwijs",
        summary:
          "Een studie-app voor Vlaamse leerlingen in het secundair onderwijs, ontworpen met ADHD en AuDHD in gedachten: missies van 2 tot 6 minuten, altijd in dezelfde vier stappen.",
        surfaces: [
          {
            kind: "Android-introductie",
            note: "Wat de app is, in het Nederlands en het Engels, met de privacypagina's.",
          },
          {
            kind: "Webapp",
            note: "Publieke introductie en aanmeld- en registratiepagina's voor volwassenen; missies in de browser zijn er nog niet.",
          },
          {
            kind: "Breinhap-beheer",
            note: "Pilot op uitnodiging voor actieve ASafariM-volwassenen met uitdrukkelijke toegang tot Breinhap.",
          },
          { kind: "Android-app", note: "In een gesloten test voor hij voor iedereen opengaat." },
        ],
      },
    },
    screenshots: {
      "admin-apps.png": {
        title: "Apps",
        alt: "De pagina Apps van de beheerconsole, met de ingebouwde kern en de Notes-app, hun levenscyclustoestand en acties.",
        caption: "Elke geïnstalleerde app met zijn levenscyclustoestand: activeren, deactiveren of verwijderen.",
      },
      "admin-app-roles.png": {
        title: "Rollen en toekenningen van een app",
        alt: "De pagina Rollen en toekenningen van de beheerconsole voor de Notes-app, met de rollen die Notes declareert, hun rechten en wie ze heeft.",
        caption: "De rollen en rechten die een app declareert, en wie ze heeft. Een app registreren kent niets toe.",
      },
      "admin-events.png": {
        title: "Events",
        alt: "De pagina Events van de beheerconsole, met de eventtypes die apps publiceren, hun uitgever, abonnees en schema.",
        caption: "De eventcatalogus: elk eventtype met zijn uitgever, abonnees en schema.",
      },
      "admin-status.png": {
        title: "Status",
        alt: "De pagina Status van de beheerconsole, met core-api en de Notes-app, hun live- en ready-checks als Up, de vertraging en wanneer elk laatst gecontroleerd is.",
        caption:
          "Het statusbord: core-api controleert de live- en ready-endpoints van elke actieve app uit zijn manifest.",
      },
      "notes.png": {
        title: "Notes",
        alt: "De Notes-app, aangemeld via het OS, met de app-launcher en een lijst notities.",
        caption: "Notes, de eerste ingebouwde app: aanmelden, rechten en de launcher komen van het OS.",
      },
    },
    roadmap: {
      P4: {
        title: "Events, afgewerkt",
        summary:
          "Een alleen-lezen live demo van core-api, Admin en Notes, en TLS en operator-modus voor de eventbus, nu die in productie draait.",
      },
      P6: {
        title: "Observeerbaarheid",
        summary:
          "Metrics, traces en logs op één plek met dashboards, alerts op traces en metrics, en een publiek statusbord.",
      },
      P7: {
        title: "AI-hulp",
        summary:
          "AI-hulp waar tekstvergelijking niet ver genoeg kijkt: het manifest van een nieuwe app opstellen, een grondigere manifestreview, semantisch zoeken in events en een alleen-lezen copiloot in de beheerconsole.",
      },
      "Flow slice 3": {
        title: "Geplande workflows",
        summary: "Workflows die volgens een schema starten, en nieuwe workflows die eerst als proefdraai lopen.",
      },
    },
    links: {
      "https://github.com/AliSafari-IT/asafarim-os": "GitHub-repository",
      "https://asafarim.com/": "asafarim.com",
    },
  },
  fr: {
    apps: {
      identity: {
        tagline: "Une seule connexion pour chaque application",
        summary:
          "Connectez-vous une fois avec un code par e-mail, une clé d’accès ou Google, et chaque application de l’OS sait qui vous êtes. Une nouvelle personne demande l’accès aux applications dont elle a besoin, avec un mot d’explication, et un administrateur approuve.",
        surfaces: [{ kind: "Application web", note: "Connexion, votre compte et les demandes d’accès." }],
      },
      docs: {
        tagline: "Lire votre documentation, prendre des notes",
        summary:
          "Un lecteur privé pour les dépôts de documentation : lisez le Markdown, gardez-y des notes d’étude et transformez une note en issue GitHub dans le dépôt auquel appartient le document.",
        surfaces: [
          { kind: "Application web", note: "Pour les personnes à qui un administrateur a donné un rôle Docs." },
        ],
      },
      flow: {
        tagline: "Des workflows déclenchés par des événements",
        summary:
          "Construisez un workflow visuellement, lancez-le depuis un événement de l’OS, un webhook ou GitHub, et laissez des personnes approuver ou refuser une étape avant qu’il continue. Six connecteurs, un coffre chiffré pour les identifiants, et des brouillons rédigés par Claude à partir d’une issue, qui ne s’exécutent jamais d’eux-mêmes.",
        surfaces: [
          { kind: "Application web", note: "Pour les personnes à qui un administrateur a donné un rôle Flow." },
        ],
      },
      admin: {
        tagline: "Piloter l’OS",
        summary:
          "Les applications installées et leur état, les rôles et attributions, les demandes d’accès, et un seul centre d’audit pour les connexions, les décisions d’accès et les modifications des administrateurs.",
        surfaces: [{ kind: "Application web", note: "Réservée aux administrateurs, donc pas de lien ici." }],
      },
      notes: {
        tagline: "L’application de référence",
        summary:
          "La plus petite application qui montre le contrat de bout en bout : un manifeste, sa propre base de données, son enregistrement, la connexion via Identity, des rôles attribués par un administrateur.",
        surfaces: [
          {
            kind: "Exemple",
            address: "Développement local",
            note: "Tourne dans l’environnement de développement ; pas déployée.",
          },
        ],
      },
      "igs-pharma": {
        tagline: "Une pharmacie en ligne pour la Belgique",
        summary:
          "Construite avec une pharmacie belge : un webshop de produits sans ordonnance avec un pharmacien dans la boucle, un back-office pour l’équipe de la pharmacie et une application Android gratuite. Son propre code et son propre domaine, dans le style de l’OS ; la page du projet est servie par l’OS.",
        surfaces: [
          {
            kind: "Site web",
            note: "Le projet, en néerlandais, français, allemand et anglais, avec les pages de confidentialité de l’application.",
          },
          {
            kind: "Webshop",
            note: "Fermé jusqu’au lancement : les clients que la pharmacie invite ou approuve le voient déjà.",
          },
          {
            kind: "Application Android",
            note: "Parcourir, chercher, scanner un emballage et tenir une liste ; les commandes passent par le webshop. En test interne.",
          },
          {
            kind: "Back-office",
            address: "Personnel de la pharmacie",
            note: "Catalogue, prix, stock et rappels, commandes, livraison et accès anticipé, derrière une clé d’accès.",
          },
        ],
      },
      breinhap: {
        tagline: "De courtes missions d’étude pour le secondaire",
        summary:
          "Une application d’étude pour les élèves du secondaire en Flandre, conçue en pensant au TDAH et à l’AuDHD : des missions de 2 à 6 minutes, toujours dans les mêmes quatre étapes.",
        surfaces: [
          {
            kind: "Présentation Android",
            note: "Ce qu’est l’application, en néerlandais et en anglais, avec ses pages de confidentialité.",
          },
          {
            kind: "Application web",
            note: "Présentation publique et pages de connexion et d’inscription pour les adultes ; les missions dans le navigateur ne sont pas encore disponibles.",
          },
          {
            kind: "Gestion Breinhap",
            note: "Pilote sur invitation pour des adultes ASafariM actifs avec un accès explicite à Breinhap.",
          },
          { kind: "Application Android", note: "En test fermé avant son ouverture à tous." },
        ],
      },
    },
    screenshots: {
      "admin-apps.png": {
        title: "Applications",
        alt: "La page Applications de la console d’administration, avec le noyau intégré et l’application Notes, leur état de cycle de vie et leurs actions.",
        caption:
          "Chaque application installée avec son état de cycle de vie : l’activer, la désactiver ou la supprimer.",
      },
      "admin-app-roles.png": {
        title: "Rôles et attributions d’une application",
        alt: "La page Rôles et attributions de la console d’administration pour l’application Notes, avec les rôles que Notes déclare, leurs autorisations et qui les détient.",
        caption:
          "Les rôles et autorisations qu’une application déclare, et qui les détient. Enregistrer une application n’attribue rien.",
      },
      "admin-events.png": {
        title: "Événements",
        alt: "La page Événements de la console d’administration, avec les types d’événements publiés par les applications, leur éditeur, leurs abonnés et leur schéma.",
        caption: "Le catalogue des événements : chaque type avec son éditeur, ses abonnés et son schéma.",
      },
      "admin-status.png": {
        title: "Statut",
        alt: "La page Statut de la console d’administration, avec core-api et l’application Notes, leurs contrôles live et ready marqués Up, la latence et l’heure du dernier contrôle.",
        caption:
          "Le tableau de statut : core-api contrôle les points live et ready de chaque application active, d’après son manifeste.",
      },
      "notes.png": {
        title: "Notes",
        alt: "L’application Notes, connectée via l’OS, avec son lanceur d’applications et une liste de notes.",
        caption:
          "Notes, la première application intégrée : la connexion, les autorisations et le lanceur viennent de l’OS.",
      },
    },
    roadmap: {
      P4: {
        title: "Événements, terminés",
        summary:
          "Une démo en direct en lecture seule de core-api, Admin et Notes, et le TLS et le mode opérateur pour le bus d’événements, maintenant qu’il tourne en production.",
      },
      P6: {
        title: "Observabilité",
        summary:
          "Métriques, traces et journaux au même endroit avec des tableaux de bord, des alertes sur les traces et les métriques, et un tableau de statut public.",
      },
      P7: {
        title: "Aide de l’IA",
        summary:
          "De l’aide de l’IA là où la comparaison de texte ne voit pas : rédiger le manifeste d’une nouvelle application, une revue de manifeste plus poussée, une recherche sémantique dans les événements et un copilote en lecture seule dans la console d’administration.",
      },
      "Flow slice 3": {
        title: "Workflows planifiés",
        summary:
          "Des workflows qui démarrent selon un calendrier, et de nouveaux workflows qui s’exécutent d’abord à blanc.",
      },
    },
    links: { "https://github.com/AliSafari-IT/asafarim-os": "Dépôt GitHub", "https://asafarim.com/": "asafarim.com" },
  },
  de: {
    apps: {
      identity: {
        tagline: "Eine Anmeldung für jede App",
        summary:
          "Melden Sie sich einmal mit einem E-Mail-Code, einem Passkey oder Google an, und jede OS-App weiß, wer Sie sind. Wer neu ist, beantragt mit einer kurzen Notiz Zugang zu den Apps, die er braucht, und ein Administrator genehmigt.",
        surfaces: [{ kind: "Web-App", note: "Anmeldung, Ihr Konto und Zugangsanfragen." }],
      },
      docs: {
        tagline: "Ihre Dokumentation lesen, Notizen machen",
        summary:
          "Ein privater Reader für Dokumentations-Repositories: Lesen Sie das Markdown, führen Sie Lernnotizen dazu und machen Sie aus einer Notiz ein GitHub-Issue im Repository, zu dem das Dokument gehört.",
        surfaces: [{ kind: "Web-App", note: "Für Personen, denen ein Administrator eine Docs-Rolle gegeben hat." }],
      },
      flow: {
        tagline: "Workflows, die auf Events laufen",
        summary:
          "Bauen Sie einen Workflow visuell, starten Sie ihn über ein OS-Event, einen Webhook oder GitHub, und lassen Sie Menschen einen Schritt genehmigen oder ablehnen, bevor es weitergeht. Sechs Konnektoren, ein verschlüsselter Speicher für Zugangsdaten und Entwürfe, die Claude aus einem Issue schreibt und die nie von selbst laufen.",
        surfaces: [{ kind: "Web-App", note: "Für Personen, denen ein Administrator eine Flow-Rolle gegeben hat." }],
      },
      admin: {
        tagline: "Das OS verwalten",
        summary:
          "Die installierten Apps und ihr Zustand, Rollen und Zuweisungen, Zugangsanfragen und ein Audit-Center für Anmeldungen, Zugangsentscheidungen und Änderungen durch Administratoren.",
        surfaces: [{ kind: "Web-App", note: "Nur für Administratoren, daher hier nicht verlinkt." }],
      },
      notes: {
        tagline: "Die Referenz-App",
        summary:
          "Die kleinste App, die den Vertrag von Anfang bis Ende zeigt: ein Manifest, eine eigene Datenbank, die Selbstregistrierung, die Anmeldung über Identity und Rollen, die ein Administrator vergibt.",
        surfaces: [
          {
            kind: "Beispiel",
            address: "Lokale Entwicklung",
            note: "Läuft in der Entwicklungsumgebung; nicht bereitgestellt.",
          },
        ],
      },
      "igs-pharma": {
        tagline: "Eine Online-Apotheke für Belgien",
        summary:
          "Gebaut mit einer belgischen Apotheke: ein Webshop für rezeptfreie Produkte mit einem Apotheker, der mitschaut, ein Back-Office für das Apothekenteam und eine kostenlose Android-App. Eigener Code und eigene Domain, im Stil des OS; die Projektseite wird vom OS ausgeliefert.",
        surfaces: [
          {
            kind: "Website",
            note: "Das Projekt, auf Niederländisch, Französisch, Deutsch und Englisch, mit den Datenschutzseiten der App.",
          },
          {
            kind: "Webshop",
            note: "Bis zum Start geschlossen: Kunden, die die Apotheke einlädt oder freigibt, sehen ihn schon.",
          },
          {
            kind: "Android-App",
            note: "Stöbern, suchen, eine Packung scannen und eine Liste führen; Bestellungen gehen über den Webshop. Im internen Test.",
          },
          {
            kind: "Back-Office",
            address: "Apothekenpersonal",
            note: "Katalog, Preise, Bestand und Rückrufe, Bestellungen, Lieferung und früher Zugang, hinter einem Passkey.",
          },
        ],
      },
      breinhap: {
        tagline: "Kurze Lernmissionen für die Sekundarschule",
        summary:
          "Eine Lern-App für Schülerinnen und Schüler der Sekundarschule in Flandern, gestaltet mit Blick auf ADHS und AuDHS: Missionen von 2 bis 6 Minuten, immer in denselben vier Schritten.",
        surfaces: [
          {
            kind: "Android-Vorstellung",
            note: "Was die App ist, auf Niederländisch und Englisch, mit ihren Datenschutzseiten.",
          },
          {
            kind: "Web-App",
            note: "Öffentliche Vorstellung und Anmelde- und Registrierungsseiten für Erwachsene; Missionen im Browser gibt es noch nicht.",
          },
          {
            kind: "Breinhap-Verwaltung",
            note: "Pilot auf Einladung für aktive ASafariM-Erwachsene mit ausdrücklichem Zugang zu Breinhap.",
          },
          { kind: "Android-App", note: "In einem geschlossenen Test, bevor sie für alle öffnet." },
        ],
      },
    },
    screenshots: {
      "admin-apps.png": {
        title: "Apps",
        alt: "Die Seite Apps der Admin-Konsole mit dem eingebauten Kern und der Notes-App, ihrem Lebenszyklus-Zustand und ihren Aktionen.",
        caption: "Jede installierte App mit ihrem Lebenszyklus-Zustand: aktivieren, deaktivieren oder entfernen.",
      },
      "admin-app-roles.png": {
        title: "Rollen und Zuweisungen einer App",
        alt: "Die Seite Rollen und Zuweisungen der Admin-Konsole für die Notes-App, mit den Rollen, die Notes deklariert, ihren Berechtigungen und wer sie hat.",
        caption:
          "Die Rollen und Berechtigungen, die eine App deklariert, und wer sie hat. Eine App zu registrieren, vergibt nichts.",
      },
      "admin-events.png": {
        title: "Events",
        alt: "Die Seite Events der Admin-Konsole mit den Event-Typen, die Apps veröffentlichen, ihrem Herausgeber, ihren Abonnenten und ihrem Schema.",
        caption: "Der Event-Katalog: jeder Event-Typ mit Herausgeber, Abonnenten und Schema.",
      },
      "admin-status.png": {
        title: "Status",
        alt: "Die Seite Status der Admin-Konsole mit core-api und der Notes-App, ihren Live- und Ready-Checks als Up, der Latenz und dem Zeitpunkt der letzten Prüfung.",
        caption:
          "Die Statusübersicht: core-api prüft die Live- und Ready-Endpunkte jeder aktiven App laut ihrem Manifest.",
      },
      "notes.png": {
        title: "Notes",
        alt: "Die Notes-App, über das OS angemeldet, mit ihrem App-Launcher und einer Liste von Notizen.",
        caption: "Notes, die erste eingebaute App: Anmeldung, Berechtigungen und Launcher kommen vom OS.",
      },
    },
    roadmap: {
      P4: {
        title: "Events, fertig",
        summary:
          "Eine schreibgeschützte Live-Demo von core-api, Admin und Notes, sowie TLS und Operator-Modus für den Event-Bus, jetzt, wo er in Produktion läuft.",
      },
      P6: {
        title: "Beobachtbarkeit",
        summary:
          "Metriken, Traces und Logs an einem Ort mit Dashboards, Alarmen auf Traces und Metriken und einer öffentlichen Statusübersicht.",
      },
      P7: {
        title: "KI-Unterstützung",
        summary:
          "KI-Hilfe, wo Textvergleich nicht weit genug sieht: das Manifest einer neuen App entwerfen, eine gründlichere Manifest-Prüfung, semantische Suche in Events und ein schreibgeschützter Copilot in der Admin-Konsole.",
      },
      "Flow slice 3": {
        title: "Geplante Workflows",
        summary: "Workflows, die nach Zeitplan starten, und neue Workflows, die zuerst als Probelauf laufen.",
      },
    },
    links: {
      "https://github.com/AliSafari-IT/asafarim-os": "GitHub-Repository",
      "https://asafarim.com/": "asafarim.com",
    },
  },
};

/** The progress file with its apps, screenshots, roadmap and links in `locale` (English: unchanged). */
export function localizeProgress(progress: Progress, locale: Locale): Progress {
  if (locale === "en") return progress;
  const t = PROGRESS_TEXT[locale];
  const need = <T>(value: T | undefined, what: string): T => {
    if (value === undefined) throw new Error(`progress-i18n: no ${locale} text for ${what}`);
    return value;
  };
  const app = (a: App): App => {
    const text = need(t.apps[a.id], `app "${a.id}"`);
    if (text.surfaces.length !== a.surfaces.length)
      throw new Error(
        `progress-i18n: app "${a.id}" has ${a.surfaces.length} surfaces, the ${locale} text ${text.surfaces.length}`,
      );
    return {
      ...a,
      tagline: text.tagline,
      summary: text.summary,
      surfaces: a.surfaces.map((s, i) => {
        const st = text.surfaces[i]!;
        const href = s.href && Object.values(PRODUCT_HREFS).find((h) => h.en === s.href)?.[locale];
        return {
          ...s,
          kind: st.kind,
          address: st.address ?? s.address,
          note: st.note,
          ...(s.href ? { href: href ?? s.href } : {}),
        };
      }),
    };
  };
  return {
    ...progress,
    apps: progress.apps.map(app),
    screenshots: progress.screenshots.map((s) => ({ ...s, ...need(t.screenshots[s.file], `screenshot "${s.file}"`) })),
    roadmap: progress.roadmap.map((r) => ({ ...r, ...need(t.roadmap[r.id], `roadmap item "${r.id}"`) })),
    links: progress.links.map((l) => ({ ...l, label: need(t.links[l.href], `link ${l.href}`) })),
  };
}
