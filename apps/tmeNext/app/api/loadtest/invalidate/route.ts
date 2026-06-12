import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";

/**
 * Endpoint wyłącznie do testów obciążeniowych (k6) — pozwala invalidować tagi przez HTTP
 * bez przechodzenia przez Server Actions. Przyjmuje pojedynczy tag lub listę.
 *
 * POST /api/loadtest/invalidate
 * Body: { "tag": "data:cache-lab:de:fr" } lub { "tags": ["data:...", "ui:..."] }
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const tags: string[] = Array.isArray(body?.tags)
    ? body.tags
    : typeof body?.tag === "string"
      ? [body.tag]
      : [];

  if (tags.length === 0 || tags.some((t) => typeof t !== "string" || t.length === 0)) {
    return NextResponse.json({ error: "tag or tags[] required" }, { status: 400 });
  }

  for (const tag of tags) {
    revalidateTag(tag, "max");
  }

  return NextResponse.json({ ok: true, tags, at: Date.now() });
}
