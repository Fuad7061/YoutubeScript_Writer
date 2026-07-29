/**
 * GET  /healthz  — health check for Docker/Coolify.
 * Returns { status: "ok", uptime: <seconds> } with 200.
 */
import { createFileRoute } from "@tanstack/react-router";

const START = Date.now();

export const Route = createFileRoute("/api/healthz")({
  server: {
    handlers: {
      GET: () =>
        new Response(
          JSON.stringify({ status: "ok", uptime: Math.floor((Date.now() - START) / 1000) }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    },
  },
});
