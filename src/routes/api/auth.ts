/**
 * Public auth API (never requires a session — the whole point is to obtain one).
 *
 * GET  /api/auth?action=status    → { enabled, authed }  (for the client gate)
 * POST /api/auth?action=verify    → { password } → sets `app_password` cookie
 *
 * Verify is rate-limited per IP (5 failures → locked for 15 minutes).
 */
import { createFileRoute } from "@tanstack/react-router";
import {
  AUTH_ENABLED,
  APP_PASSWORD,
  AUTH_COOKIE,
  checkAuth,
} from "@/lib/auth.server";

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

/* ── tiny per-IP rate limiter (in-memory, single instance) ──────────── */
const FAILURES = new Map<string, { count: number; lockedUntil: number }>();
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;

function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for") ?? "";
  return fwd.split(",")[0]?.trim() || "unknown";
}

function isLocked(request: Request): boolean {
  const entry = FAILURES.get(clientIp(request));
  if (!entry) return false;
  if (Date.now() < entry.lockedUntil) return true;
  FAILURES.delete(clientIp(request));
  return false;
}

function recordFailure(request: Request): void {
  const ip = clientIp(request);
  const entry = FAILURES.get(ip) ?? { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= MAX_FAILURES) {
    entry.lockedUntil = Date.now() + LOCK_MS;
    entry.count = 0;
  }
  FAILURES.set(ip, entry);
}

export const Route = createFileRoute("/api/auth")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("action") === "check") {
          if (!AUTH_ENABLED) return json({ ok: true });
          return checkAuth(request) ? json({ ok: true }) : json({ error: "Unauthorized" }, 401);
        }
        if (!AUTH_ENABLED) return json({ enabled: false, authed: true });
        return json({ enabled: true, authed: checkAuth(request) });
      },

      POST: async ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("action") !== "verify") {
          return json({ error: "Unknown action" }, 404);
        }
        if (!AUTH_ENABLED) return json({ error: "Auth disabled" }, 404);
        if (isLocked(request)) {
          return json({ error: "Too many attempts. Try again in 15 minutes." }, 429);
        }

        let password = "";
        try {
          const body = (await request.json()) as { password?: unknown };
          if (typeof body.password === "string") password = body.password;
        } catch {
          return json({ error: "Invalid body" }, 400);
        }

        if (password !== APP_PASSWORD) {
          recordFailure(request);
          return json({ error: "Incorrect password" }, 401);
        }

        const secure =
          (request.headers.get("x-forwarded-proto") ?? "").split(",")[0].trim() ===
          "https";
        return json(
          { ok: true },
          200,
          {
            "set-cookie": `${AUTH_COOKIE}=${encodeURIComponent(password)}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`,
          },
        );
      },
    },
  },
});
