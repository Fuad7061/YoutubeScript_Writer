/**
 * Session persistence API.
 *
 * GET    /api/sessions          → list all sessions (summary, no project JSON)
 * GET    /api/sessions/:id      → get one session (full project JSON)
 * POST   /api/sessions          → upsert a session { id, label, mode, project }
 * DELETE /api/sessions/:id      → delete one session
 * DELETE /api/sessions          → delete ALL sessions (Data Management)
 * GET    /api/sessions/stats    → { count, dbPath }
 *
 * All writes require auth (if APP_PASSWORD is set).
 * Reads are also auth-gated so project data is not exposed publicly.
 */
import { createFileRoute } from "@tanstack/react-router";
import {
  upsertSession,
  listSessions,
  getSession,
  deleteSession,
  deleteAllSessions,
  sessionCount,
} from "@/lib/db.server";
import { requireAuth } from "@/lib/auth.server";

const DATA_DIR = process.env.DATA_DIR ?? "./data";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function err(msg: string, status = 400) {
  return json({ error: msg }, status);
}

export const Route = createFileRoute("/api/sessions")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const authErr = requireAuth(request);
        if (authErr) return authErr;

        const url = new URL(request.url);
        const id = url.searchParams.get("id");

        // Stats sub-resource
        if (url.searchParams.has("stats")) {
          return json({ count: sessionCount(), dbPath: `${DATA_DIR}/foundry.db` });
        }

        // Single session
        if (id) {
          const session = getSession(id);
          if (!session) return err("Not found", 404);
          return json(session);
        }

        // List all
        return json(listSessions());
      },

      POST: async ({ request }) => {
        const authErr = requireAuth(request);
        if (authErr) return authErr;

        let body: { id?: string; label?: string; mode?: string; project?: unknown };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return err("Invalid JSON");
        }

        const { id, label, mode, project } = body;
        if (!id || typeof id !== "string") return err("id required");
        if (!project) return err("project required");

        upsertSession(
          id,
          label ?? "Untitled",
          mode ?? "youtube",
          JSON.stringify(project),
        );

        return json({ ok: true, id });
      },

      DELETE: async ({ request }) => {
        const authErr = requireAuth(request);
        if (authErr) return authErr;

        const url = new URL(request.url);
        const id = url.searchParams.get("id");

        if (id) {
          deleteSession(id);
          return json({ ok: true, deleted: id });
        }

        // No id = delete ALL (clear all data)
        deleteAllSessions();
        return json({ ok: true, deleted: "all" });
      },
    },
  },
});
