import { readFileSync } from "fs";
import { join } from "path";

const html = readFileSync(
  join(process.cwd(), "src/app/mock-gtm/_static/crunchbase.html"),
  "utf-8",
);

export async function GET() {
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
