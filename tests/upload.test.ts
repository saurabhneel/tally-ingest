import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import request from "supertest";
import { describe, it, expect, vi } from "vitest";
import { toErrorResponse } from "../src/errors";
import { createUploadMiddleware } from "../src/middleware/upload";

function makeApp(maxBytes: number) {
  const app = express();
  app.post("/upload", createUploadMiddleware(maxBytes), (req, res) => {
    res.status(201).json({
      name: req.file!.originalname,
      size: req.file!.size,
      hex: req.file!.buffer.toString("hex"),
    });
  });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const { status, body } = toErrorResponse(err);
    res.status(status).json(body);
  });
  return app;
}

describe("createUploadMiddleware", () => {
  it('accepts one file in the "file" field and preserves the exact bytes', async () => {
    const bytes = Buffer.from([
      0xef, 0xbb, 0xbf, 0x3c, 0x61, 0x2f, 0x3e, 0x00, 0xff,
    ]);
    const res = await request(makeApp(1024))
      .post("/upload")
      .attach("file", bytes, "whatever.xml");
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      name: "whatever.xml",
      size: bytes.length,
      hex: bytes.toString("hex"),
    });
  });

  it("accepts a file of exactly the limit and rejects one byte more with 413", async () => {
    const app = makeApp(100);
    const ok = await request(app)
      .post("/upload")
      .attach("file", Buffer.alloc(100, 0x61), "a.xml");
    expect(ok.status).toBe(201);

    const tooBig = await request(app)
      .post("/upload")
      .attach("file", Buffer.alloc(101, 0x61), "a.xml");
    expect(tooBig.status).toBe(413);
    expect(tooBig.body).toEqual({
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: "The uploaded file exceeds the size limit.",
        details: { maxBytes: 100 },
      },
    });
  });

  it("returns FILE_REQUIRED when the multipart body has no file", async () => {
    const res = await request(makeApp(1024))
      .post("/upload")
      .field("note", "hello");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("FILE_REQUIRED");
  });

  it("returns FILE_REQUIRED for a non-multipart request", async () => {
    const res = await request(makeApp(1024))
      .post("/upload")
      .send({ file: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("FILE_REQUIRED");
  });

  it("rejects a file sent under the wrong field name", async () => {
    const res = await request(makeApp(1024))
      .post("/upload")
      .attach("document", Buffer.from("<a/>"), "a.xml");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("BAD_REQUEST");
  });

  it("rejects more than one file", async () => {
    const res = await request(makeApp(1024))
      .post("/upload")
      .attach("file", Buffer.from("<a/>"), "a.xml")
      .attach("file", Buffer.from("<b/>"), "b.xml");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("BAD_REQUEST");
  });

  it("rejects a malformed multipart body with a generic message", async () => {
    const res = await request(makeApp(1024))
      .post("/upload")
      .set("Content-Type", "multipart/form-data; boundary=xyz")
      .send(
        '--xyz\r\nContent-Disposition: form-data; name="file"; filename="a.xml"\r\n\r\ntruncated',
      );
    expect(res.status).toBe(400);
    expect(["BAD_REQUEST", "FILE_REQUIRED"]).toContain(res.body.error.code);
    expect(JSON.stringify(res.body)).not.toContain("truncated");
  });

  it("refuses an oversized Content-Length before reading the body", () => {
    const middleware = createUploadMiddleware(100);
    const setHeader = vi.fn();
    const next = vi.fn();
    middleware(
      {
        headers: { "content-length": String(100 + 64 * 1024 + 1) },
      } as unknown as Request,
      { setHeader } as unknown as Response,
      next,
    );
    expect(setHeader).toHaveBeenCalledWith("Connection", "close");
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]![0]).toMatchObject({
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
    });
  });
});
