/**
 * Stored names of the bot connection fields that held Aimpoint's own address and key (VEC-321). Before the
 * rename they were `connection.vectorUrl` / `connection.vectorKeySealed`; scripts/migrate-connection-fields.mjs
 * `$rename`s them on every bot. Until that has run on every deployment, reads go through these helpers, which fall
 * back to the old field, so a not-yet-migrated bot still dispatches. Drop the fallback one release later.
 * No imports, so the migration script can load it with plain `node`.
 */

/** Old field -> new field, under `connection.` on each bot. */
export const LEGACY_CONNECTION_FIELDS = {
  vectorUrl: "aimpointUrl",
  vectorKeySealed: "aimpointKeySealed",
} as const;

interface ConnectionFields {
  aimpointUrl?: string;
  aimpointKeySealed?: string;
  /** @deprecated pre-VEC-321 name of aimpointUrl. */
  vectorUrl?: string;
  /** @deprecated pre-VEC-321 name of aimpointKeySealed. */
  vectorKeySealed?: string;
}

/** Aimpoint's origin recorded at setup (old field as fallback). */
export const connectionAimpointUrl = (c: ConnectionFields | null | undefined): string | undefined => c?.aimpointUrl ?? c?.vectorUrl;

/** The sealed copy of the bot's own Aimpoint key (old field as fallback). */
export const connectionAimpointKeySealed = (c: ConnectionFields | null | undefined): string | undefined =>
  c?.aimpointKeySealed ?? c?.vectorKeySealed;
