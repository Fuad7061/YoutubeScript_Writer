/**
 * Simple password-based auth.
 *
 * APP_PASSWORD env var sets the password (defaults to "admin" when unset).
 * Set APP_PASSWORD=off to disable protection entirely.
 * Leaves the app fully open when auth is disabled.
 *
 * Strategy:
 *   - The server entry middleware (src/server.ts) gates every request:
 *     pages without a valid session are 302-redirected to /login,
 *     API/JSON requests get a 401.
 *   - After a successful POST /api/auth/verify the server sets a HttpOnly
 *     `app_password` session cookie, which the browser sends automatically.
 *   - The login page, /healthz, static assets, and /api/auth are public.
 *   - `Authorization: Bearer <password>` is also accepted as a fallback
 *     (used by the requireAuth() guards inside API routes).
 */

const ENV_PASSWORD = process.env.APP_PASSWORD?.trim() ?? "";

/** Effective password: env var, else default "admin". "off" disables auth. */
export const APP_PASSWORD = ENV_PASSWORD === "off" ? "" : ENV_PASSWORD || "admin";
export const AUTH_ENABLED = Boolean(APP_PASSWORD);

export const AUTH_COOKIE = "app_password";

/** Public paths that skip auth even when APP_PASSWORD is set. */
const PUBLIC_PATHS = new Set(["/login", "/healthz", "/api/auth"]);
const PUBLIC_PREFIXES = ["/_build/", "/assets/", "/favicon", "/wasm/", "/__l5e/"];

export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

/** Reads the password from the Authorization header or session cookie. */
export function getAuthToken(request: Request): string {
  const auth = request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
  if (token) return token;
  const cookie = request.headers.get("cookie") ?? "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${AUTH_COOKIE}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : "";
}

export function checkAuth(request: Request): boolean {
  if (!AUTH_ENABLED) return true;
  return getAuthToken(request) === APP_PASSWORD;
}

/** Returns a 401 JSON response if auth fails, undefined if OK. */
export function requireAuth(request: Request): Response | undefined {
  if (!AUTH_ENABLED) return undefined;
  if (isPublicPath(new URL(request.url).pathname)) return undefined;
  if (!checkAuth(request)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  return undefined;
}
