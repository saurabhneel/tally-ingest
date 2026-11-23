import { Router } from "express";
import type { Db } from "../db/connection";
import type { AppLogger } from "../logger";

export function createHealthRouter(db: Db, logger: AppLogger): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      db.prepare("SELECT 1").get();
      res.status(200).json({ status: "ok", service: "tally-ingest" });
    } catch (err) {
      logger.error({ err }, "health check failed");
      res.status(503).json({ status: "unavailable", service: "tally-ingest" });
    }
  });

  return router;
}
