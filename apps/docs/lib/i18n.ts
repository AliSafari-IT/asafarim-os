/**
 * Docs in English, Dutch, French and German. Safe in client components (no server imports). The page's
 * language comes from @asafarim/locale (shared asafarim-locale cookie, then the browser, then English);
 * English is the default. The documents themselves, and error texts that come from the issue API, stay as
 * they are written. Permission and role names (`docs.read`) are identifiers and stay as they are.
 */
import type { Locale } from "@asafarim/locale";

export interface Messages {
  // sign-in / access
  signInIntro: string;
  signIn: string;
  signOut: string;
  signInFoot: string;
  noAccess: string;
  readingNeeds: string;
  askAdminFor: string;
  appIsBefore: string;
  appIsAfter: string;
  permissionsUnavailable: string;
  // top bar and reader
  skipToDocument: string;
  skipToNotes: string;
  localFixtures: string;
  refresh: string;
  allNotes: string;
  documents: string;
  onThisPage: string;
  openToSeeSections: string;
  nothingOpen: string;
  unavailable: string;
  ownersErrorTail: string;
  notFound: string;
  notInSource: string;
  breadcrumb: string;
  ownerFrom: (via: string) => string;
  minRead: (minutes: number) => string;
  words: (n: string) => string;
  previousNext: string;
  previous: string;
  next: string;
  documentation: string;
  welcome: string;
  documentsTitle: string;
  documentCount: (n: string, count: number) => string;
  searchWith: string;
  or: string;
  startHere: string;
  overview: string;
  sections: string;
  docsCount: (n: number) => string;
  moreInSidebar: (n: number) => string;
  topLevel: string;
  noDocuments: string;
  nothingOpenLead: string;
  // tree and search
  filterDocuments: string;
  noMatchDoc: string;
  noDocumentsYet: string;
  searchTitles: string;
  results: string;
  search: string;
  searchDocs: string;
  close: string;
  searchUnavailable: string;
  nothingMatches: string;
  searchHint: string;
  // notes
  yourNotes: string;
  notesUnavailable: string;
  noNotesYetPage: string;
  addNoteBold: string;
  document: string;
  allDocuments: string;
  show: string;
  notesPrivate: string;
  goneKept: string;
  wholeDocument: string;
  textChanged: string;
  textChangedWhy: string;
  selectedText: string;
  addNote: string;
  addANote: string;
  notes: string;
  noNotesOnDoc: string;
  selectToAdd: string;
  showInText: string;
  edit: string;
  delete: string;
  editNote: string;
  on: string;
  noteLabel: string;
  markdown: string;
  cancel: string;
  saveNote: string;
  saveNoteIssue: string;
  deleteTitle: string;
  deleteWarn: string;
  notSaved: string;
  // issues
  generateIssue: string;
  issuesNotSetUp: string;
  issueCreated: string;
  viaFlow: string;
  // diagrams
  diagram: string;
  diagramTitled: (title: string) => string;
  enlarge: string;
  scrollSideways: string;
  diagramFailed: string;
  issueNothing: string;
  issueDrafting: string;
  issueReady: string;
  tryAgain: string;
  targetRepo: string;
  ownerName: string;
  title: string;
  labels: string;
  noLabels: string;
  regenerate: string;
  createIssue: string;
  creating: string;
  secondIssue: string;
  alreadyIssue: string;
}

