import type { NextRequest } from "next/server";

/** Runtime API proxy — reads `API_BACKEND_URL` on each request (Railway runtime env). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

function backendOrigin(): string {
  return (process.env.API_BACKEND_URL || "http://localhost:3001").replace(/\/$/, "");
}

function buildTargetUrl(req: NextRequest, segments: string[] | undefined): string {
  const sub = segments?.length ? segments.join("/") : "";
  const apiPath = sub ? `/api/${sub}` : "/api";
  return `${backendOrigin()}${apiPath}${req.nextUrl.search}`;
}

function filterRequestHeaders(req: NextRequest): Headers {
  const out = new Headers();
  req.headers.forEach((value, key) => {
    const lk = key.toLowerCase();
    if (lk === "host") return;
    if (HOP_BY_HOP.has(lk)) return;
    out.set(key, value);
  });
  return out;
}

function filterResponseHeaders(upstream: Headers): Headers {
  const out = new Headers();
  upstream.forEach((value, key) => {
    const lk = key.toLowerCase();
    if (HOP_BY_HOP.has(lk)) return;
    out.set(key, value);
  });
  return out;
}

async function proxy(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }): Promise<Response> {
  const { path: segments } = await ctx.params;
  const url = buildTargetUrl(req, segments);
  // #region agent log
  fetch("http://127.0.0.1:7924/ingest/2f5fe76c-0c9d-4511-bb6b-6e08dd27dd37", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "8025bc" },
    body: JSON.stringify({
      sessionId: "8025bc",
      runId: "pre-fix",
      hypothesisId: "H4",
      location: "api/[[...path]]/route.ts:proxy",
      message: "Next API proxy upstream URL",
      data: {
        method: req.method,
        targetUrl: url,
        envApiBackendUrlSet: Boolean(process.env.API_BACKEND_URL),
        segment0: segments?.[0] ?? null,
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
  const headers = filterRequestHeaders(req);
  const hasBody = !["GET", "HEAD"].includes(req.method);
  const upstream = await fetch(url, {
    method: req.method,
    headers,
    body: hasBody ? await req.arrayBuffer() : undefined,
    redirect: "manual",
  });
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: filterResponseHeaders(upstream.headers),
  });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  return proxy(req, ctx);
}
export async function POST(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  return proxy(req, ctx);
}
export async function PUT(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  return proxy(req, ctx);
}
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  return proxy(req, ctx);
}
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  return proxy(req, ctx);
}
export async function HEAD(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  return proxy(req, ctx);
}
export async function OPTIONS(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  return proxy(req, ctx);
}
