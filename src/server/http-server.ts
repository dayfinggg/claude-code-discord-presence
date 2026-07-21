import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { HookPayload, StatuslinePayload } from "../types.ts";
import { createLogger } from "../util/logger.ts";

const log = createLogger("server");
const MAX_BODY_BYTES = 512 * 1024;

export interface ServerHandlers {
  onHook: (payload: HookPayload) => void;
  onStatusline: (payload: StatuslinePayload) => void;
}

function respond(response: ServerResponse, status: number, body = ""): void {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    request.resume();
    throw new RangeError("request body is too large");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_BODY_BYTES) throw new RangeError("request body is too large");
    chunks.push(buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  handlers: ServerHandlers,
): Promise<void> {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (path === "/health") {
    if (request.method !== "GET") return respond(response, 405, "method not allowed");
    return respond(response, 200, "ok");
  }
  if (path !== "/hook" && path !== "/statusline") return respond(response, 404, "not found");
  if (request.method !== "POST") return respond(response, 405, "method not allowed");

  try {
    const payload = await readJson(request);
    if (!payload) return respond(response, 400, "invalid JSON object");
    try {
      if (path === "/hook") handlers.onHook(payload as HookPayload);
      else handlers.onStatusline(payload as StatuslinePayload);
    } catch (err) {
      log.error(`${path.slice(1)} handler failed: ${(err as Error).message}`);
      return respond(response, 500, "handler failed");
    }
    return respond(response, 204);
  } catch (err) {
    if (err instanceof RangeError) return respond(response, 413, "payload too large");
    log.warn(`request failed: ${(err as Error).message}`);
    return respond(response, 400, "bad request");
  }
}

export function startServer(port: number, handlers: ServerHandlers): Server {
  const server = createServer((request, response) => {
    void handle(request, response, handlers).catch((err: unknown) => {
      log.error(`request crashed: ${(err as Error).message}`);
      if (!response.headersSent) respond(response, 500, "internal error");
      else response.destroy();
    });
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.maxHeadersCount = 32;
  server.listen(port, "127.0.0.1");
  server.on("listening", () => log.info(`listening on http://127.0.0.1:${port}`));
  server.on("error", (err) => log.error(`server error: ${err.message}`));
  return server;
}
