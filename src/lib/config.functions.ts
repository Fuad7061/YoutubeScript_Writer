import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export const getServerConfig = createServerFn({ method: "GET" })
  .validator((i: unknown) => z.object({ key: z.string() }).parse(i))
  .handler(async ({ data }) => {
    const { getConfigKV } = await import("./db.server");
    return { value: getConfigKV(data.key) ?? null };
  });

export const saveServerConfig = createServerFn({ method: "POST" })
  .validator((i: unknown) =>
    z.object({ key: z.string(), value: z.string() }).parse(i)
  )
  .handler(async ({ data }) => {
    const { upsertConfigKV } = await import("./db.server");
    upsertConfigKV(data.key, data.value);
    return { success: true };
  });
