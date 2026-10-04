import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export const TOKEN = "ghp_test_secret_token_123";

/** A tiny stand-in for api.github.com. */
export async function mockGithub(handler?: (req: IncomingMessage, body: string, res: ServerResponse) => boolean) {
  const calls: { method: string; url: string; body: string; auth: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ method: req.method!, url: req.url!, body, auth: String(req.headers.authorization ?? "") });
      res.setHeader("content-type", "application/json");
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401).end(JSON.stringify({ message: "Bad credentials" }));
      if (handler?.(req, body, res)) return;
      const url = req.url!.split("?")[0];
      if (url === "/user") return res.end(JSON.stringify({ login: "ada", avatar_url: "https://avatars.example/ada.png" }));
      if (url === "/user/repos")
        return res.end(
          JSON.stringify([
            { full_name: "ada/web", description: "The website", private: false, updated_at: "2026-10-01T00:00:00Z", clone_url: "https://github.com/ada/web.git", default_branch: "main" },
            { full_name: "ada/secret", description: null, private: true, updated_at: "2026-09-01T00:00:00Z", clone_url: "https://github.com/ada/secret.git", default_branch: "trunk" },
          ]),
        );
      if (url === "/repos/acme/web") return res.end(JSON.stringify({ default_branch: "main" }));
      if (url === "/repos/acme/web/issues")
        return res.end(
          JSON.stringify([
            { number: 1, title: "Login is slow", body: "…", labels: [{ name: "perf" }], html_url: "https://github.com/acme/web/issues/1" },
            { number: 2, title: "A pull request", pull_request: {}, html_url: "x" },
            { number: 3, title: "Typo on home", body: "", labels: [], html_url: "https://github.com/acme/web/issues/3" },
          ]),
        );
      if (url === "/repos/acme/web/pulls" && req.method === "POST") {
        const b = JSON.parse(body) as { title: string };
        return res.writeHead(201).end(JSON.stringify({ number: 7, html_url: "https://github.com/acme/web/pull/7", title: b.title }));
      }
      if (url === "/repos/acme/web/pulls/7") return res.end(JSON.stringify({ number: 7, html_url: "https://github.com/acme/web/pull/7", title: "T", state: "open", head: { sha: "abc" } }));
      if (url === "/repos/acme/web/commits/abc/check-runs") return res.end(JSON.stringify({ check_runs: [{ status: "completed", conclusion: "success" }] }));
      if (url === "/repos/acme/web/commits/abc/status") return res.end(JSON.stringify({ statuses: [] }));
      res.writeHead(404).end(JSON.stringify({ message: "Not Found" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const api = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { api, calls, close: () => server.close() };
}
