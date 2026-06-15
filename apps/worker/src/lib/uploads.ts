/**
 * Upload mint records (SPEC §8.2/§7.2).
 *
 * POST /api/internal/uploads mints a ULID and persists the declared metadata
 * as an R2 sentinel under the token run's namespace. PUT and proof-attach
 * both verify the sentinel, so:
 *   - uploads not minted by the token's run are rejected, and
 *   - the declared sizeBytes/contentType are enforced at PUT time.
 *
 * Keys are derived from the TOKEN's runId only — cross-run access is
 * structurally impossible (run A's token can only ever address runs/A/...).
 */

/** Declared at mint time; serialized into the sentinel object. */
export interface UploadMint {
  filename: string;
  contentType: string;
  sizeBytes: number;
}

/**
 * Crockford-base32 ULID, 26 chars. Anything else (including percent-encoded
 * slashes Hono decodes into the param) is rejected before touching R2.
 */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

export function isValidUploadId(uploadId: string): boolean {
  return ULID_RE.test(uploadId);
}

/** Sentinel recording the mint — existence == "minted by this run". */
export function uploadMetaKey(runId: string, uploadId: string): string {
  return `runs/${runId}/upload-meta/${uploadId}`;
}

/** The uploaded object itself. */
export function uploadObjectKey(runId: string, uploadId: string): string {
  return `runs/${runId}/uploads/${uploadId}`;
}

/**
 * Validate a PUT's Content-Length against the minted declaration. Returns the
 * parsed length, or null when the header is missing/malformed or exceeds the
 * declared sizeBytes (callers answer 413 — SPEC §8.2 rejects oversized and
 * unbounded bodies; the runtime then enforces the length on the actual stream).
 */
export function acceptedContentLength(
  header: string | undefined,
  declaredSizeBytes: number,
): number | null {
  if (!header) return null;
  const len = Number.parseInt(header, 10);
  if (!Number.isInteger(len) || len < 0) return null;
  return len <= declaredSizeBytes ? len : null;
}
