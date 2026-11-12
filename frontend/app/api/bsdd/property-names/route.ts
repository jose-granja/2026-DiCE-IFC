/**
 * IFC property names in one language, live from bSDD (ADR 017).
 *
 * `GET /api/bsdd/property-names?language=pt-PT`. The browser cannot ask bSDD
 * itself (no CORS headers, see `../route.ts`), so this server reads the IFC
 * dictionary's listings and answers with only the translated names. It sends
 * bSDD the dictionary's URI and the language: nothing from a model.
 */

import { NextResponse, type NextRequest } from "next/server";

import { CACHE_SECONDS, PROPERTY_NAME_LANGUAGES, propertyNamesTable } from "@/lib/bsdd/dictionary-names";

export async function GET(request: NextRequest) {
  const language = new URL(request.url).searchParams.get("language") ?? "";
  if (!PROPERTY_NAME_LANGUAGES.has(language)) {
    return NextResponse.json({ error: `No property names for "${language.slice(0, 20)}".` }, { status: 404 });
  }

  try {
    const table = await propertyNamesTable(language);
    return NextResponse.json(table, {
      headers: { "Cache-Control": `public, max-age=${CACHE_SECONDS}` },
    });
  } catch (error) {
    // No labels is the whole cost: the IFC names are still shown.
    return NextResponse.json(
      {
        error:
          error instanceof Error && error.name === "TimeoutError"
            ? "bSDD did not respond in time."
            : "bSDD could not be reached.",
      },
      { status: 502 },
    );
  }
}