const EN: Messages = {
  signInIntro: "A private reader for documentation. Sign in with your ASafariM account.",
  signIn: "Sign in",
  signOut: "Sign out",
  signInFoot: "Only people who have been given access can read the documents.",
  noAccess: "You don't have access",
  readingNeeds: "Reading needs the permission",
  askAdminFor: "Ask an admin for the",
  appIsBefore: "This app is ",
  appIsAfter: ". An admin has to activate it.",
  permissionsUnavailable: "Permissions can't be checked right now (core-api is unreachable).",
  skipToDocument: "Skip to the document",
  skipToNotes: "Skip to the notes",
  localFixtures: "local fixtures",
  refresh: "Refresh",
  allNotes: "All notes",
  documents: "Documents",
  onThisPage: "On this page",
  openToSeeSections: "Open a document to see its sections here.",
  nothingOpen: "Nothing open.",
  unavailable: "Documents temporarily unavailable. Try Refresh in a minute.",
  ownersErrorTail: "is owned by the source repository until it's fixed",
  notFound: "Not found",
  notInSource: "isn't in the source repository (any more).",
  breadcrumb: "Breadcrumb",
  ownerFrom: (via) => `Owner (from ${via})`,
  minRead: (m) => `${m} min read`,
  words: (n) => `${n} words`,
  previousNext: "Previous and next document",
  previous: "Previous",
  next: "Next",
  documentation: "Documentation",
  welcome: "Welcome",
  documentsTitle: "Documents",
  documentCount: (n, c) => `${n} ${c === 1 ? "document" : "documents"} from`,
  searchWith: ", read live from the repository. Search with",
  or: "or",
  startHere: "Start here",
  overview: "The overview of this documentation.",
  sections: "Sections",
  docsCount: (n) => `${n} ${n === 1 ? "doc" : "docs"}`,
  moreInSidebar: (n) => `and ${n} more in the sidebar`,
  topLevel: "Also at the top level",
  noDocuments: "There are no documents in",
  nothingOpenLead:
    "Pick a document to read it here. Documents are loaded from the source repository when you open them; none are stored in this app.",
  filterDocuments: "Filter documents",
  noMatchDoc: "No document matches.",
  noDocumentsYet: "No documents yet.",
  searchTitles: "Search titles and headings",
  results: "Results",
  search: "Search",
  searchDocs: "Search the documents",
  close: "Close",
  searchUnavailable: "Search isn't available right now.",
  nothingMatches: "Nothing matches.",
  searchHint: "↑ ↓ to move, Enter to open, Esc to close.",
  yourNotes: "Your notes",
  notesUnavailable: "Notes aren't available right now.",
  noNotesYetPage: "No notes yet. Open a document, select some text and choose",
  addNoteBold: "Add note",
  document: "Document",
  allDocuments: "All documents",
  show: "Show",
  notesPrivate: "Notes are private: only you see them. Edit or delete a note on its document.",
  goneKept: "This document isn't in the source any more; its notes are kept.",
  wholeDocument: "The whole document",
  textChanged: "text changed",
  textChangedWhy: "The document changed: the text this note quoted isn't in it any more.",
  selectedText: "Selected text",
  addNote: "Add note",
  addANote: "Add a note",
  notes: "Notes",
  noNotesOnDoc: "No notes on this document yet.",
  selectToAdd: " Select some text, or point at a heading, to add one.",
  showInText: "Show in the text",
  edit: "Edit",
  delete: "Delete",
  editNote: "Edit note",
  on: "On",
  noteLabel: "Note",
  markdown: "(Markdown)",
  cancel: "Cancel",
  saveNote: "Save note",
  saveNoteIssue: "Save note and generate issue",
  deleteTitle: "Delete this note?",
  deleteWarn: "It can't be brought back.",
  notSaved: "The note couldn't be saved: the app isn't reachable.",
  generateIssue: "Generate GitHub issue",
  issuesNotSetUp: "Not set up yet: the server needs DOCS_AI_API_KEY and DOCS_ISSUES_TOKEN.",
  issueCreated: "Issue created ✓",
  viaFlow: "via Flow",
  diagram: "Diagram",
  diagramTitled: (t) => `Diagram: ${t}`,
  enlarge: "Enlarge",
  scrollSideways: "Scroll sideways to see all of it.",
  diagramFailed: "This diagram can't be drawn.",
  issueNothing: "Nothing is created until you choose Create issue.",
  issueDrafting: "Drafting the issue… (this can take up to a minute)",
  issueReady: "The draft is ready.",
  tryAgain: "Try again",
  targetRepo: "Target repository",
  ownerName: "(owner/name)",
  title: "Title",
  labels: "Labels",
  noLabels: "This repo has no labels.",
  regenerate: "Regenerate",
  createIssue: "Create issue",
  creating: "Creating…",
  secondIssue: "Yes, create a second issue",
  alreadyIssue: "This note already has an issue:",
};

