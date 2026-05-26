const API_BASE = "https://duomiapi.com/v1";
const BANANA_API_URL = "https://duomiapi.com/api/gemini/nano-banana-edit";
const SESSION_COOKIE = "xh_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const REFERENCE_IMAGE_TTL_SECONDS = 60 * 60 * 24 * 3;
const REFERENCE_IMAGE_TTL_MS = REFERENCE_IMAGE_TTL_SECONDS * 1000;
const REFERENCE_CLEANUP_SCAN_LIMIT = 1000;

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, "");

  try {
    if (!env.DB) return json({ message: "D1 database is not configured" }, 500);

    if (request.method === "POST" && path === "auth/register") {
      return await register(request, env);
    }
    if (request.method === "POST" && path === "auth/login") {
      return await login(request, env);
    }
    if (request.method === "POST" && path === "auth/logout") {
      return logout();
    }
    if (request.method === "GET" && path === "me") {
      const user = await requireUser(request, env);
      return json({ user: await publicUser(env, user.id) });
    }
    if (request.method === "GET" && path === "works") {
      const user = await requireUser(request, env);
      const works = await env.DB.prepare(
        `SELECT id, task_id AS taskId, url, prompt, model, size, quality,
          media_type AS mediaType, created_at AS createdAt
         FROM works
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT 100`,
      )
        .bind(user.id)
        .all();
      return json({ works: works.results || [] });
    }
    if (request.method === "POST" && path === "uploads/reference") {
      return await uploadReferenceImage(request, env);
    }
    if (request.method === "GET" && path.startsWith("files/")) {
      return await getUploadedFile(request, env, path.slice("files/".length));
    }
    if (request.method === "POST" && path === "images/generations") {
      return await createImageTask(request, env);
    }
    if (request.method === "POST" && path === "videos/generations") {
      return await createVideoTask(request, env);
    }
    if (request.method === "GET" && path.startsWith("tasks/")) {
      const taskId = decodeURIComponent(path.slice("tasks/".length));
      return await getTask(request, env, taskId);
    }
    if (path.startsWith("admin/") && !isAdminRequest(request, env)) {
      return json({ message: "管理员令牌不正确。" }, 401);
    }
    if (request.method === "GET" && path === "admin/users") {
      return await listUsers(request, env);
    }
    if (request.method === "POST" && path === "admin/membership") {
      return await updateMembership(request, env);
    }
    if (request.method === "POST" && path === "admin/users/delete") {
      return await deleteUser(request, env);
    }
    if (request.method === "GET" && path === "admin/reference-images") {
      return await listReferenceImages(request, env);
    }
    if (request.method === "POST" && path === "admin/reference-images/delete") {
      return await deleteReferenceImage(request, env);
    }

    return json({ message: "API not found" }, 404);
  } catch (error) {
    const status = error.status || 500;
    return json({ message: error.message || "Server error" }, status);
  }
}

async function register(request, env) {
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  const password = String(body.password || "");
  if (!email) throw httpError(400, "请输入有效邮箱。");
  if (password.length < 8) throw httpError(400, "密码至少需要 8 位。");

  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
    .bind(email)
    .first();
  if (existing) throw httpError(409, "该邮箱已注册，请直接登录。");

  const id = crypto.randomUUID();
  const salt = crypto.randomUUID();
  const passwordHash = await hashPassword(password, salt);
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO users (
      id, email, password_hash, salt, is_member, daily_quota, total_quota,
      used_total, video_quota, video_used, member_expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, 0, NULL, ?, ?)`,
  )
    .bind(id, email, passwordHash, salt, now, now)
    .run();

  return createSessionResponse(env, id);
}

async function login(request, env) {
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  const password = String(body.password || "");
  const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?")
    .bind(email)
    .first();
  if (!user) throw httpError(401, "邮箱或密码不正确。");

  const passwordHash = await hashPassword(password, user.salt);
  if (passwordHash !== user.password_hash) {
    throw httpError(401, "邮箱或密码不正确。");
  }

  return createSessionResponse(env, user.id);
}

async function logout() {
  return json(
    { ok: true },
    200,
    {
      "Set-Cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    },
  );
}

async function createSessionResponse(env, userId) {
  const token = crypto.randomUUID() + crypto.randomUUID().replaceAll("-", "");
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  await env.DB.prepare(
    "INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(token, userId, expiresAt, nowIso())
    .run();
  return json(
    { user: await publicUser(env, userId) },
    200,
    {
      "Set-Cookie": `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
    },
  );
}

