import { NextRequest, NextResponse } from "next/server";

/**
 * Reverse proxy that strips X-Frame-Options / CSP frame-ancestors so external
 * sites can be embedded in the Live Test iframe.  For HTML responses a <base>
 * tag is injected so relative asset URLs resolve against the original origin.
 *
 * Usage:  /proxy?url=https://www.google.com
 */

const BLOCKED_REQUEST_HEADERS = new Set([
  "host",
  "referer",
  "origin",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
]);

export async function GET(req: NextRequest) {
  const targetUrl = req.nextUrl.searchParams.get("url");
  if (!targetUrl) {
    return NextResponse.json({ error: "Missing ?url= parameter" }, { status: 400 });
  }

  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }

  // Only allow http(s)
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return NextResponse.json({ error: "Only http/https URLs are supported" }, { status: 400 });
  }

  // Block requests to private/internal networks (SSRF protection)
  const hostname = parsed.hostname.toLowerCase();
  const blockedPatterns = [
    /^localhost$/,
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^169\.254\./,        // AWS metadata endpoint
    /^0\./,
    /^\[::1?\]$/,         // IPv6 loopback
    /^metadata\./,
    /\.internal$/,
    /\.local$/,
  ];
  if (blockedPatterns.some((p) => p.test(hostname))) {
    return NextResponse.json({ error: "Access to internal networks is not allowed" }, { status: 403 });
  }

  try {
    // Forward the request, filtering out problematic headers
    const headers = new Headers();
    req.headers.forEach((value, key) => {
      if (!BLOCKED_REQUEST_HEADERS.has(key.toLowerCase())) {
        headers.set(key, value);
      }
    });
    headers.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
    headers.set("Accept-Language", "en-US,en;q=0.9");

    const upstream = await fetch(targetUrl, {
      headers,
      redirect: "follow",
    });

    // Copy response headers, stripping frame-blocking ones
    const responseHeaders = new Headers();
    upstream.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower === "x-frame-options") return;
      if (lower === "content-security-policy") {
        // Remove frame-ancestors directive but keep everything else
        const stripped = value
          .split(";")
          .filter((d) => !d.trim().toLowerCase().startsWith("frame-ancestors"))
          .join(";");
        if (stripped.trim()) responseHeaders.set(key, stripped);
        return;
      }
      // Skip content-encoding since we're reading the decoded body
      if (lower === "content-encoding") return;
      if (lower === "content-length") return;
      responseHeaders.set(key, value);
    });

    const contentType = upstream.headers.get("content-type") || "";
    const isHtml = contentType.includes("text/html");

    if (isHtml) {
      let html = await upstream.text();

      // Determine the final URL (after redirects) for the <base> tag
      const baseOrigin = parsed.origin;
      const basePath = parsed.pathname.replace(/\/[^/]*$/, "/");
      const baseHref = `${baseOrigin}${basePath}`
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

      // Inject <base> tag so relative URLs resolve correctly
      if (/<head[^>]*>/i.test(html)) {
        html = html.replace(
          /(<head[^>]*>)/i,
          `$1<base href="${baseHref}">`
        );
      } else if (/<html[^>]*>/i.test(html)) {
        html = html.replace(
          /(<html[^>]*>)/i,
          `$1<head><base href="${baseHref}"></head>`
        );
      } else {
        html = `<head><base href="${baseHref}"></head>${html}`;
      }

      // Rewrite any absolute URLs in links/forms that point to the same origin
      // so navigation stays within the proxy
      const _proxyBase = `/proxy?url=`;
      // Intercept link clicks and form submissions via a small inline script
      const interceptScript = `
        <script>
          document.addEventListener('click', function(e) {
            var a = e.target.closest('a[href]');
            if (!a) return;
            var href = a.href;
            if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
              e.preventDefault();
              window.location.href = '/proxy?url=' + encodeURIComponent(href);
            }
          }, true);
        </script>
      `;
      html = html.replace(/<\/body>/i, `${interceptScript}</body>`);

      responseHeaders.set("content-type", "text/html; charset=utf-8");
      return new NextResponse(html, {
        status: upstream.status,
        headers: responseHeaders,
      });
    }

    // Non-HTML: stream through as-is
    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Proxy fetch failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