const NL: Messages = {
  ...EN,
  signInIntro: "Een privélezer voor documentatie. Meld je aan met je ASafariM-account.",
  signIn: "Aanmelden",
  signOut: "Afmelden",
  signInFoot: "Alleen wie toegang heeft gekregen, kan de documenten lezen.",
  noAccess: "Je hebt geen toegang",
  readingNeeds: "Lezen vraagt de toestemming",
  askAdminFor: "Vraag een beheerder om de rol",
  appIsBefore: "Deze app is ",
  appIsAfter: ". Een beheerder moet ze activeren.",
  permissionsUnavailable: "De toestemmingen kunnen nu niet worden gecontroleerd (core-api is onbereikbaar).",
  skipToDocument: "Ga naar het document",
  skipToNotes: "Ga naar de notities",
  localFixtures: "lokale testdata",
  refresh: "Vernieuwen",
  allNotes: "Alle notities",
  documents: "Documenten",
  onThisPage: "Op deze pagina",
  openToSeeSections: "Open een document om hier de onderdelen te zien.",
  nothingOpen: "Niets geopend.",
  unavailable: "Documenten zijn tijdelijk niet beschikbaar. Probeer over een minuut te vernieuwen.",
  ownersErrorTail: "is van de bronrepository tot het is opgelost",
  notFound: "Niet gevonden",
  notInSource: "staat (niet meer) in de bronrepository.",
  breadcrumb: "Kruimelpad",
  ownerFrom: (via) => `Eigenaar (via ${via})`,
  minRead: (m) => `${m} min lezen`,
  words: (n) => `${n} woorden`,
  previousNext: "Vorig en volgend document",
  previous: "Vorige",
  next: "Volgende",
  documentation: "Documentatie",
  welcome: "Welkom",
  documentsTitle: "Documenten",
  documentCount: (n, c) => `${n} ${c === 1 ? "document" : "documenten"} uit`,
  searchWith: ", live gelezen uit de repository. Zoek met",
  or: "of",
  startHere: "Begin hier",
  overview: "Het overzicht van deze documentatie.",
  sections: "Onderdelen",
  docsCount: (n) => `${n} ${n === 1 ? "doc" : "docs"}`,
  moreInSidebar: (n) => `en nog ${n} in de zijbalk`,
  topLevel: "Ook op het hoogste niveau",
  noDocuments: "Er zijn nog geen documenten in",
  nothingOpenLead:
    "Kies een document om het hier te lezen. Documenten worden uit de bronrepository geladen wanneer je ze opent; niets wordt in deze app bewaard.",
  filterDocuments: "Documenten filteren",
  noMatchDoc: "Geen enkel document komt overeen.",
  noDocumentsYet: "Nog geen documenten.",
  searchTitles: "Zoek in titels en koppen",
  results: "Resultaten",
  search: "Zoeken",
  searchDocs: "Zoek in de documenten",
  close: "Sluiten",
  searchUnavailable: "Zoeken is nu niet beschikbaar.",
  nothingMatches: "Niets gevonden.",
  searchHint: "↑ ↓ om te bewegen, Enter om te openen, Esc om te sluiten.",
  yourNotes: "Je notities",
  notesUnavailable: "Notities zijn nu niet beschikbaar.",
  noNotesYetPage: "Nog geen notities. Open een document, selecteer wat tekst en kies",
  addNoteBold: "Notitie toevoegen",
  document: "Document",
  allDocuments: "Alle documenten",
  show: "Tonen",
  notesPrivate: "Notities zijn privé: alleen jij ziet ze. Bewerk of verwijder een notitie op het document zelf.",
  goneKept: "Dit document staat niet meer in de bron; de notities blijven bewaard.",
  wholeDocument: "Het hele document",
  textChanged: "tekst gewijzigd",
  textChangedWhy: "Het document is gewijzigd: de tekst die deze notitie citeerde, staat er niet meer in.",
  selectedText: "Geselecteerde tekst",
  addNote: "Notitie toevoegen",
  addANote: "Een notitie toevoegen",
  notes: "Notities",
  noNotesOnDoc: "Nog geen notities bij dit document.",
  selectToAdd: " Selecteer wat tekst of wijs een kop aan om er een toe te voegen.",
  showInText: "In de tekst tonen",
  edit: "Bewerken",
  delete: "Verwijderen",
  editNote: "Notitie bewerken",
  on: "Bij",
  noteLabel: "Notitie",
  markdown: "(Markdown)",
  cancel: "Annuleren",
  saveNote: "Notitie opslaan",
  saveNoteIssue: "Notitie opslaan en issue genereren",
  deleteTitle: "Deze notitie verwijderen?",
  deleteWarn: "Ze kan niet worden hersteld.",
  notSaved: "De notitie kon niet worden opgeslagen: de app is onbereikbaar.",
  generateIssue: "GitHub-issue genereren",
  issuesNotSetUp: "Nog niet ingesteld: de server heeft DOCS_AI_API_KEY en DOCS_ISSUES_TOKEN nodig.",
  issueCreated: "Issue aangemaakt ✓",
  viaFlow: "via Flow",
  diagram: "Diagram",
  diagramTitled: (t) => `Diagram: ${t}`,
  enlarge: "Vergroten",
  scrollSideways: "Scroll opzij om alles te zien.",
  diagramFailed: "Dit diagram kan niet worden getekend.",
  issueNothing: "Er wordt niets aangemaakt tot je Issue aanmaken kiest.",
  issueDrafting: "De issue wordt opgesteld… (dit kan tot een minuut duren)",
  issueReady: "Het concept is klaar.",
  tryAgain: "Opnieuw proberen",
  targetRepo: "Doelrepository",
  ownerName: "(eigenaar/naam)",
  title: "Titel",
  labels: "Labels",
  noLabels: "Deze repository heeft geen labels.",
  regenerate: "Opnieuw genereren",
  createIssue: "Issue aanmaken",
  creating: "Aanmaken…",
  secondIssue: "Ja, maak een tweede issue aan",
  alreadyIssue: "Deze notitie heeft al een issue:",
};

