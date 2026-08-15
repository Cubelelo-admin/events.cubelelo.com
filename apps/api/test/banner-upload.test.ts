import { describe, it, expect, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { createMemRepo } from "../src/db/mem-repo";
import type { Repository } from "../src/db/repo";
import { seed, SEED_DEMO_COMP_ID } from "../src/db/seed";
import { adminToken, bearer } from "./helpers";

/**
 * Banner upload failures used to reach the admin as a bare status code: the
 * client threw `Upload failed: 413` and the size case could not even produce a
 * code, because @fastify/multipart aborts the stream before the route's own
 * check runs and the error handler flattened its prose message to
 * `invalid_request`.
 *
 * These pin the machine-readable codes the UI turns into sentences.
 */

let app: FastifyInstance;
let repo: Repository;
let admin: string;

const BOUNDARY = "----cubersTestBoundary";

/** A multipart body carrying one file field named `image`. */
function multipart(filename: string, contents: Buffer): Buffer {
  const head = Buffer.from(
    `--${BOUNDARY}\r\n` +
      `Content-Disposition: form-data; name="image"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
  return Buffer.concat([head, contents, tail]);
}

function upload(filename: string, contents: Buffer) {
  return app.inject({
    method: "POST",
    url: `/api/v1/admin/competitions/${SEED_DEMO_COMP_ID}/upload-banner`,
    headers: {
      ...bearer(admin),
      "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
    },
    payload: multipart(filename, contents),
  });
}

beforeAll(async () => {
  repo = createMemRepo();
  await seed(repo);
  app = await buildApp(repo);
  admin = await adminToken(app);
});

describe("banner upload errors carry a code", () => {
  it("rejects an unsupported file type by name", async () => {
    const res = await upload("banner.pdf", Buffer.from("not an image"));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_file_type");
  });

  it("rejects a file over 5 MB with a size-specific code", async () => {
    const res = await upload("huge.png", Buffer.alloc(6 * 1024 * 1024, 1));
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe("file_too_large_max_5mb");
  });

  it("rejects a request with no file", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admin/competitions/${SEED_DEMO_COMP_ID}/upload-banner`,
      headers: {
        ...bearer(admin),
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: Buffer.from(`--${BOUNDARY}--\r\n`),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("no_file");
  });

  it("accepts a valid image and returns its URL", async () => {
    const res = await upload("banner.png", Buffer.from("fake png bytes"));
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().bannerUrl).toBe("string");
  });
});
