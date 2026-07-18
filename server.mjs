import { createServer } from "http";
import { parse } from "url";
import next from "next";

const dev = process.env.NODE_ENV !== "production";
const port = parseInt(process.env.PORT ?? "3000", 10);

const app = next({ dev, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error("Error handling request:", err);
      res.statusCode = 500;
      res.end("Internal Server Error");
    }
  });

  // Allow long-running AI API routes (book generation can take 3-5 min).
  // These must be higher than your reverse proxy's read timeout.
  server.requestTimeout = 360_000; // 6 min — set nginx proxy_read_timeout to match
  server.headersTimeout = 361_000; // must exceed requestTimeout
  server.keepAliveTimeout = 65_000; // slightly above nginx keepalive_timeout default

  server.listen(port, () => {
    console.log(`> Ready on port ${port}`);
  });
});
