import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { onRequest } from "../functions/api/[[path]].js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createDb({ task } = {}) {
  const statements = [];
  const user = {
    id: "user-1",
    email: "user@example.com",
    isMember: true,
    is_member: 1,
    daily_quota: 100,
    total_quota: 100,
    used_total: 0,
    video_quota: 10,
    video_used: 0,
    member_expires_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
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
          if (sql.includes("FROM users WHERE id = ?")) return user;
          if (sql.includes("FROM usage_days")) return null;
          if (sql.includes("SELECT * FROM image_tasks")) return task;
          return null;
        },
        async all() {
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

function createEnv(options = {}) {
  return {
    DB: createDb(options),
    DUOMI_API_KEY: "test-key",
  };
}

function createRequest(path, body = {}, method = "POST") {
  return new Request(`https://example.com/api${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Cookie: "xh_session=session-token",
    },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
}

test("creates a Grok video task through the dedicated endpoint", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ id: "grok-task-1" }), { status: 200 });
  };

  const env = createEnv();
  const response = await onRequest({
    request: createRequest("/grok/videos/generations", {
      model: "grok-video-1.5",
      prompt: "cinematic product reveal",
      aspect_ratio: "2:3",
      duration: 10,
      quality: "720p",
      image_urls: ["https://example.com/ref.png"],
    }),
    env,
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, { id: "grok-task-1", mediaType: "video" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://duomiapi.com/v1/videos/generations");
  assert.equal(calls[0].options.headers.Authorization, "test-key");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    model: "grok-video-1.5",
    prompt: "cinematic product reveal",
    aspect_ratio: "2:3",
    duration: 10,
    quality: "720p",
    image_urls: ["https://example.com/ref.png"],
  });
  assert.ok(
    env.DB.statements.some((statement) =>
      statement.sql.includes("INSERT INTO image_tasks") &&
      statement.args.includes("grok-video-1.5"),
    ),
  );
});

test("rejects Grok requests with more than one reference image", async () => {
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  };

  const response = await onRequest({
    request: createRequest("/grok/videos/generations", {
      model: "grok-video-1.5",
      prompt: "cinematic product reveal",
      aspect_ratio: "16:9",
      duration: 15,
      quality: "720p",
      image_urls: ["https://example.com/a.png", "https://example.com/b.png"],
    }),
    env: createEnv(),
  });
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(fetchCalled, false);
  assert.match(payload.message, /最多|1/);
});

test("rejects invalid Grok request parameters before calling upstream", async () => {
  const cases = [
    {
      name: "invalid aspect ratio",
      body: { aspect_ratio: "4:3", duration: 15, quality: "720p", image_urls: [] },
      message: /比例/,
    },
    {
      name: "invalid duration",
      body: { aspect_ratio: "16:9", duration: 20, quality: "720p", image_urls: [] },
      message: /时长/,
    },
    {
      name: "invalid quality",
      body: { aspect_ratio: "16:9", duration: 15, quality: "1080p", image_urls: [] },
      message: /720p/,
    },
    {
      name: "image_urls is not an array",
      body: { aspect_ratio: "16:9", duration: 15, quality: "720p", image_urls: "https://example.com/ref.png" },
      message: /数组/,
    },
  ];

  for (const item of cases) {
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    };

    const response = await onRequest({
      request: createRequest("/grok/videos/generations", {
        model: "grok-video-1.5",
        prompt: item.name,
        ...item.body,
      }),
      env: createEnv(),
    });
    const payload = await response.json();

    assert.equal(response.status, 400, item.name);
    assert.equal(fetchCalled, false, item.name);
    assert.match(payload.message, item.message, item.name);
  }
});

test("polls Grok video tasks through the Grok task endpoint", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(
      JSON.stringify({
        id: "grok-task-1",
        state: "succeeded",
        message: "",
        data: { videos: [{ url: "https://cdn.example.com/video.mp4" }] },
      }),
      { status: 200 },
    );
  };

  const env = createEnv({
    task: {
      id: "grok-task-1",
      user_id: "user-1",
      prompt: "cinematic product reveal",
      model: "grok-video-1.5",
      size: "16:9",
      quality: "720p",
      media_type: "video",
      saved_at: null,
    },
  });
  const response = await onRequest({
    request: createRequest("/tasks/grok-task-1", {}, "GET"),
    env,
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(calls[0].url, "https://duomiapi.com/v1/videos/tasks/grok-task-1");
  assert.equal(calls[0].options.headers.Authorization, "test-key");
  assert.equal(payload.status, "succeeded");
  assert.deepEqual(payload.videos, ["https://cdn.example.com/video.mp4"]);
});

test("returns the Grok task error message to the frontend", async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        id: "grok-task-1",
        state: "error",
        message: "reference image rejected",
        data: { videos: [] },
      }),
      { status: 200 },
    );

  const env = createEnv({
    task: {
      id: "grok-task-1",
      user_id: "user-1",
      prompt: "cinematic product reveal",
      model: "grok-video-1.5",
      size: "16:9",
      quality: "720p",
      media_type: "video",
      saved_at: null,
    },
  });
  const response = await onRequest({
    request: createRequest("/tasks/grok-task-1", {}, "GET"),
    env,
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.status, "error");
  assert.equal(payload.message, "reference image rejected");
});