async function createImageTask(request, env) {
  if (!env.DUOMI_API_KEY) throw httpError(500, "DUOMI_API_KEY is not configured");
  const user = await requireUser(request, env);
  const membership = await publicUser(env, user.id);
  if (!membership.isMember) throw httpError(403, "会员未开通，请联系管理员。");

  const body = await readJson(request);
  const prompt = String(body.prompt || "").trim();
  const requestedModel = String(body.model || "gpt-image-2").trim();
  const isBanana = requestedModel === "gemini-3.1-flash-image-preview";
  const model = isBanana
    ? validateEnum(requestedModel, ["gemini-3.1-flash-image-preview"], "暂不支持该 Banana2 模型。")
    : requestedModel;
  const n = isBanana ? 1 : clampInt(body.n, 1, 4);
  const size = isBanana
    ? validateBananaImageSize(String(body.image_size || "1K"))
    : validateSize(String(body.size || "auto"));
  const bananaAspectRatio = isBanana ? validateBananaAspectRatio(String(body.aspect_ratio || "1:1")) : "";
  const quality = isBanana ? "auto" : String(body.quality || "auto");
  const images = isBanana
    ? Array.isArray(body.image_urls)
      ? body.image_urls.filter(Boolean)
      : []
    : Array.isArray(body.image)
      ? body.image.filter(Boolean)
      : [];
  if (!prompt) throw httpError(400, "请填写提示词。");
  if (isBanana && images.length === 0) throw httpError(400, "Banana2 图生图需要参考图。");
  if (isBanana && images.length > 10) throw httpError(400, "Banana2 最多支持 10 张参考图。");

  await ensureQuota(env, membership, n);

  const upstreamPayload = isBanana
    ? {
        model,
        prompt,
        aspect_ratio: bananaAspectRatio,
        image_size: size,
        image_urls: images,
      }
    : {
        model,
        prompt,
        n,
        size,
        quality,
      };
  if (!isBanana && images.length > 0) upstreamPayload.image = images;

  const upstream = await fetch(isBanana ? BANANA_API_URL : `${API_BASE}/images/generations?async=true`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.DUOMI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(upstreamPayload),
  });
  const data = await parseJson(upstream);
  if (!upstream.ok) {
    throw httpError(upstream.status, data?.error?.message || data?.message || "图片任务创建失败。");
  }

  const taskId = data?.id || data?.data?.id || data?.task_id || data?.data?.task_id;
  const directImages = isBanana ? normalizeImages(data) : [];
  if (!taskId && directImages.length > 0) {
    const localTaskId = crypto.randomUUID();
    const now = nowIso();
    await env.DB.prepare(
      `INSERT INTO image_tasks (
        id, user_id, prompt, model, size, quality, n, state, saved_at, created_at, updated_at, media_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'succeeded', ?, ?, ?, 'image')`,
    )
      .bind(localTaskId, user.id, prompt, model, size, quality, n, now, now, now)
      .run();
    await recordReferenceImages(env, request, user.id, localTaskId, images, now);
    for (const [index, url] of directImages.entries()) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO works (
          id, user_id, task_id, url, prompt, model, size, quality, created_at, media_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'image')`,
      )
        .bind(`${localTaskId}-${index}`, user.id, localTaskId, url, prompt, model, size, quality, now)
        .run();
    }
    await consumeQuota(env, user.id, n);
    return json({ id: localTaskId, images: directImages, mediaType: "image" });
  }
  if (!taskId) throw httpError(502, "上游接口没有返回任务 ID。");

  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO image_tasks (
      id, user_id, prompt, model, size, quality, n, state, created_at, updated_at, media_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?, 'image')`,
  )
    .bind(taskId, user.id, prompt, model, size, quality, n, now, now)
    .run();
  await recordReferenceImages(env, request, user.id, taskId, images, now);
  await consumeQuota(env, user.id, n);

  return json({ id: taskId });
}

