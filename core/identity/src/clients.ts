/**
 * OIDC clients, from a JSON config file (later generated from the app
 * manifests, P3). Policy (ADR 0002, A5): authorization code flow only, every
 * redirect/logout URI on the app's primary domain, secrets from env only.
 *
 * {
 *   "clients": [{
 *     "client_id": "testora",
 *     "primary_domain": "testora.cloud",
 *     "redirect_uris": ["https://testora.cloud/api/auth/callback/asafarim"],
 *     "post_logout_redirect_uris": ["https://testora.cloud/"],
 *     "backchannel_logout_uri": "https://testora.cloud/api/auth/backchannel-logout",
 *     "client_secret_env": "IDENTITY_CLIENT_SECRET_TESTORA",    // omit for a public client
 *     "name": "Testora",                                        // optional: list it on /account
 *     "description": "Generate and run test plans."            // optional, with name
 *   }]
 * }
 */
export interface ClientEntry {
  client_id: string;
  primary_domain: string;
  redirect_uris: string[];
  post_logout_redirect_uris?: string[];
  backchannel_logout_uri?: string;
  client_secret_env?: string;
  /** Shown on the account page's "Where to next" when set. A client without one (a test client) isn't listed. */
  name?: string;
  description?: string;
}

/** An app a signed-in person can go on to from the account page. */
export interface AppLink {
  /** The client id: what an access request names. */
  id: string;
  name: string;
  href: string;
  description?: string;
}

export interface ClientConfigFile {
  clients: ClientEntry[];
}

/** The oidc-provider client metadata we produce. */
export interface OidcClient {
  client_id: string;
  client_secret?: string;
  token_endpoint_auth_method: "client_secret_basic" | "none";
  redirect_uris: string[];
  post_logout_redirect_uris: string[];
  backchannel_logout_uri?: string;
  backchannel_logout_session_required?: boolean;
  grant_types: string[];
  response_types: string[];
  id_token_signed_response_alg: "ES256";
}

const CLIENT_ID = /^[a-z][a-z0-9-]{1,62}$/;

export class ClientConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientConfigError";
  }
}

function checkUri(clientId: string, field: string, uri: string, domain: string, allowLocalhost: boolean) {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    throw new ClientConfigError(`${clientId}: ${field} "${uri}" isn't a URL`);
  }
  if (u.hash) throw new ClientConfigError(`${clientId}: ${field} must not have a fragment`);
  // Local development only: localhost, 127.0.0.1 and any *.localhost (the OS dev gateway serves each
  // app at <id>.localhost). A look-alike such as localhost.evil.example or evillocalhost isn't local.
  const local =
    allowLocalhost && (u.hostname === "localhost" || u.hostname.endsWith(".localhost") || u.hostname === "127.0.0.1");
  if (local) return;
  if (u.protocol !== "https:") throw new ClientConfigError(`${clientId}: ${field} must be https`);
  if (u.hostname !== domain) {
    throw new ClientConfigError(`${clientId}: ${field} must be on the primary domain ${domain}, not ${u.hostname}`);
  }
}

export function loadClients(
  file: ClientConfigFile,
  env: Record<string, string | undefined>,
  { allowLocalhost = false }: { allowLocalhost?: boolean } = {},
): OidcClient[] {
  if (!file || !Array.isArray(file.clients)) throw new ClientConfigError('the client config needs a "clients" array');
  const seen = new Set<string>();
  return file.clients.map((c) => {
    if (!CLIENT_ID.test(c.client_id ?? "")) throw new ClientConfigError(`invalid client_id "${c.client_id}"`);
    if (seen.has(c.client_id)) throw new ClientConfigError(`duplicate client_id ${c.client_id}`);
    seen.add(c.client_id);
    if (!c.primary_domain) throw new ClientConfigError(`${c.client_id}: primary_domain is required`);
    if (!c.redirect_uris?.length) throw new ClientConfigError(`${c.client_id}: at least one redirect_uri is required`);

    for (const uri of c.redirect_uris) checkUri(c.client_id, "redirect_uri", uri, c.primary_domain, allowLocalhost);
    for (const uri of c.post_logout_redirect_uris ?? [])
      checkUri(c.client_id, "post_logout_redirect_uri", uri, c.primary_domain, allowLocalhost);
    if (c.backchannel_logout_uri)
      checkUri(c.client_id, "backchannel_logout_uri", c.backchannel_logout_uri, c.primary_domain, allowLocalhost);

    let secret: string | undefined;
    if (c.client_secret_env) {
      secret = env[c.client_secret_env];
      if (!secret || secret.length < 32) {
        throw new ClientConfigError(
          `${c.client_id}: ${c.client_secret_env} must be set to a secret of at least 32 characters`,
        );
      }
    }

    return {
      client_id: c.client_id,
      ...(secret ? { client_secret: secret } : {}),
      token_endpoint_auth_method: secret ? "client_secret_basic" : "none",
      redirect_uris: c.redirect_uris,
      post_logout_redirect_uris: c.post_logout_redirect_uris ?? [],
      ...(c.backchannel_logout_uri
        ? { backchannel_logout_uri: c.backchannel_logout_uri, backchannel_logout_session_required: true }
        : {}),
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      id_token_signed_response_alg: "ES256",
    };
  });
}

/**
 * The apps the account page offers ("Where to next"): every client with a `name`, in file order, at its
 * first post-logout URI (its home page) or else https://<primary_domain>/. Call after loadClients, which
 * has already checked those URIs. Listing grants nothing: whether the person may open an app is core-api's.
 */
export function appLinks(file: ClientConfigFile): AppLink[] {
  const links: AppLink[] = [];
  for (const c of file.clients) {
    if (c.name === undefined) continue;
    if (typeof c.name !== "string" || !c.name.trim() || c.name.length > 60) {
      throw new ClientConfigError(`${c.client_id}: name must be 1 to 60 characters`);
    }
    if (c.description !== undefined && (typeof c.description !== "string" || c.description.length > 160)) {
      throw new ClientConfigError(`${c.client_id}: description must be at most 160 characters`);
    }
    links.push({
      id: c.client_id,
      name: c.name.trim(),
      href: c.post_logout_redirect_uris?.[0] ?? `https://${c.primary_domain}/`,
      ...(c.description ? { description: c.description } : {}),
    });
  }
  return links;
}
