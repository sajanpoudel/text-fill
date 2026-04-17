export const CONVEX_AUTH_JWT_STORAGE_KEY = "__convexAuthJWT";
export const CONVEX_AUTH_REFRESH_TOKEN_STORAGE_KEY = "__convexAuthRefreshToken";
export const CONVEX_TOKEN_STORAGE_KEY = "convexToken";
export const CONVEX_REFRESH_TOKEN_STORAGE_KEY = "convexRefreshToken";

function readStoredString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function isConvexAuthStorageKey(key: string): boolean {
  return key.startsWith("__convexAuth");
}

export function getStoredConvexAccessToken(
  stored: Record<string, unknown>
): string | null {
  return (
    readStoredString(stored[CONVEX_AUTH_JWT_STORAGE_KEY]) ??
    readStoredString(stored[CONVEX_TOKEN_STORAGE_KEY])
  );
}

export function getStoredConvexRefreshToken(
  stored: Record<string, unknown>
): string | null {
  return (
    readStoredString(stored[CONVEX_AUTH_REFRESH_TOKEN_STORAGE_KEY]) ??
    readStoredString(stored[CONVEX_REFRESH_TOKEN_STORAGE_KEY])
  );
}

export function buildStoredConvexTokenUpdates(tokens: {
  token: string;
  refreshToken?: string | null;
}): Record<string, string> {
  const updates: Record<string, string> = {
    [CONVEX_AUTH_JWT_STORAGE_KEY]: tokens.token,
    [CONVEX_TOKEN_STORAGE_KEY]: tokens.token,
  };
  if (tokens.refreshToken) {
    updates[CONVEX_AUTH_REFRESH_TOKEN_STORAGE_KEY] = tokens.refreshToken;
    updates[CONVEX_REFRESH_TOKEN_STORAGE_KEY] = tokens.refreshToken;
  }
  return updates;
}