async function createVideoTask(request, env) {
  if (!env.DUOMI_API_KEY) throw httpError(500, "DUOMI_API_KEY is not configured");
  const user = await requireUser(request, env);
  const membership = await publicUser(env, user.id);
  if (!membership.isMember) throw httpError(403, "会员未开通，请联系管理员。");

  const body = await readJson(request);
  const prompt = String(body.prompt || "").trim();
  const model = validateEnum(String(body.model || "veo3.1-fast"), ["veo3.1-fast"], "暂不支持该视频模型。");
  const aspectRatio = validateEnum(String(body.aspect_ratio || "16:9"), ["16:9", "9:16"], "视频比例不正确。");
  const quality = validateEnum(String(body.quality || "1080p"), ["720p", "1080p"], "暂不支持该视频清晰度。");
  const generationType = validateEnum(
    String(body.generation_type || "TEXT"),
    ["TEXT", "FIRST&LAST", "REFERENCE"],
    "视频生成模式不正确。",
  );
  const duration = 8;
  const imageUrls = Array.isArray(body.image_urls) ? body.image_urls.filter(Boolean) : [];
  if (!prompt) throw httpError(400, "请填写提示词。");
  if (generationType === "TEXT" && imageUrls.length > 0) {
    throw httpError(400, "文生视频模式不需要参考图。");
  }
  if (generationType !== "TEXT" && imageUrls.length === 0) {
    throw httpError(400, "请上传参考图，或将生成模式改为文生视频。");
  }
  if (generationType === "REFERENCE" && aspectRatio === "9:16") {
    throw httpError(400, "REFERENCE 模式暂不支持 9:16。");
  }

  await ensureVideoQuota(env, membership);

  const upstreamPayload = {
    model,
    prompt,
    aspect_ratio: aspectRatio,
    duration,
    generation_type: generationType,
    quality,
  };
  if (imageUrls.length > 0) upstreamPayload.image_urls = imageUrls;

  const upstream = await fetch(`${API_BASE}/videos/generations?async=true`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.DUOMI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(upstreamPayload),
  });
  const data = await parseJson(upstream);
  if (!upstream.ok) {
    throw httpError(upstream.status, data?.error?.message || data?.message || "视频任务创建失败。");
  }

  const taskId = data?.id || data?.data?.id || data?.task_id || data?.data?.task_id;
  if (!taskId) throw httpError(502, "上游接口没有返回任务 ID。");

  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO image_tasks (
      id, user_id, prompt, model, size, quality, n, state, created_at, updated_at, media_type
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 'submitted', ?, ?, 'video')`,
  )
    .bind(taskId, user.id, prompt, model, aspectRatio, quality, now, now)
    .run();
  await recordReferenceImages(env, request, user.id, taskId, imageUrls, now);
  await consumeVideoQuota(env, user.id);

  return json({ id: taskId, mediaType: "video" });
}

async function uploadReferenceImage(request, env) {
  if (!env.REFERENCE_IMAGES) throw httpError(500, "REFERENCE_IMAGES bucket is not configured");
  const user = await requireUser(request, env);
  await cleanupExpiredReferenceImages(env);
  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) throw httpError(400, "请上传图片文件。");
  if (!file.type.startsWith("image/")) throw httpError(400, "只支持图片文件。");
  if (file.size > 10 * 1024 * 1024) throw httpError(400, "参考图不能超过 10MB。");

  const ext = extensionFromType(file.type);
  const key = `references/${user.id}/${Date.now()}-${crypto.randomUUID()}${ext}`;
  await env.REFERENCE_IMAGES.put(key, file.stream(), {
    httpMetadata: {
      contentType: file.type,
      cacheControl: `public, max-age=${REFERENCE_IMAGE_TTL_SECONDS}`,
    },
    customMetadata: {
      userId: user.id,
      originalName: file.name || "reference-image",
      expiresAt: new Date(Date.now() + REFERENCE_IMAGE_TTL_MS).toISOString(),
    },
  });

  const origin = new URL(request.url).origin;
  return json({ url: `${origin}/api/files/${encodeURIComponent(key)}`, key });
}

async function getUploadedFile(request, env, encodedKey) {
  if (!env.REFERENCE_IMAGES) throw httpError(500, "REFERENCE_IMAGES bucket is not configured");
  const key = decodeURIComponent(encodedKey);
  if (!key.startsWith("references/")) throw httpError(404, "文件不存在。");
  const object = await env.REFERENCE_IMAGES.get(key);
  if (!object) throw httpError(404, "文件不存在。");

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", `public, max-age=${REFERENCE_IMAGE_TTL_SECONDS}`);
  headers.set("ETag", object.httpEtag);
  return new Response(object.body, { headers });
}

async function getTask(request, env, taskId) {
  if (!env.DUOMI_API_KEY) throw httpError(500, "DUOMI_API_KEY is not configured");
  const user = await requireUser(request, env);
  const task = await env.DB.prepare("SELECT * FROM image_tasks WHERE id = ? AND user_id = ?")
    .bind(taskId, user.id)
    .first();
  if (!task) throw httpError(404, "任务不存在。");

  const upstream = await fetch(`${API_BASE}/tasks/${encodeURIComponent(taskId)}`, {
    headers: {
      Authorization: `Bearer ${env.DUOMI_API_KEY}`,
    },
  });
  const data = await parseJson(upstream);
  if (!upstream.ok) {
    throw httpError(upstream.status, data?.error?.message || data?.message || "任务查询失败。");
  }

  const status = normalizeStatus(data);
  const images = normalizeImages(data);
  const videos = normalizeVideos(data);
  const assets = task.media_type === "video" ? videos : images;
  await env.DB.prepare("UPDATE image_tasks SET state = ?, updated_at = ? WHERE id = ?")
    .bind(status || "running", nowIso(), taskId)
    .run();

  if (assets.length > 0 && !task.saved_at) {
    const now = nowIso();
    for (const [index, url] of assets.entries()) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO works (
          id, user_id, task_id, url, prompt, model, size, quality, created_at, media_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          `${taskId}-${index}`,
          user.id,
          taskId,
          url,
          task.prompt,
          task.model,
          task.size,
          task.quality,
          now,
          task.media_type || "image",
        )
        .run();
    }
    await env.DB.prepare("UPDATE image_tasks SET saved_at = ?, state = 'succeeded' WHERE id = ?")
      .bind(now, taskId)
      .run();
  }

  return json({ id: taskId, status, images, videos, mediaType: task.media_type || "image" });
}

async function recordReferenceImages(env, request, userId, taskId, images, now) {
  const keys = images
    .map((url) => extractReferenceKey(request, url))
    .filter(Boolean);
  for (const key of keys) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO task_reference_images (
        id, task_id, user_id, object_key, url, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(`${taskId}-${key}`, taskId, userId, key, `${new URL(request.url).origin}/api/files/${encodeURIComponent(key)}`, now)
      .run();
  }
}

async function cleanupExpiredReferenceImages(env) {
  if (!env.REFERENCE_IMAGES) return;
  const cutoff = Date.now() - REFERENCE_IMAGE_TTL_MS;
  let cursor;
  let scanned = 0;
  do {
    const listed = await env.REFERENCE_IMAGES.list({
      prefix: "references/",
      cursor,
      limit: Math.min(1000, REFERENCE_CLEANUP_SCAN_LIMIT - scanned),
    });
    for (const object of listed.objects || []) {
      scanned += 1;
      const uploadedAt = object.uploaded
        ? new Date(object.uploaded).getTime()
        : referenceTimestampFromKey(object.key);
      if (uploadedAt && uploadedAt < cutoff) {
        await env.REFERENCE_IMAGES.delete(object.key);
        await env.DB.prepare("UPDATE task_reference_images SET deleted_at = ? WHERE object_key = ? AND deleted_at IS NULL")
          .bind(nowIso(), object.key)
          .run();
      }
      if (scanned >= REFERENCE_CLEANUP_SCAN_LIMIT) return;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

function referenceTimestampFromKey(key) {
  const match = String(key || "").match(/^references\/[^/]+\/(\d+)-/);
  if (!match) return 0;
  const timestamp = Number(match[1]);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function extractReferenceKey(request, value) {
  try {
    const url = new URL(value, request.url);
    const requestUrl = new URL(request.url);
    if (url.origin !== requestUrl.origin) return "";
    if (!url.pathname.startsWith("/api/files/")) return "";
    const key = decodeURIComponent(url.pathname.slice("/api/files/".length));
    return key.startsWith("references/") ? key : "";
  } catch {
    return "";
  }
}

function extensionFromType(type) {
  const map = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/avif": ".avif",
  };
  return map[type] || ".png";
}

async function updateMembership(request, env) {
  requireAdmin(request, env);
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  if (!email) throw httpError(400, "请输入用户邮箱。");

  const user = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (!user) throw httpError(404, "用户不存在。");

  const isMember = body.isMember === false ? 0 : 1;
  const dailyQuota = nullableInt(body.dailyQuota, 20);
  const totalQuota = nullableInt(body.totalQuota, 200);
  const usedTotal = body.usedTotal === undefined ? null : nullableInt(body.usedTotal, 0);
  const videoQuota = nullableInt(body.videoQuota, 0);
  const videoUsed = body.videoUsed === undefined ? null : nullableInt(body.videoUsed, 0);
  const expiresAt = body.expiresAt ? String(body.expiresAt) : null;
  if (usedTotal === null && videoUsed === null) {
    await env.DB.prepare(
      `UPDATE users
       SET is_member = ?, daily_quota = ?, total_quota = ?, video_quota = ?,
         member_expires_at = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(isMember, dailyQuota, totalQuota, videoQuota, expiresAt, nowIso(), user.id)
      .run();
  } else {
    await env.DB.prepare(
      `UPDATE users
       SET is_member = ?, daily_quota = ?, total_quota = ?, used_total = ?,
         video_quota = ?, video_used = ?, member_expires_at = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(isMember, dailyQuota, totalQuota, usedTotal || 0, videoQuota, videoUsed || 0, expiresAt, nowIso(), user.id)
      .run();
  }
  return json({ user: await publicUser(env, user.id) });
}

async function deleteUser(request, env) {
  requireAdmin(request, env);
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  if (!email) throw httpError(400, "请输入用户邮箱。");

  const user = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (!user) throw httpError(404, "用户不存在。");

  if (env.REFERENCE_IMAGES) {
    const references = await env.DB.prepare(
      `SELECT object_key AS objectKey
       FROM task_reference_images
       WHERE user_id = ? AND deleted_at IS NULL`,
    )
      .bind(user.id)
      .all();
    for (const row of references.results || []) {
      await env.REFERENCE_IMAGES.delete(row.objectKey);
    }
  }

  await env.DB.batch([
    env.DB.prepare("DELETE FROM task_reference_images WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM works WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM image_tasks WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM usage_days WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
  ]);

  return json({ ok: true });
}

async function listReferenceImages(request, env) {
  requireAdmin(request, env);
  const url = new URL(request.url);
  const limit = Math.min(200, Math.max(1, Number.parseInt(url.searchParams.get("limit") || "100", 10)));
  const rows = await env.DB.prepare(
    `SELECT
      tri.object_key AS objectKey,
      MAX(tri.url) AS url,
      MIN(tri.created_at) AS firstSeenAt,
      MAX(tri.created_at) AS lastSeenAt,
      MIN(tri.deleted_at) AS deletedAt,
      SUM(CASE WHEN tri.deleted_at IS NULL THEN 1 ELSE 0 END) AS activeCount,
      COUNT(*) AS referenceCount,
      users.email AS email
     FROM task_reference_images tri
     LEFT JOIN users ON users.id = tri.user_id
     GROUP BY tri.object_key
     ORDER BY lastSeenAt DESC
     LIMIT ?`,
  )
    .bind(limit)
    .all();

  const now = Date.now();
  const images = (rows.results || []).map((row) => {
    const uploadedAt = referenceTimestampFromKey(row.objectKey) || new Date(row.firstSeenAt).getTime();
    const expiresAt = uploadedAt ? new Date(uploadedAt + REFERENCE_IMAGE_TTL_MS).toISOString() : null;
    return {
      ...row,
      deletedAt: row.deletedAt || null,
      expiresAt,
      isExpired: Boolean(uploadedAt && uploadedAt + REFERENCE_IMAGE_TTL_MS < now),
    };
  });
  return json({ images });
}

async function deleteReferenceImage(request, env) {
  requireAdmin(request, env);
  const body = await readJson(request);
  const objectKey = String(body.objectKey || "");
  if (!objectKey.startsWith("references/")) throw httpError(400, "参考图路径不正确。");

  if (env.REFERENCE_IMAGES) {
    await env.REFERENCE_IMAGES.delete(objectKey);
  }
  await env.DB.prepare(
    "UPDATE task_reference_images SET deleted_at = ? WHERE object_key = ? AND deleted_at IS NULL",
  )
    .bind(nowIso(), objectKey)
    .run();
  return json({ ok: true });
}

async function listUsers(request, env) {
  requireAdmin(request, env);
  const url = new URL(request.url);
  const q = normalizeEmail(url.searchParams.get("q"));
  const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get("limit") || "50", 10)));

  const where = q ? "WHERE email LIKE ?" : "";
  const params = q ? [`%${q}%`, limit] : [limit];
  const rows = await env.DB.prepare(
    `SELECT id, email, is_member AS isMember, daily_quota AS dailyQuota,
      total_quota AS totalQuota, used_total AS usedTotal,
      video_quota AS videoQuota, video_used AS videoUsed,
      member_expires_at AS memberExpiresAt, created_at AS createdAt,
      updated_at AS updatedAt
     FROM users
     ${where}
     ORDER BY created_at DESC
     LIMIT ?`,
  )
    .bind(...params)
    .all();

  const users = [];
  for (const user of rows.results || []) {
    users.push(await publicUser(env, user.id));
  }
  return json({ users });
}

function requireAdmin(request, env) {
  if (!isAdminRequest(request, env)) {
    throw httpError(401, "管理员令牌不正确。");
  }
}

function isAdminRequest(request, env) {
  const adminToken = request.headers.get("x-admin-token") || "";
  return Boolean(env.ADMIN_TOKEN && adminToken === env.ADMIN_TOKEN);
}

async function requireUser(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) throw httpError(401, "请先登录。");
  const row = await env.DB.prepare(
    `SELECT users.*
     FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.token = ? AND sessions.expires_at > ?`,
  )
    .bind(token, nowIso())
    .first();
  if (!row) throw httpError(401, "登录已过期，请重新登录。");
  return row;
}

async function publicUser(env, userId) {
  const user = await env.DB.prepare(
    `SELECT id, email, is_member AS isMember, daily_quota AS dailyQuota,
      total_quota AS totalQuota, used_total AS usedTotal,
      video_quota AS videoQuota, video_used AS videoUsed,
      member_expires_at AS memberExpiresAt, created_at AS createdAt
     FROM users WHERE id = ?`,
  )
    .bind(userId)
    .first();
  if (!user) return null;

  const today = todayKey();
  const usage = await env.DB.prepare("SELECT used_count AS usedToday FROM usage_days WHERE user_id = ? AND day = ?")
    .bind(userId, today)
    .first();
  const isExpired = user.memberExpiresAt && new Date(user.memberExpiresAt).getTime() < Date.now();
  return {
    ...user,
    isMember: Boolean(user.isMember) && !isExpired,
    usedToday: usage?.usedToday || 0,
  };
}

async function ensureQuota(env, user, amount) {
  if (user.dailyQuota != null && user.usedToday + amount > user.dailyQuota) {
    throw httpError(403, "今日生成次数不足。");
  }
  if (user.totalQuota != null && user.usedTotal + amount > user.totalQuota) {
    throw httpError(403, "总生成次数不足。");
  }
}

async function ensureVideoQuota(env, user) {
  if (user.videoQuota != null && user.videoUsed + 1 > user.videoQuota) {
    throw httpError(403, "视频生成次数不足，请联系管理员开通。");
  }
}

async function consumeQuota(env, userId, amount) {
  const today = todayKey();
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET used_total = used_total + ?, updated_at = ? WHERE id = ?")
      .bind(amount, nowIso(), userId),
    env.DB.prepare(
      `INSERT INTO usage_days (user_id, day, used_count, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, day)
       DO UPDATE SET used_count = used_count + excluded.used_count, updated_at = excluded.updated_at`,
    ).bind(userId, today, amount, nowIso()),
  ]);
}

async function consumeVideoQuota(env, userId) {
  await env.DB.prepare("UPDATE users SET video_used = video_used + 1, updated_at = ? WHERE id = ?")
    .bind(nowIso(), userId)
    .run();
}

function validateSize(size) {
  const ratios = new Set(["auto", "1:1", "3:2", "2:3", "16:9", "9:16", "1:2", "2:1", "4:3", "3:4", "5:4", "4:5"]);
  if (ratios.has(size)) return size;
  const match = size.match(/^(\d+)x(\d+)$/);
  if (!match) throw httpError(400, "尺寸格式不正确。");
  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  if (width < 16 || width > 3840 || height < 16 || height > 3840) {
    throw httpError(400, "自定义尺寸每条边必须在 16 到 3840 之间。");
  }
  if (width % 16 !== 0 || height % 16 !== 0) {
    throw httpError(400, "自定义宽度和高度都必须能被 16 整除。");
  }
  if (pixels < 655360 || pixels > 8294400) {
    throw httpError(400, "自定义尺寸像素预算必须在 655,360 到 8,294,400 之间。");
  }
  return size;
}

function validateBananaImageSize(imageSize) {
  const sizes = new Set(["1K", "2K", "4K"]);
  if (sizes.has(imageSize)) return imageSize;
  throw httpError(400, "Banana2 分辨率不正确。");
}

function validateBananaAspectRatio(aspectRatio) {
  const ratios = new Set(["16:9", "9:16", "1:1", "4:3", "3:4"]);
  if (ratios.has(aspectRatio)) return aspectRatio;
  throw httpError(400, "Banana2 比例不正确。");
}

function validateEnum(value, allowed, message) {
  if (allowed.includes(value)) return value;
  throw httpError(400, message);
}

function normalizeStatus(payload) {
  return String(
    payload?.status ||
      payload?.state ||
      payload?.data?.status ||
      payload?.data?.state ||
      payload?.task?.status ||
      payload?.task?.state ||
      payload?.data?.task?.status ||
      payload?.data?.task?.state ||
      "",
  ).toLowerCase();
}

function normalizeImages(payload) {
  const candidates = [
    payload?.data?.images,
    payload?.images,
    payload?.data?.output,
    payload?.output,
    payload?.data?.result,
    payload?.result,
  ];
  return candidates
    .flatMap((item) => (Array.isArray(item) ? item : item ? [item] : []))
    .map((item) => {
      if (typeof item === "string") return item;
      return item?.url || item?.image_url || item?.b64_json || "";
    })
    .filter(Boolean);
}

function normalizeVideos(payload) {
  const candidates = [
    payload?.data?.videos,
    payload?.data?.video,
    payload?.videos,
    payload?.video,
    payload?.data?.output,
    payload?.output,
    payload?.data?.result,
    payload?.result,
  ];
  return candidates
    .flatMap((item) => (Array.isArray(item) ? item : item ? [item] : []))
    .map((item) => {
      if (typeof item === "string") return item;
      return item?.url || item?.video_url || item?.file_url || item?.video?.url || "";
    })
    .filter(Boolean);
}

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
  return arrayBufferToHex(bits);
}

function arrayBufferToHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw httpError(400, "请求 JSON 格式不正确。");
  }
}

async function parseJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function clampInt(value, min, max) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function nullableInt(value, fallback) {
  if (value === null) return null;
  if (value === undefined || value === "") return fallback;
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? number : fallback;
}

function getCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  return cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function nowIso() {
  return new Date().toISOString();
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}
