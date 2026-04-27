export function normalizeLinkedInProfileUrl(value?: string | null): string | null {
  if (!value) return null;

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "linkedin.com") return null;

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2 || segments[0].toLowerCase() !== "in") return null;

  return `https://www.linkedin.com/in/${segments[1]}`;
}
