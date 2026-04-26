import { NextResponse } from "next/server";

export const runtime = "nodejs";

const LGM_AUDIENCE_ID = "69ed03e7f22f41be602911f4";
const LGM_ENDPOINT = "https://apiv2.lagrowthmachine.com/flow/leads";

type AddLeadBody = {
  firstname?: string;
  lastname?: string;
  linkedinUrl?: string;
};

export async function POST(req: Request) {
  const apiKey = process.env.LGM_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "LGM_API_KEY not configured" }, { status: 500 });
  }

  let body: AddLeadBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!body.linkedinUrl) {
    return NextResponse.json({ error: "linkedinUrl required" }, { status: 400 });
  }

  const payload = {
    audience: LGM_AUDIENCE_ID,
    firstname: body.firstname ?? "",
    lastname: body.lastname ?? "",
    linkedinUrl: body.linkedinUrl,
  };

  const url = `${LGM_ENDPOINT}?apikey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* keep text */ }

  if (!res.ok) {
    return NextResponse.json({ error: "lgm rejected", status: res.status, body: parsed }, { status: 502 });
  }
  return NextResponse.json({ ok: true, lgm: parsed });
}
