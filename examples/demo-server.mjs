import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const DEMO_HTML = fileURLToPath(new URL("./demo.html", import.meta.url));
const DEFAULT_PORT = Number(process.env.PORT ?? 8712);

const server = createServer((req, res) => {
	const receivedId = req.headers["x-request-id"];
	console.log(
		`[${new Date().toISOString()}] ${req.method} ${req.url} | x-request-id: ${receivedId ?? "<none>"}`,
	);

	if (req.url === "/" || req.url === "/demo.html") {
		const html = readFileSync(DEMO_HTML, "utf8");
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(html);
		return;
	}

	if (req.url === "/api/echo" || req.url === "/api/echo-xhr") {
		res.writeHead(200, {
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
		});
		res.end(
			JSON.stringify({ path: req.url, requestId: receivedId ?? null }, null, 2),
		);
		return;
	}

	res.writeHead(404, { "Content-Type": "text/plain" });
	res.end("Not Found");
});

server.on("error", (err) => {
	if (err.code === "EADDRINUSE") {
		console.error(
			`Port ${DEFAULT_PORT} in use. Re-run with another port: PORT=8713 node examples/demo-server.mjs`,
		);
		process.exit(1);
	}
	throw err;
});

server.listen(DEFAULT_PORT, "127.0.0.1", () => {
	console.log(`RequestID demo server: http://127.0.0.1:${DEFAULT_PORT}/`);
	console.log(
		"Configure the extension with prefix 'dev' and pattern 'http://127.0.0.1/*'",
	);
	console.log("Press Ctrl+C to stop");
});
