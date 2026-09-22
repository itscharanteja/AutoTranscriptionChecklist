const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:8000";

export async function PUT(request: Request, ctx: RouteContext<"/api/checklists/[id]">) {
  const { id } = await ctx.params;
  const payload = await request.text();
  const res = await fetch(`${BACKEND_URL}/checklists/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: payload,
  });
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
