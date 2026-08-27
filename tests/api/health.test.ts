/**
 * `GET /api/health` — docs/REGISTRY-CONTRACT.md §3.6.
 *
 * Optional for the CLI, so it stays trivial: reachability and a timestamp.
 */

import { describe, expect, it } from "vitest";
import { apiGet } from "../setup";

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

describe("GET /api/health", () => {
  it("reports ok", async () => {
    const { status, body } = await apiGet("/api/health");

    expect(status).toBe(200);
    expect(body.status).toBe("ok");
  });

  it("returns exactly {status, time}", async () => {
    const { body } = await apiGet("/api/health");

    expect(Object.keys(body).sort()).toEqual(["status", "time"]);
  });

  it("returns time as an ISO-8601 instant", async () => {
    const { body } = await apiGet("/api/health");

    expect(body.time).toMatch(ISO_INSTANT);
    expect(Number.isNaN(Date.parse(body.time))).toBe(false);
  });

  it("answers without a database and without authentication (§2.6)", async () => {
    const { status } = await apiGet("/api/health");

    expect(status).toBe(200);
  });
});
