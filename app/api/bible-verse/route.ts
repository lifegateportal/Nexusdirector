import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 15;

const RequestSchema = z.object({
  reference: z.string().min(2).max(120),
});

export async function POST(req: NextRequest) {
  let input: z.infer<typeof RequestSchema>;
  try {
    input = RequestSchema.parse(await req.json() as unknown);
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const url = `https://bible-api.com/${encodeURIComponent(input.reference)}`;
    const res = await fetch(url, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const data = await res.json() as {
      reference?: string;
      text?: string;
      error?: string;
      verses?: Array<{ text: string }>;
    };

    if (data.error || !data.text) {
      return NextResponse.json({ error: data.error ?? "No text returned" }, { status: 404 });
    }

    return NextResponse.json({
      reference: data.reference ?? input.reference,
      text: data.text.replace(/\n+/g, " ").trim(),
    });
  } catch {
    return NextResponse.json({ error: "Fetch failed" }, { status: 502 });
  }
}
