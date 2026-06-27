import assert from "node:assert/strict";
import { test } from "node:test";

import { onRequest } from "../functions/api/[[path]].js";

async function hashPassword(password, salt) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: encoder.encode(salt),
      iterations: 100000,
    },
    keyMaterial,
    256,
  );
  return [...new Uint8Array(bits)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function createEnv() {
  const user = {
    id: "user-1",
    email: "user@example.com",
    password_hash: await hashPassword("old-password", "old-salt"),
    salt: "old-salt",
    isMember: true,
    is_member: 1,
    daily_quota: 100,
    total_quota: 100,
    used_total: 7,
    video_quota: 3,
    video_used: 1,
    member_expires_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
  };
  const statements = [];

  return {
    ADMIN_TOKEN: "admin-token",
    DB: {
      statements,
      user,
      prepare(sql) {
        const statement = {
          args: [],
          bind(...args) {
            this.args = args;
            return this;
          },
          async first() {
            if (sql.includes("SELECT * FROM users WHERE email = ?")) {
              return this.args[0] === user.email ? user : null;
            }
            if (sql.includes("SELECT id FROM users WHERE email = ?")) {
              return this.args[0] === user.email ? { id: user.id } : null;
            }
            if (sql.includes("FROM users WHERE id = ?")) {
              return this.args[0] === user.id ? user : null;
            }
            if (sql.includes("FROM usage_days")) return null;
            return null;
          },
          async all() {
            return { results: [] };
          },
          async run() {
            statements.push({ sql, args: this.args });
            if (sql.includes("UPDATE users SET password_hash = ?")) {
              user.password_hash = this.args[0];
              user.salt = this.args[1];
            }
            return { success: true };
          },
        };
        return statement;
      },
    },
  };
}

function request(path, body, headers = {}) {
  return new Request(`https://example.com/api${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function login(env, password) {
  return await onRequest({
    request: request("/auth/login", { email: "user@example.com", password }),
    env,
  });
}

test("admin can reset a user's password without deleting account data", async () => {
  const env = await createEnv();

  const resetResponse = await onRequest({
    request: request(
      "/admin/users/reset-password",
      { email: "user@example.com", password: "new-password" },
      { "x-admin-token": "admin-token" },
    ),
    env,
  });
  const resetPayload = await resetResponse.json();

  assert.equal(resetResponse.status, 200);
  assert.deepEqual(resetPayload, { ok: true });
  assert.equal(env.DB.user.used_total, 7);
  assert.equal(env.DB.user.video_used, 1);
  assert.equal((await login(env, "old-password")).status, 401);
  assert.equal((await login(env, "new-password")).status, 200);
});

test("admin password reset rejects short passwords", async () => {
  const env = await createEnv();

  const response = await onRequest({
    request: request(
      "/admin/users/reset-password",
      { email: "user@example.com", password: "short" },
      { "x-admin-token": "admin-token" },
    ),
    env,
  });

  assert.equal(response.status, 400);
  assert.equal(env.DB.user.salt, "old-salt");
});
