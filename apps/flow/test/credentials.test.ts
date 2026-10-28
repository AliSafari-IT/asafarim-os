/**
 * The credential store: AES-256-GCM with the id as AAD (a ciphertext moved to another credential
 * doesn't open), key versions and the rotation that re-encrypts everything under a new key, a missing
 * or invalid FLOW_CREDENTIALS_KEY (no crash: `credentials_unavailable`), the three kinds, the webhook
 * secret returned once, and useCredential (decrypts, last_used_at, `credential_kind_mismatch`).
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CredentialError,
  decodeKey,
  keyringFromEnv,
  open,
  reencryptAll,
  seal,
  type Keyring,
} from "../lib/credentials/cipher";
import {
  createCredential,
  credentialsAvailable,
  deleteCredential,
  listCredentials,
  rotateCredential,
  useCredential,
} from "../lib/credentials/store";
import { memoryCredentials } from "./memory-credentials";

const KEY1 = randomBytes(32).toString("base64");
const KEY2 = randomBytes(32).toString("base64");
const keyring = (env: Record<string, string>): Keyring => {
  const s = keyringFromEnv(env);
  if (!s.ok) throw new Error(`no keyring: ${s.reason}`);
  return s.keyring;
};
const K1 = keyring({ FLOW_CREDENTIALS_KEY: KEY1 });

const SMTP = {
  kind: "smtp",
  name: "Mail",
  meta: { host: "smtp.example.com", port: "587", mode: "starttls", from: "flow@example.com" },
  secret: { username: "flow", password: "smtp-pa55" },
};
const GITHUB = {
  kind: "github-token",
  name: "GitHub",
  meta: { repos: ["AliSafari-IT/asafarim-docs"] },
  secret: { token: "ghp_example0123" },
};

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof CredentialError) return err.code;
    throw err;
  }
  return "no error";
}

describe("the key", () => {
  it("is base64 of exactly 32 bytes", () => {
    expect(decodeKey(KEY1)?.length).toBe(32);
    for (const bad of [
      undefined,
      "",
      "abc",
      randomBytes(16).toString("base64"),
      randomBytes(33).toString("base64"),
      `${KEY1.slice(0, -1)}!`,
    ])
      expect(decodeKey(bad)).toBeUndefined();
  });

  it("missing or invalid: unavailable, not a crash", () => {
    expect(keyringFromEnv({})).toEqual({ ok: false, reason: "missing" });
    expect(keyringFromEnv({ FLOW_CREDENTIALS_KEY: "  " })).toEqual({ ok: false, reason: "missing" });
    expect(keyringFromEnv({ FLOW_CREDENTIALS_KEY: "not-a-key" })).toEqual({ ok: false, reason: "invalid" });
    expect(keyringFromEnv({ FLOW_CREDENTIALS_KEY: KEY1, FLOW_CREDENTIALS_KEY_VERSION: "0" })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(keyringFromEnv({ FLOW_CREDENTIALS_KEY: KEY1, FLOW_CREDENTIALS_PREVIOUS_KEYS: "1:short" })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(credentialsAvailable({})).toBe(false);
    expect(credentialsAvailable({ FLOW_CREDENTIALS_KEY: KEY1 })).toBe(true);
  });

  it("without a key the store refuses, naming credentials_unavailable", async () => {
    const { db } = memoryCredentials();
    expect(await createCredential(db, SMTP, "dev-owner", undefined)).toMatchObject({
      ok: false,
      error: "credentials_unavailable",
    });
    expect(await rotateCredential(db, "x", { kind: "webhook-secret" }, "dev-owner", undefined)).toMatchObject({
      ok: false,
      error: "credentials_unavailable",
    });
    expect(await codeOf(useCredential(db, "x", "smtp", undefined))).toBe("credentials_unavailable");
    expect(new CredentialError("credentials_unavailable").message).toBe("Credentials aren't set up on this server.");
  });
});

describe("AES-256-GCM", () => {
  it("round-trips, with a fresh 96-bit IV each time", () => {
    const a = seal(K1, "id-1", "hello");
    const b = seal(K1, "id-1", "hello");
    expect(a.iv).toHaveLength(12);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.ciphertext.includes(Buffer.from("hello"))).toBe(false);
    expect(open(K1, "id-1", a)).toBe("hello");
  });

  it("the AAD binds a ciphertext to its credential: moved to another id, it doesn't open", () => {
    const sealed = seal(K1, "id-1", "secret-of-1");
    expect(() => open(K1, "id-2", sealed)).toThrow(CredentialError);
  });

  it("a flipped bit, a wrong key or an unknown key version doesn't open", () => {
    const sealed = seal(K1, "id-1", "x");
    const flipped = Buffer.from(sealed.ciphertext);
    flipped[0]! ^= 1;
    expect(() => open(K1, "id-1", { ...sealed, ciphertext: flipped })).toThrow(CredentialError);
    expect(() => open(keyring({ FLOW_CREDENTIALS_KEY: KEY2 }), "id-1", sealed)).toThrow(CredentialError);
    expect(() => open(K1, "id-1", { ...sealed, keyVersion: 7 })).toThrow(CredentialError);
  });

  it("in the store too: a row's ciphertext copied onto another row is unreadable there", async () => {
    const { db, rows } = memoryCredentials();
    const a = await createCredential(db, GITHUB, "dev-owner", K1);
    const b = await createCredential(db, { ...GITHUB, name: "Other", secret: { token: "ghp_other" } }, "dev-owner", K1);
    if (!a.ok || !b.ok) throw new Error("create failed");
    const ra = rows.get(a.id)!;
    Object.assign(rows.get(b.id)!, { ciphertext: ra.ciphertext, iv: ra.iv });
    expect(await codeOf(useCredential(db, b.id, "github-token", K1))).toBe("credential_unreadable");
    expect((await useCredential(db, a.id, "github-token", K1)).token).toBe("ghp_example0123");
  });
});

describe("key rotation", () => {
  it("reads rows of a previous key, and re-encrypts all of them under the new one", async () => {
    const { db, rows } = memoryCredentials();
    const a = await createCredential(db, SMTP, "dev-owner", K1);
    const b = await createCredential(db, GITHUB, "dev-owner", K1);
    if (!a.ok || !b.ok) throw new Error("create failed");
    const K2 = keyring({
      FLOW_CREDENTIALS_KEY: KEY2,
      FLOW_CREDENTIALS_KEY_VERSION: "2",
      FLOW_CREDENTIALS_PREVIOUS_KEYS: `1:${KEY1}`,
    });
    // Before the rotation runs, the new keyring still reads the old rows.
    expect((await useCredential(db, a.id, "smtp", K2)).password).toBe("smtp-pa55");
    expect(await reencryptAll(db, K2)).toBe(2);
    expect([...rows.values()].map((r) => r.key_version)).toEqual([2, 2]);
    // Afterwards the new key alone is enough.
    const only2 = keyring({ FLOW_CREDENTIALS_KEY: KEY2, FLOW_CREDENTIALS_KEY_VERSION: "2" });
    expect((await useCredential(db, a.id, "smtp", only2)).password).toBe("smtp-pa55");
    expect((await useCredential(db, b.id, "github-token", only2)).token).toBe("ghp_example0123");
    expect(await codeOf(useCredential(db, a.id, "smtp", K1))).toBe("credential_unreadable");
    expect(await reencryptAll(db, K2)).toBe(0);
  });

  it("a row no key opens stops it, and nothing is changed", async () => {
    const { db, rows, statements } = memoryCredentials();
    await createCredential(db, SMTP, "dev-owner", K1);
    const K3 = keyring({ FLOW_CREDENTIALS_KEY: KEY2, FLOW_CREDENTIALS_KEY_VERSION: "3" });
    await expect(reencryptAll(db, K3)).rejects.toThrow(CredentialError);
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect([...rows.values()][0]!.key_version).toBe(1);
  });
});

describe("the kinds", () => {
  it("smtp: host, port, mode and from are meta; username and password are sealed", async () => {
    const { db, rows } = memoryCredentials();
    const r = await createCredential(db, SMTP, "dev-owner", K1);
    expect(r).toMatchObject({ ok: true, kind: "smtp", audits: [{ action: "flow.credential.created", kind: "smtp" }] });
    if (!r.ok) return;
    expect(r.shownOnce).toBeUndefined();
    const row = rows.get(r.id)!;
    expect(row.meta).toEqual({ host: "smtp.example.com", port: 587, mode: "starttls", from: "flow@example.com" });
    expect(JSON.stringify(row.meta)).not.toContain("smtp-pa55");
    expect(await useCredential(db, r.id, "smtp", K1)).toEqual({
      host: "smtp.example.com",
      port: 587,
      mode: "starttls",
      from: "flow@example.com",
      username: "flow",
      password: "smtp-pa55",
    });
  });

  it("github-token: the allowed repositories are meta", async () => {
    const { db } = memoryCredentials();
    const r = await createCredential(db, GITHUB, "dev-owner", K1);
    if (!r.ok) throw new Error("create failed");
    expect(await useCredential(db, r.id, "github-token", K1)).toEqual({
      repos: ["AliSafari-IT/asafarim-docs"],
      token: "ghp_example0123",
    });
  });

  it("webhook-secret: 32 random bytes generated by Flow, returned once (create and rotate)", async () => {
    const { db } = memoryCredentials();
    const r = await createCredential(db, { kind: "webhook-secret", name: "Hook" }, "dev-owner", K1);
    if (!r.ok) throw new Error("create failed");
    expect(Buffer.from(r.shownOnce!, "base64url")).toHaveLength(32);
    expect((await useCredential(db, r.id, "webhook-secret", K1)).secret).toBe(r.shownOnce);
    const rotated = await rotateCredential(db, r.id, { kind: "webhook-secret" }, "dev-owner", K1);
    if (!rotated.ok) throw new Error("rotate failed");
    expect(rotated.shownOnce).not.toBe(r.shownOnce);
    expect((await useCredential(db, r.id, "webhook-secret", K1)).secret).toBe(rotated.shownOnce);
    expect((await listCredentials(db))[0]).not.toHaveProperty("shownOnce");
  });

  it("invalid fields, a taken name, an unknown kind are refused", async () => {
    const { db } = memoryCredentials();
    const bad = [
      { ...SMTP, meta: { ...SMTP.meta, host: "10.0.0.1" } },
      { ...SMTP, meta: { ...SMTP.meta, port: "70000" } },
      { ...SMTP, meta: { ...SMTP.meta, from: "nope" } },
      { ...SMTP, secret: { username: "u", password: "" } },
      { ...GITHUB, meta: { repos: [] } },
      { ...GITHUB, meta: { repos: ["not a repo"] } },
      { ...GITHUB, secret: { token: "has space" } },
      { kind: "ssh-key", name: "x" },
      { kind: "webhook-secret", name: "" },
    ];
    for (const input of bad)
      expect(await createCredential(db, input, "dev-owner", K1)).toMatchObject({
        ok: false,
        error: "invalid_credential",
      });
    await createCredential(db, SMTP, "dev-owner", K1);
    expect(await createCredential(db, SMTP, "dev-owner", K1)).toMatchObject({
      ok: false,
      error: "credential_name_taken",
    });
  });
});

describe("rotate and delete", () => {
  it("rotate replaces the secret (rotated_at set); its kind must match; the audit names id and kind", async () => {
    const { db, rows } = memoryCredentials();
    const r = await createCredential(db, SMTP, "dev-owner", K1);
    if (!r.ok) throw new Error("create failed");
    expect(
      await rotateCredential(db, r.id, { kind: "github-token", secret: { token: "t" } }, "dev-owner", K1),
    ).toMatchObject({
      ok: false,
      error: "invalid_credential",
    });
    const rotated = await rotateCredential(
      db,
      r.id,
      { kind: "smtp", secret: { username: "flow", password: "new-pa55" } },
      "dev-owner",
      K1,
    );
    expect(rotated).toEqual({
      ok: true,
      id: r.id,
      kind: "smtp",
      audits: [{ action: "flow.credential.rotated", credentialId: r.id, kind: "smtp", actor: "dev-owner" }],
    });
    expect(rows.get(r.id)!.rotated_at).toBeInstanceOf(Date);
    expect((await useCredential(db, r.id, "smtp", K1)).password).toBe("new-pa55");
    expect(await rotateCredential(db, "missing", { kind: "webhook-secret" }, "dev-owner", K1)).toMatchObject({
      ok: false,
      error: "credential_not_found",
    });
  });

  it("delete removes it; a second delete is credential_not_found", async () => {
    const { db } = memoryCredentials();
    const r = await createCredential(db, GITHUB, "dev-owner", K1);
    if (!r.ok) throw new Error("create failed");
    expect(await deleteCredential(db, r.id, "dev-owner")).toMatchObject({
      ok: true,
      audits: [{ action: "flow.credential.deleted", credentialId: r.id, kind: "github-token" }],
    });
    expect(await deleteCredential(db, r.id, "dev-owner")).toMatchObject({ ok: false, error: "credential_not_found" });
    expect(await codeOf(useCredential(db, r.id, "github-token", K1))).toBe("credential_not_found");
  });
});

describe("useCredential", () => {
  it("sets last_used_at; the wrong kind is credential_kind_mismatch and doesn't count as a use", async () => {
    const { db, rows } = memoryCredentials();
    const r = await createCredential(db, GITHUB, "dev-owner", K1);
    if (!r.ok) throw new Error("create failed");
    expect(await codeOf(useCredential(db, r.id, "smtp", K1))).toBe("credential_kind_mismatch");
    expect(rows.get(r.id)!.last_used_at).toBeNull();
    await useCredential(db, r.id, "github-token", K1);
    expect(rows.get(r.id)!.last_used_at).toBeInstanceOf(Date);
    expect((await listCredentials(db))[0]!.lastUsedAt).toBeInstanceOf(Date);
  });

  it("the list never selects the ciphertext", async () => {
    const { db, statements } = memoryCredentials();
    await createCredential(db, SMTP, "dev-owner", K1);
    const list = await listCredentials(db);
    expect(Object.keys(list[0]!).sort()).toEqual(
      ["createdAt", "createdBy", "id", "kind", "lastUsedAt", "meta", "name", "rotatedAt"].sort(),
    );
    expect(statements.find((s) => s.startsWith("SELECT id, name"))).not.toMatch(/ciphertext|iv|key_version/);
  });
});
