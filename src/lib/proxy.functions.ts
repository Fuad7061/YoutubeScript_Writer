import { createServerFn } from "@tanstack/react-start";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const Input = z.object({
  proxy: z.string().min(1),
});

function getPythonPath(): string {
  const venv = join(process.cwd(), "fast-whisper-env", "bin", "python3");
  return existsSync(venv) ? venv : "python3";
}

export const testProxyConnection = createServerFn({ method: "POST" })
  .inputValidator((i: unknown) => Input.parse(i))
  .handler(async ({ data }) => {
    const python = getPythonPath();
    const testScript = [
      "import sys, json",
      "from curl_cffi.requests import get",
      "proxy = sys.argv[1]",
      "try:",
      "    r = get('https://httpbin.org/ip', proxies={'http': proxy, 'https': proxy}, impersonate='chrome', timeout=10)",
      "    if r.status_code == 200:",
      "        data = r.json()",
      "        print(json.dumps({'ok': True, 'ip': data.get('origin')}))",
      "    else:",
      "        print(json.dumps({'ok': False, 'error': 'HTTP ' + str(r.status_code)}))",
      "except Exception as e:",
      "    print(json.dumps({'ok': False, 'error': str(e)}))",
    ].join("\n");

    try {
      const stdout = execFileSync(python, ["-c", testScript, data.proxy], {
        timeout: 15_000,
        encoding: "utf8",
      });
      return JSON.parse(stdout.trim()) as { ok: boolean; ip?: string; error?: string };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });
