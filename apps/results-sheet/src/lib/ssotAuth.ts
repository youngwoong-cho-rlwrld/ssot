const SSOT_USER_HEADER = "x-ssot-user";

export function requireSsotUser(request: Request): Response | null {
  if (request.headers.get(SSOT_USER_HEADER)?.trim()) return null;
  return Response.json({ error: "unauthenticated" }, { status: 401 });
}
