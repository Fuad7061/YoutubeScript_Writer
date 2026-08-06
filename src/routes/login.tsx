import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Lock, Loader2 } from "lucide-react";

const loginSearchSchema = z.object({
  next: z.string().optional(),
});

function safeNext(raw: string | undefined): string {
  if (!raw) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

export const Route = createFileRoute("/login")({
  validateSearch: loginSearchSchema.parse,
  component: LoginPage,
});

function LoginPage() {
  const { next } = useSearch({ from: Route.id });
  const destination = safeNext(next);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth?action=status", { credentials: "same-origin" })
      .then((r) => r.json() as Promise<{ enabled: boolean; authed: boolean }>)
      .then((status) => {
        if (cancelled) return;
        if (!status.enabled) window.location.replace("/");
        else if (status.authed) window.location.replace(destination);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [destination]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth?action=verify", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        window.location.replace(destination);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "Incorrect password");
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <Lock className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-xl">Restricted Access</CardTitle>
          <CardDescription>
            This app is password protected. Enter the password to continue.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <Input
              type="password"
              placeholder="Password"
              value={password}
              autoFocus
              disabled={busy}
              onChange={(e) => setPassword(e.target.value)}
            />
            {error ? (
              <p className="text-sm text-destructive">{error}</p>
            ) : null}
            <Button type="submit" className="w-full" disabled={busy || !password}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Unlock"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
