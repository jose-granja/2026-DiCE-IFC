export function getApiBaseUrl() {
  if (typeof window === "undefined") {
    return process.env.API_INTERNAL_URL || "http://api:8000/api";
  }
  return process.env.NEXT_PUBLIC_API_BASE_URL || "/api";
}