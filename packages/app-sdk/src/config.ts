/**
 * Typed config access from the manifest (P3.2). The manifest's `config` block
 * declares each key with a type and a default; values come from the
 * environment as `APP_CONFIG_<KEY>` (dots and camelCase become UPPER_SNAKE:
 * `limits.maxNotes` → `APP_CONFIG_LIMITS_MAX_NOTES`), else the default.
 * Asking for a key the manifest doesn't declare, or with the wrong type,
 * throws, so a typo can't become `undefined`.
 */
import type { AppManifest } from "@asafarim/app-manifest";

type ConfigEntry = NonNullable<AppManifest["config"]>[number];
export type ConfigValue = string | number | boolean;

export function envNameForConfigKey(key: string): string {
  return `APP_CONFIG_${key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/\./g, "_")
    .toUpperCase()}`;
}

function parse(entry: ConfigEntry, raw: string): ConfigValue {
  switch (entry.type) {
    case "string":
      return raw;
    case "boolean":
      if (raw === "true" || raw === "1") return true;
      if (raw === "false" || raw === "0") return false;
      break;
    case "int":
      if (/^-?\d+$/.test(raw)) return Number(raw);
      break;
    case "number":
      if (raw.trim() !== "" && Number.isFinite(Number(raw))) return Number(raw);
      break;
  }
  throw new Error(`config "${entry.key}" must be a ${entry.type}, got "${raw}" (${envNameForConfigKey(entry.key)})`);
}

export function createConfig(
  manifest: Pick<AppManifest, "config">,
  env: Record<string, string | undefined> = process.env,
) {
  const entries = new Map((manifest.config ?? []).map((e) => [e.key, e]));
  const values = new Map<string, ConfigValue>();
  for (const [key, entry] of entries) {
    const raw = env[envNameForConfigKey(key)];
    values.set(key, raw === undefined || raw === "" ? entry.default : parse(entry, raw));
  }

  function typed<T extends ConfigEntry["type"]>(key: string, type: T[]): ConfigValue {
    const entry = entries.get(key);
    if (!entry) throw new Error(`config key "${key}" isn't declared in the manifest`);
    if (!type.includes(entry.type as T))
      throw new Error(`config "${key}" is a ${entry.type}, not ${type.join(" or ")}`);
    return values.get(key)!;
  }

  return {
    getString: (key: string) => typed(key, ["string"]) as string,
    getBoolean: (key: string) => typed(key, ["boolean"]) as boolean,
    getInt: (key: string) => typed(key, ["int"]) as number,
    getNumber: (key: string) => typed(key, ["int", "number"]) as number,
    /** Every declared key with its current value. */
    all: () => Object.fromEntries(values) as Record<string, ConfigValue>,
  };
}

export type AppConfig = ReturnType<typeof createConfig>;
