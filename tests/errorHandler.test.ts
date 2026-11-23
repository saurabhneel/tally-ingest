import express, { type Request, type Response } from "express";
import request from "supertest";
import { describe, it, expect, vi } from "vitest";
import { Errors, AppError } from "../src/errors";
import { createLogger } from "../src/logger";
import { createErrorHandler, notFoundHandler } from "../src/middleware/errors";

function makeApp() {
  const logger = createLogger({ LOG_LEVEL: "silent", NODE_ENV: "test" });
  const warn = vi.spyOn(logger, "warn");
  const error = vi.spyOn(logger, "error");

  const app = express();
  app.use(express.json());

  app.get("/known", () => {
    throw Errors.notFound("Import");
  });
  app.get("/with-details", () => {
    throw new AppError(413, "PAYLOAD_TOO_LARGE", "Too big.", { maxBytes: 5 });
  });
  app.get("/boom", () => {
    throw new Error(
      "SQLITE_ERROR at C:\\Users\\saura\\secret\\tally.db: no such table imports",
    );
  });
  app.get("/non-error", () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw "a string with <VOUCHER> content";
  });
  app.get("/partial", (_req: Request, res: Response) => {
    res.write("partial");
    throw new Error("late failure");
  });
  app.post("/json", (_req, res) => {
    res.json({ ok: true });
  });

  app.use(notFoundHandler());
  app.use(createErrorHandler(logger));
  return { app, warn, error };
}

describe("error handler", () => {
  it("returns AppError as structured JSON with its own status", async () => {
    const { app, warn, error } = makeApp();
    const res = await request(app).get("/known");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: "NOT_FOUND", message: "Import not found." },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  it("includes details when the error has them", async () => {
    const res = await request(makeApp().app).get("/with-details");
    expect(res.status).toBe(413);
    expect(res.body.error.details).toEqual({ maxBytes: 5 });
  });

  it("turns unexpected errors into a generic 500 without leaking anything", async () => {
    const { app, error } = makeApp();
    const res = await request(app).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred.",
      },
    });
    const text = JSON.stringify(res.body) + JSON.stringify(res.headers);
    expect(text).not.toContain("SQLITE");
    expect(text).not.toContain("saura");
    expect(text).not.toContain("tally.db");
    expect(text).not.toContain("at ");
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("handles thrown non-Error values", async () => {
    const res = await request(makeApp().app).get("/non-error");
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("VOUCHER");
  });

  it("maps malformed JSON bodies to a fixed 400 without echoing the body", async () => {
    const res = await request(makeApp().app)
      .post("/json")
      .set("Content-Type", "application/json")
      .send('{"secret": oops');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { code: "BAD_REQUEST", message: "The request is invalid." },
    });
  });

  it("returns a structured 404 for unknown routes", async () => {
    const res = await request(makeApp().app).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: "NOT_FOUND", message: "Route not found." },
    });
  });

  it("does not log request content, only code, status, method and path", async () => {
    const { app, warn } = makeApp();
    await request(app).get("/known?customer=ACME-SECRET");
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("/known");
    expect(logged).not.toContain("ACME-SECRET");
  });

  it("does not try to write a second response when headers are already sent", async () => {
    const { app } = makeApp();
    // The response was already started, so the handler hands over to Express,
    // which ends the connection. The client sees a truncated or aborted reply
    // but the server must not crash.
    await request(app)
      .get("/partial")
      .catch(() => undefined);
    const after = await request(app).get("/known");
    expect(after.status).toBe(404);
  });
});
