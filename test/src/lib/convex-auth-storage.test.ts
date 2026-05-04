import { describe, expect, test } from "vitest";
import {
  buildStoredConvexTokenUpdates,
  CONVEX_AUTH_JWT_STORAGE_KEY,
  CONVEX_AUTH_REFRESH_TOKEN_STORAGE_KEY,
  CONVEX_REFRESH_TOKEN_STORAGE_KEY,
  CONVEX_TOKEN_STORAGE_KEY,
  getStoredConvexAccessToken,
  getStoredConvexRefreshToken,
  isConvexAuthStorageKey,
} from "../../../src/lib/convex-auth-storage.ts";

describe("convex-auth-storage", () => {
  test("prefers provider access token storage over the legacy mirror", () => {
    expect(
      getStoredConvexAccessToken({
        [CONVEX_AUTH_JWT_STORAGE_KEY]: "provider-jwt",
        [CONVEX_TOKEN_STORAGE_KEY]: "legacy-jwt",
      })
    ).toBe("provider-jwt");
  });

  test("falls back to the legacy access token mirror", () => {
    expect(
      getStoredConvexAccessToken({
        [CONVEX_TOKEN_STORAGE_KEY]: "legacy-jwt",
      })
    ).toBe("legacy-jwt");
  });

  test("prefers provider refresh token storage over the legacy mirror", () => {
    expect(
      getStoredConvexRefreshToken({
        [CONVEX_AUTH_REFRESH_TOKEN_STORAGE_KEY]: "provider-refresh",
        [CONVEX_REFRESH_TOKEN_STORAGE_KEY]: "legacy-refresh",
      })
    ).toBe("provider-refresh");
  });

  test("builds mirrored updates for both auth storage paths", () => {
    expect(
      buildStoredConvexTokenUpdates({
        token: "jwt",
        refreshToken: "refresh",
      })
    ).toEqual({
      [CONVEX_AUTH_JWT_STORAGE_KEY]: "jwt",
      [CONVEX_TOKEN_STORAGE_KEY]: "jwt",
      [CONVEX_AUTH_REFRESH_TOKEN_STORAGE_KEY]: "refresh",
      [CONVEX_REFRESH_TOKEN_STORAGE_KEY]: "refresh",
    });
  });

  test("recognizes Convex Auth provider storage keys", () => {
    expect(isConvexAuthStorageKey(CONVEX_AUTH_JWT_STORAGE_KEY)).toBe(true);
    expect(isConvexAuthStorageKey("convexToken")).toBe(false);
  });
});