const FR: Messages = {
  ...EN,
  signInIntro: "Un lecteur privé de documentation. Connectez-vous avec votre compte ASafariM.",
  signIn: "Se connecter",
  signOut: "Se déconnecter",
  signInFoot: "Seules les personnes qui ont reçu l’accès peuvent lire les documents.",
  noAccess: "Vous n’avez pas accès",
  readingNeeds: "La lecture nécessite l’autorisation",
  askAdminFor: "Demandez à un administrateur le rôle",
  appIsBefore: "Cette application est ",
  appIsAfter: ". Un administrateur doit l’activer.",
  permissionsUnavailable: "Les autorisations ne peuvent pas être vérifiées pour le moment (core-api est injoignable).",
  skipToDocument: "Aller au document",
  skipToNotes: "Aller aux notes",
  localFixtures: "données de test locales",
  refresh: "Actualiser",
  allNotes: "Toutes les notes",
  documents: "Documents",
  onThisPage: "Sur cette page",
  openToSeeSections: "Ouvrez un document pour en voir les sections ici.",
  nothingOpen: "Rien d’ouvert.",
  unavailable: "Documents momentanément indisponibles. Essayez Actualiser dans une minute.",
  ownersErrorTail: "appartient au dépôt source tant que ce n’est pas corrigé",
  notFound: "Introuvable",
  notInSource: "n’est (plus) dans le dépôt source.",
  breadcrumb: "Fil d’Ariane",
  ownerFrom: (via) => `Propriétaire (via ${via})`,
  minRead: (m) => `${m} min de lecture`,
  words: (n) => `${n} mots`,
  previousNext: "Document précédent et suivant",
  previous: "Précédent",
  next: "Suivant",
  documentation: "Documentation",
  welcome: "Bienvenue",
  documentsTitle: "Documents",
  documentCount: (n, c) => `${n} ${c === 1 ? "document" : "documents"} de`,
  searchWith: ", lus en direct depuis le dépôt. Recherchez avec",
  or: "ou",
  startHere: "Commencer ici",
  overview: "Le survol de cette documentation.",
  sections: "Sections",
  docsCount: (n) => `${n} ${n === 1 ? "doc" : "docs"}`,
  moreInSidebar: (n) => `et ${n} de plus dans la barre latérale`,
  topLevel: "Aussi au premier niveau",
  noDocuments: "Il n’y a pas encore de documents dans",
  nothingOpenLead:
    "Choisissez un document pour le lire ici. Les documents sont chargés depuis le dépôt source à l’ouverture ; rien n’est stocké dans cette application.",
  filterDocuments: "Filtrer les documents",
  noMatchDoc: "Aucun document ne correspond.",
  noDocumentsYet: "Pas encore de documents.",
  searchTitles: "Rechercher dans les titres et intertitres",
  results: "Résultats",
  search: "Rechercher",
  searchDocs: "Rechercher dans les documents",
  close: "Fermer",
  searchUnavailable: "La recherche n’est pas disponible pour le moment.",
  nothingMatches: "Aucun résultat.",
  searchHint: "↑ ↓ pour se déplacer, Entrée pour ouvrir, Échap pour fermer.",
  yourNotes: "Vos notes",
  notesUnavailable: "Les notes ne sont pas disponibles pour le moment.",
  noNotesYetPage: "Pas encore de notes. Ouvrez un document, sélectionnez du texte et choisissez",
  addNoteBold: "Ajouter une note",
  document: "Document",
  allDocuments: "Tous les documents",
  show: "Afficher",
  notesPrivate: "Les notes sont privées : vous seul les voyez. Modifiez ou supprimez une note sur son document.",
  goneKept: "Ce document n’est plus dans la source ; ses notes sont conservées.",
  wholeDocument: "Tout le document",
  textChanged: "texte modifié",
  textChangedWhy: "Le document a changé : le texte cité par cette note n’y figure plus.",
  selectedText: "Texte sélectionné",
  addNote: "Ajouter une note",
  addANote: "Ajouter une note",
  notes: "Notes",
  noNotesOnDoc: "Pas encore de notes sur ce document.",
  selectToAdd: " Sélectionnez du texte ou pointez un titre pour en ajouter une.",
  showInText: "Afficher dans le texte",
  edit: "Modifier",
  delete: "Supprimer",
  editNote: "Modifier la note",
  on: "Sur",
  noteLabel: "Note",
  markdown: "(Markdown)",
  cancel: "Annuler",
  saveNote: "Enregistrer la note",
  saveNoteIssue: "Enregistrer la note et générer l’issue",
  deleteTitle: "Supprimer cette note ?",
  deleteWarn: "Elle ne pourra pas être récupérée.",
  notSaved: "La note n’a pas pu être enregistrée : l’application est injoignable.",
  generateIssue: "Générer une issue GitHub",
  issuesNotSetUp: "Pas encore configuré : le serveur a besoin de DOCS_AI_API_KEY et DOCS_ISSUES_TOKEN.",
  issueCreated: "Issue créée ✓",
  viaFlow: "via Flow",
  diagram: "Diagramme",
  diagramTitled: (t) => `Diagramme : ${t}`,
  enlarge: "Agrandir",
  scrollSideways: "Faites défiler latéralement pour tout voir.",
  diagramFailed: "Ce diagramme ne peut pas être dessiné.",
  issueNothing: "Rien n’est créé tant que vous ne choisissez pas Créer l’issue.",
  issueDrafting: "Rédaction de l’issue… (cela peut prendre jusqu’à une minute)",
  issueReady: "Le brouillon est prêt.",
  tryAgain: "Réessayer",
  targetRepo: "Dépôt cible",
  ownerName: "(propriétaire/nom)",
  title: "Titre",
  labels: "Étiquettes",
  noLabels: "Ce dépôt n’a pas d’étiquettes.",
  regenerate: "Régénérer",
  createIssue: "Créer l’issue",
  creating: "Création…",
  secondIssue: "Oui, créer une deuxième issue",
  alreadyIssue: "Cette note a déjà une issue :",
};

