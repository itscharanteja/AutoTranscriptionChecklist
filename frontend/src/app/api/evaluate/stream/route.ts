const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:8000";

export async function POST(request: Request) {
  const payload = await request.text();
  const backendRes = await fetch(`${BACKEND_URL}/evaluate/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
  });

  if (!backendRes.ok || !backendRes.body) {
    const text = await backendRes.text();
    return new Response(text, { status: backendRes.status, headers: { "Content-Type": "application/json" } });
  }

  return new Response(backendRes.body, {
    status: backendRes.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
