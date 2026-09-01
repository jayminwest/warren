/** A JSON `Response`. Shared by the tracker's own routes and by FakeAdo. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}