const DE: Messages = {
  ...EN,
  signInIntro: "Ein privater Reader für Dokumentation. Melden Sie sich mit Ihrem ASafariM-Konto an.",
  signIn: "Anmelden",
  signOut: "Abmelden",
  signInFoot: "Nur wer Zugang erhalten hat, kann die Dokumente lesen.",
  noAccess: "Sie haben keinen Zugriff",
  readingNeeds: "Zum Lesen ist die Berechtigung nötig:",
  askAdminFor: "Bitten Sie einen Administrator um die Rolle",
  appIsBefore: "Diese App ist ",
  appIsAfter: ". Ein Administrator muss sie aktivieren.",
  permissionsUnavailable: "Die Berechtigungen können gerade nicht geprüft werden (core-api ist nicht erreichbar).",
  skipToDocument: "Zum Dokument springen",
  skipToNotes: "Zu den Notizen springen",
  localFixtures: "lokale Testdaten",
  refresh: "Aktualisieren",
  allNotes: "Alle Notizen",
  documents: "Dokumente",
  onThisPage: "Auf dieser Seite",
  openToSeeSections: "Öffnen Sie ein Dokument, um hier seine Abschnitte zu sehen.",
  nothingOpen: "Nichts geöffnet.",
  unavailable: "Dokumente vorübergehend nicht verfügbar. Versuchen Sie in einer Minute Aktualisieren.",
  ownersErrorTail: "gehört dem Quell-Repository, bis es behoben ist",
  notFound: "Nicht gefunden",
  notInSource: "ist (nicht mehr) im Quell-Repository.",
  breadcrumb: "Brotkrumenpfad",
  ownerFrom: (via) => `Eigentümer (über ${via})`,
  minRead: (m) => `${m} Min. Lesezeit`,
  words: (n) => `${n} Wörter`,
  previousNext: "Vorheriges und nächstes Dokument",
  previous: "Zurück",
  next: "Weiter",
  documentation: "Dokumentation",
  welcome: "Willkommen",
  documentsTitle: "Dokumente",
  documentCount: (n, c) => `${n} ${c === 1 ? "Dokument" : "Dokumente"} aus`,
  searchWith: ", live aus dem Repository gelesen. Suchen mit",
  or: "oder",
  startHere: "Hier beginnen",
  overview: "Der Überblick über diese Dokumentation.",
  sections: "Abschnitte",
  docsCount: (n) => `${n} ${n === 1 ? "Dok." : "Dok."}`,
  moreInSidebar: (n) => `und ${n} weitere in der Seitenleiste`,
  topLevel: "Auch auf oberster Ebene",
  noDocuments: "Es gibt noch keine Dokumente in",
  nothingOpenLead:
    "Wählen Sie ein Dokument, um es hier zu lesen. Dokumente werden beim Öffnen aus dem Quell-Repository geladen; nichts wird in dieser App gespeichert.",
  filterDocuments: "Dokumente filtern",
  noMatchDoc: "Kein Dokument passt.",
  noDocumentsYet: "Noch keine Dokumente.",
  searchTitles: "Titel und Überschriften durchsuchen",
  results: "Ergebnisse",
  search: "Suchen",
  searchDocs: "Dokumente durchsuchen",
  close: "Schließen",
  searchUnavailable: "Die Suche ist gerade nicht verfügbar.",
  nothingMatches: "Nichts gefunden.",
  searchHint: "↑ ↓ zum Bewegen, Enter zum Öffnen, Esc zum Schließen.",
  yourNotes: "Ihre Notizen",
  notesUnavailable: "Notizen sind gerade nicht verfügbar.",
  noNotesYetPage: "Noch keine Notizen. Öffnen Sie ein Dokument, markieren Sie Text und wählen Sie",
  addNoteBold: "Notiz hinzufügen",
  document: "Dokument",
  allDocuments: "Alle Dokumente",
  show: "Anzeigen",
  notesPrivate: "Notizen sind privat: nur Sie sehen sie. Bearbeiten oder löschen Sie eine Notiz an ihrem Dokument.",
  goneKept: "Dieses Dokument ist nicht mehr in der Quelle; seine Notizen bleiben erhalten.",
  wholeDocument: "Das ganze Dokument",
  textChanged: "Text geändert",
  textChangedWhy: "Das Dokument hat sich geändert: der von dieser Notiz zitierte Text steht nicht mehr darin.",
  selectedText: "Markierter Text",
  addNote: "Notiz hinzufügen",
  addANote: "Notiz hinzufügen",
  notes: "Notizen",
  noNotesOnDoc: "Noch keine Notizen zu diesem Dokument.",
  selectToAdd: " Markieren Sie Text oder zeigen Sie auf eine Überschrift, um eine hinzuzufügen.",
  showInText: "Im Text anzeigen",
  edit: "Bearbeiten",
  delete: "Löschen",
  editNote: "Notiz bearbeiten",
  on: "Zu",
  noteLabel: "Notiz",
  markdown: "(Markdown)",
  cancel: "Abbrechen",
  saveNote: "Notiz speichern",
  saveNoteIssue: "Notiz speichern und Issue erzeugen",
  deleteTitle: "Diese Notiz löschen?",
  deleteWarn: "Sie kann nicht wiederhergestellt werden.",
  notSaved: "Die Notiz konnte nicht gespeichert werden: die App ist nicht erreichbar.",
  generateIssue: "GitHub-Issue erzeugen",
  issuesNotSetUp: "Noch nicht eingerichtet: der Server braucht DOCS_AI_API_KEY und DOCS_ISSUES_TOKEN.",
  issueCreated: "Issue erstellt ✓",
  viaFlow: "über Flow",
  diagram: "Diagramm",
  diagramTitled: (t) => `Diagramm: ${t}`,
  enlarge: "Vergrößern",
  scrollSideways: "Zur Seite scrollen, um alles zu sehen.",
  diagramFailed: "Dieses Diagramm kann nicht gezeichnet werden.",
  issueNothing: "Es wird nichts erstellt, bevor Sie Issue erstellen wählen.",
  issueDrafting: "Das Issue wird entworfen … (das kann bis zu einer Minute dauern)",
  issueReady: "Der Entwurf ist fertig.",
  tryAgain: "Erneut versuchen",
  targetRepo: "Ziel-Repository",
  ownerName: "(Eigentümer/Name)",
  title: "Titel",
  labels: "Labels",
  noLabels: "Dieses Repository hat keine Labels.",
  regenerate: "Neu erzeugen",
  createIssue: "Issue erstellen",
  creating: "Wird erstellt …",
  secondIssue: "Ja, ein zweites Issue erstellen",
  alreadyIssue: "Zu dieser Notiz gibt es bereits ein Issue:",
};

export const MESSAGES: Readonly<Record<Locale, Messages>> = { en: EN, nl: NL, fr: FR, de: DE };

export const messagesFor = (locale: Locale): Messages => MESSAGES[locale] ?? EN;
