import { downloadOgc, OgcProxyError } from "@/lib/server/ogc-proxy";

export const runtime = "nodejs";

/** Public OGC discovery/features/map images/legends. See ADR 010; never receives files. */
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const { bytes,contentType } = await downloadOgc(params.get("url") ?? "",request.signal,params.get("legend") === "1");
    return new Response(bytes as Uint8Array<ArrayBuffer>, { headers:{ "Content-Type":contentType, "Cache-Control":"no-store", "X-Content-Type-Options":"nosniff" } });
  } catch (error) {
    return Response.json({ error:error instanceof OgcProxyError ? error.code : "unreachable" }, { status:error instanceof OgcProxyError ? error.status : 502 });
  }
}
