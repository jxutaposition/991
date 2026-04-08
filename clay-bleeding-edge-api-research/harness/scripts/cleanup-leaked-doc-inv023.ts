/**
 * One-shot cleanup for the leaked scratch document from INV-023.
 *
 * INV-023's verify script created a second document via the alt-shape probe
 * (`{name, folderId:null, context:"agent_playground"}`) but only tracked the
 * first documentId for cleanup. The leftover doc id is `doc_0td531mAWhrhgzXcufb`.
 *
 * This script issues a single hard-delete and reports the status code.
 * 404 = already gone (success). 200 = successfully deleted (success).
 *
 * No credits consumed. No raw cookies logged.
 */
import * as fs from "fs";
import * as path from "path";

const API_BASE = "https://api.clay.com";
const WORKSPACE_ID = 1080480;
const DOC_ID = "doc_0td531mAWhrhgzXcufb";
const COOKIE_FILE = path.join(__dirname, "..", "results", ".session-cookies.json");

function loadCookieHeader(): string {
  const raw = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf-8"));
  return raw.map((c: any) => `${c.name}=${c.value}`).join("; ");
}

async function main() {
  const cookieHeader = loadCookieHeader();
  const url = `${API_BASE}/v3/documents/${WORKSPACE_ID}/${DOC_ID}?hard=true`;
  console.log(`DELETE /v3/documents/${WORKSPACE_ID}/${DOC_ID}?hard=true`);

  const res = await fetch(url, {
    method: "DELETE",
    headers: {
      Cookie: cookieHeader,
      Accept: "application/json",
    },
  });
  const text = await res.text().catch(() => "");
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch { /* keep raw */ }

  console.log(`status: ${res.status}`);
  console.log(`body:   ${typeof parsed === "string" ? parsed.substring(0, 400) : JSON.stringify(parsed)}`);

  if (res.status === 200) {
    console.log("RESULT: leaked document hard-deleted successfully");
    process.exit(0);
  } else if (res.status === 404) {
    console.log("RESULT: document already gone (404) — cleanup is a no-op success");
    process.exit(0);
  } else {
    console.log(`RESULT: unexpected status ${res.status}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("ERROR:", e?.message ?? e);
  process.exit(2);
});
