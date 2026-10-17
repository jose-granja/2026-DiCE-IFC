import { downloadOgc, OgcProxyError } from "@/lib/server/ogc-proxy";

export const runtime = "nodejs";

/** Public OGC discovery/features/map images. See ADR 010; never receives files. */
export async function GET(request: Request) {
  try {
    const { bytes,contentType } = await downloadOgc(new URL(request.url).searchParams.get("url") ?? "",request.signal);
    return new Response(bytes as Uint8Array<ArrayBuffer>, { headers:{ "Content-Type":contentType, "Cache-Control":"no-store", "X-Content-Type-Options":"nosniff" } });
  } catch (error) {
    return Response.json({ error:error instanceof OgcProxyError ? error.code : "unreachable" }, { status:error instanceof OgcProxyError ? error.status : 502 });
  }
}
