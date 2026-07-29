/**
 * Simple password-based auth middleware.
 *
 * Set APP_PASSWORD env var to enable protection.
 * Leaves the app fully open when APP_PASSWORD is empty or unset.
 *
 * Strategy:
 *   - Protected paths return 401 if the Authorization header is missing or wrong.
 *   - The browser login page (GET /__login) is always public.
 *   - Static assets and /healthz are always public.
 *   - The client stores the password in sessionStorage and sends it as
 *     `Authorization: Bearer <password>` on every API/server-fn request.
 */

export const AUTH_ENABLED = Boolean(process.env.APP_PASSWORD?.trim());
export const APP_PASSWORD = process.env.APP_PASSWORD?.trim() ?? "";

/** Public paths that skip auth even when APP_PASSWORD is set. */
const PUBLIC_PATHS = new Set(["/__login", "/healthz"]);
const PUBLIC_PREFIXES = ["/_build/", "/_server/", "/favicon", "/wasm/", "/__l5e/"];

export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

export function checkAuth(request: Request): boolean {
  if (!AUTH_ENABLED) return true;
  const auth = request.headers.get("Authorization") ?? "";
  // Accept: Bearer <password> or just the raw password as fallback.
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
  return token === APP_PASSWORD;
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
