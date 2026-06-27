import assert from "node:assert/strict";
import { test } from "node:test";

import { onRequest } from "../functions/api/[[path]].js";

function createDb() {
  const statements = [];
  const user = {
    id: "user-1",
    email: "user@example.com",
  };

  return {
    statements,
    prepare(sql) {
      const statement = {
        args: [],
        bind(...args) {
          this.args = args;
          return this;
        },
        async first() {
          if (sql.includes("FROM sessions")) return user;
          return null;
        },
        async all() {
          if (sql.includes("FROM works")) {
            return {
              results: [
                {
                  id: "work-1",
                  taskId: "task-1",
                  url: "https://cdn.example.com/image.png",
                  prompt: "fresh work",
                  model: "gpt-image-2",
                  size: "1:1",
                  quality: "auto",
                  mediaType: "image",
                  createdAt: new Date().toISOString(),
                },
              ],
            };
          }
          return { results: [] };
        },
        async run() {
          statements.push({ sql, args: this.args });
          return { success: true };
        },
      };
      return statement;
    },
    async batch(items) {
      for (const item of items) await item.run();
      return items.map(() => ({ success: true }));
    },
  };
}

function createRequest() {
  return new Request("https://example.com/api/works", {
    headers: {
      Cookie: "xh_session=session-token",
    },
  });
}

function createEnv({ lastRun } = {}) {
  const db = createDb();
  const markers = [];
  return {
    DB: db,
    REFERENCE_IMAGES: {
      markers,
      async get(key) {
        if (!lastRun) return null;
        return {
          async text() {
            return lastRun;
          },
        };
      },
      async put(key, value) {
        markers.push({ key, value });
      },
    },
  };
}

test("works listing cleans task records older than three days once per day", async () => {
  const env = createEnv();
  const response = await onRequest({ request: createRequest(), env });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.works.length, 1);
  assert.equal(
    env.DB.statements.filter((statement) => statement.sql.includes("DELETE FROM")).length,
    3,
  );
  assert.ok(env.DB.statements.some((statement) => statement.sql.includes("DELETE FROM works")));
  assert.ok(env.DB.statements.some((statement) => statement.sql.includes("DELETE FROM task_reference_images")));
  assert.ok(env.DB.statements.some((statement) => statement.sql.includes("DELETE FROM image_tasks")));
  assert.equal(env.REFERENCE_IMAGES.markers.length, 1);
  assert.equal(env.REFERENCE_IMAGES.markers[0].value, new Date().toISOString().slice(0, 10));
});

test("works listing skips cleanup when today's marker exists", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const env = createEnv({ lastRun: today });
  const response = await onRequest({ request: createRequest(), env });

  assert.equal(response.status, 200);
  assert.equal(
    env.DB.statements.filter((statement) => statement.sql.includes("DELETE FROM")).length,
    0,
  );
  assert.equal(env.REFERENCE_IMAGES.markers.length, 0);
});
