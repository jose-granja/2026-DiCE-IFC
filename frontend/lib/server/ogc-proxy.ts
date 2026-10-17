/** Bounded, read-only OGC downloads. Never forwards a body, cookies or credentials. */
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { ogcTlsOptions } from "./ogc-tls";

const blocked = new BlockList();
for (const [address, prefix] of [["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",3]] as const) blocked.addSubnet(address,prefix,"ipv4");
// Public IPv6 unicast only; reject mapped IPv4, local, multicast and transition
// ranges rather than letting them tunnel into the server's private network.
const publicV6 = new BlockList(); publicV6.addSubnet("2000::",3,"ipv6");
for (const [address,prefix] of [["2001::",32],["2001:db8::",32],["2002::",16]] as const) blocked.addSubnet(address,prefix,"ipv6");
export function publicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address,"ipv4") : family === 6 && publicV6.check(address,"ipv6") && !blocked.check(address,"ipv6");
}

export class OgcProxyError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}

export function validateOgcRequest(value: string): { url: URL; limit: number; image: boolean } {
  let url: URL;
  try { url = new URL(value); } catch { throw new OgcProxyError("invalidUrl"); }
  if (value.length > 4096 || !["http:","https:"].includes(url.protocol) || url.username || url.password || url.hash || (url.port && !["80","443"].includes(url.port))) throw new OgcProxyError("invalidUrl");
  const params = new Map<string,string>();
  for (const [key,value] of url.searchParams) {
    const name = key.toUpperCase();
    if (params.has(name)) throw new OgcProxyError("invalidUrl");
    params.set(name,value);
  }
  const service = params.get("SERVICE")?.toUpperCase(), operation = params.get("REQUEST")?.toUpperCase();
  const capabilities = operation === "GETCAPABILITIES";
  const image = service === "WMS" && operation === "GETMAP";
  const features = service === "WFS" && operation === "GETFEATURE";
  if (!["WMS","WFS"].includes(service ?? "") || !(capabilities || image || features)) throw new OgcProxyError("readOnly");
  // No arbitrary filters, XML requests, schema URLs, remote styles or callbacks.
  const allowed = new Set(["SERVICE","REQUEST","VERSION","ACCEPTVERSIONS","LAYERS","STYLES","CRS","SRS","BBOX","WIDTH","HEIGHT","FORMAT","TRANSPARENT","TYPENAMES","TYPENAME","SRSNAME","OUTPUTFORMAT","COUNT","MAXFEATURES","MAP","KEY","APIKEY","API_KEY","TOKEN"]);
  for (const [key,value] of params) if (!allowed.has(key) || value.length > 1024 || /[<>\r\n]/.test(value)) throw new OgcProxyError("invalidUrl");
  if (!capabilities) {
    const bounds = (params.get("BBOX") ?? "").split(",");
    if (bounds.length < 4 || bounds.length > 5 || !bounds.slice(0,4).every((v) => v.trim() && Number.isFinite(Number(v)))) throw new OgcProxyError("invalidRadius");
    if (Number(bounds[0]) >= Number(bounds[2]) || Number(bounds[1]) >= Number(bounds[3])) throw new OgcProxyError("invalidRadius");
  }
  if (image) {
    for (const key of ["WIDTH","HEIGHT"]) {
      const n = Number(params.get(key));
      if (!Number.isInteger(n) || n < 1 || n > 2048) throw new OgcProxyError("invalidRadius");
    }
    if (!/^image\/(png|jpeg)$/i.test(params.get("FORMAT") ?? "")) throw new OgcProxyError("unsupportedImage");
  }
  if (features) {
    const count = Number(params.get("COUNT") ?? params.get("MAXFEATURES"));
    if (!Number.isInteger(count) || count < 1 || count > 10001) throw new OgcProxyError("tooManyFeatures");
  }
  return { url, image, limit: capabilities ? 8*1024*1024 : image ? 20*1024*1024 : 64*1024*1024 };
}

export async function downloadOgc(value: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; contentType: string }> {
  const { url, limit, image } = validateOgcRequest(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await lookup(hostname, { all:true, verbatim:true }).catch(() => { throw new OgcProxyError("unreachable",502); });
  if (!addresses.length || addresses.some(({address}) => !publicAddress(address))) throw new OgcProxyError("publicServiceOnly",403);
  // Pin the validated address in the socket lookup: a second DNS lookup would
  // permit DNS rebinding between validation and connection. No redirects.
  const timeout = AbortSignal.timeout(30_000);
  return new Promise((resolve,reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      ...(url.protocol === "https:" ? ogcTlsOptions(hostname) : {}),
      method:"GET", signal:signal ? AbortSignal.any([signal,timeout]) : timeout,
      headers:{ Accept:image ? "image/png,image/jpeg,application/xml" : "application/xml,application/gml+xml,application/json,text/xml", "Accept-Encoding":"identity" },
      lookup:(_hostname, options, callback) => {
        if (options.all) callback(null,addresses);
        else callback(null,addresses[0].address,addresses[0].family);
      },
    }, (response) => {
      if (response.statusCode !== 200) { response.destroy(); reject(new OgcProxyError("serviceError",502)); return; }
      const contentType = (response.headers["content-type"] ?? "application/xml").split(";")[0].toLowerCase();
      if (!/^(application\/(xml|json|geo\+json|gml\+xml|vnd\.ogc\.[\w.+-]+)|text\/(xml|plain)|image\/(png|jpeg))$/.test(contentType) || (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity")) {
        response.destroy(); reject(new OgcProxyError("serviceError",502)); return;
      }
      if (Number(response.headers["content-length"]) > limit) { response.destroy(); reject(new OgcProxyError("tooLarge",413)); return; }
      const chunks: Buffer[] = []; let size=0;
      response.on("data", (chunk: Buffer) => {
        size+=chunk.length;
        if (size>limit) { response.destroy(new OgcProxyError("tooLarge",413)); return; }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ bytes:Buffer.concat(chunks),contentType }));
      response.on("error",reject);
    });
    request.on("error", (error) => {
      const tlsError = /CERT|SIGNATURE|SELF_SIGNED/.test((error as NodeJS.ErrnoException).code ?? "");
      reject(error instanceof OgcProxyError ? error : new OgcProxyError(tlsError ? "invalidCertificate" : "unreachable",502));
    });
    request.end();
  });
}
