import { readFileSync } from "fs";
import { join } from "path";

const html = readFileSync(
  join(process.cwd(), "src/app/mock-gtm/_static/gmail-compose.html"),
  "utf-8",
);

export async function GET() {
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
