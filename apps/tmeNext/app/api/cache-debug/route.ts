import { connection } from "next/server";
import remoteHandler from "@/cache-handlers/remote-handler.mjs";
import {
  authorizeDebugToken,
  formatTextReport,
  isDebugEnabled,
} from "@/cache-handlers/cache-debug.mjs";

function extractToken(request: Request): string | null {
  const url = new URL(request.url);
  const query = url.searchParams.get("token");
  if (query) return query;

  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    return auth.slice(7);
  }

  const header = request.headers.get("x-cache-debug-token");
  return header ?? null;
}

function unauthorized() {
  return new Response("Not Found", { status: 404 });
}

export async function GET(request: Request) {
  await connection();
  void remoteHandler;

  if (!isDebugEnabled()) {
    return unauthorized();
  }

  const token = extractToken(request);
  if (!token || !authorizeDebugToken(token)) {
    return unauthorized();
  }

  const payload = await remoteHandler.getDebugPayload();
  const accept = request.headers.get("accept") ?? "";

  if (accept.includes("text/plain")) {
    return new Response(formatTextReport(payload), {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  return Response.json({
    ...payload,
    hint:
      "Accept: text/plain for a human-readable log. Events and L1 are merged from all Node workers in this container via Redis (meta:debug-*).",
  });
}
