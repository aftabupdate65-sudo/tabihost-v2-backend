// server.mjs
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import AdmZip from "adm-zip";
import httpProxy from "http-proxy";
import fs from "fs";
import path from "path";
import { v4 as uuid } from "uuid";
import rateLimit from "express-rate-limit";

import { supabase } from "./supabase.mjs";
import { requireApiKey } from "./auth.mjs";
import { uploadFile, downloadFile, createDeploymentFolder } from "./gdrive.mjs";
import {
  buildImage, runContainer, removeContainer,
  containerStatus, containerLogs, getFreePort,
} from "./docker.mjs";

dotenv.config();

const app  = express();
const PORT = process.env.PORT || 3000;

const WORK_DIR    = path.resolve("./workspaces");
const UPLOAD_DIR  = path.resolve("./uploads");
[WORK_DIR, UPLOAD_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

app.use(cors());
app.use(express.json());

/* ── Rate limits ── */
const limiter = rateLimit({ windowMs: 60_000, max: 30 });

/* ── Multer (ZIP upload, max 50MB) ── */
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    if (file.mimetype === "application/zip" ||
        file.originalname.endsWith(".zip")) return cb(null, true);
    cb(new Error("Only .zip files allowed."));
  },
});

/* ── Proxy server (routes /run/:userId/* to containers) ── */
const proxy = httpProxy.createProxyServer({ timeout: 30_000 });
proxy.on("error", (err, req, res) => {
  console.error("[proxy] error:", err.message);
  if (!res.headersSent) res.status(502).json({ error: "Container unreachable.", details: err.message });
});

/* ── In-memory port map: userId → port ── */
const portMap = new Map(); // userId → port

async function loadPortMap() {
  const { data } = await supabase
    .from("deployments")
    .select("user_id, container_port")
    .eq("status", "running");
  if (data) data.forEach(d => { if (d.container_port) portMap.set(d.user_id, d.container_port); });
  console.log(`[init] Loaded ${portMap.size} running deployments into port map.`);
}

/* ═══════════════════════════════════════════════
   ROUTES
   ═══════════════════════════════════════════════ */

/* Health check */
app.get("/", (_, res) => res.json({ status: "ok", service: "Tabi Host v2" }));

/* ── 1. UPLOAD & DEPLOY ── */
app.post("/api/deploy", limiter, upload.single("code"), async (req, res) => {
  const { userId, label } = req.body;

  if (!req.file) return res.status(400).json({ error: "No ZIP file uploaded." });
  if (!userId)  return res.status(400).json({ error: "userId is required." });

  const deployId    = uuid();
  const imageTag    = `tabihost_${deployId.replace(/-/g, "").slice(0, 16)}`;
  const workDir     = path.join(WORK_DIR, deployId);
  const zipPath     = req.file.path;

  // Placeholder deployment row
  await supabase.from("deployments").insert({
    id: deployId, user_id: userId,
    label: label || "My API",
    status: "building",
  });

  // Respond immediately so frontend doesn't time out
  res.json({ success: true, deployId, message: "Build started. Poll /api/deploy/:id/status." });

  // ── Background build + run ──
  (async () => {
    try {
      // 1. Unzip
      fs.mkdirSync(workDir, { recursive: true });
      const zip = new AdmZip(zipPath);
      zip.extractAllTo(workDir, true);
      fs.unlinkSync(zipPath);

      // Check Dockerfile exists
      if (!fs.existsSync(path.join(workDir, "Dockerfile"))) {
        throw new Error("No Dockerfile found in ZIP root. Please include a Dockerfile.");
      }

      // 2. Upload to Drive
      const driveFolder = await createDeploymentFolder(
        `tabihost_${deployId}`,
        process.env.GDRIVE_PARENT_FOLDER_ID || null
      );
      await uploadFile(zipPath.replace(/[^/]+$/, '') + req.file.originalname,
        req.file.originalname, "application/zip", driveFolder
      ).catch(() => {}); // non-fatal if zip already moved

      await supabase.from("deployments").update({ drive_folder_id: driveFolder }).eq("id", deployId);

      // 3. Generate API key
      const apiKeyVal = "tabi_" + uuid().replace(/-/g, "");
      const { data: keyData } = await supabase
        .from("api_keys")
        .insert({ user_id: userId, api_key: apiKeyVal, label: label || "My API" })
        .select().single();

      await supabase.from("deployments").update({ api_key_id: keyData.id }).eq("id", deployId);

      // 4. Docker build
      await buildImage(workDir, imageTag);

      // 5. Get free port & run
      const port = await getFreePort();
      portMap.set(userId, port);
      const containerId = await runContainer(imageTag, port);

      // 6. Update DB
      await supabase.from("deployments").update({
        status: "running",
        container_id: containerId,
        container_port: port,
      }).eq("id", deployId);

      console.log(`[deploy] ${deployId} running on port ${port}`);

    } catch (err) {
      console.error("[deploy] failed:", err.message);
      await supabase.from("deployments").update({
        status: "failed",
        error_message: err.message,
      }).eq("id", deployId);
    } finally {
      // Cleanup workspace
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  })();
});

/* ── 2. DEPLOYMENT STATUS ── */
app.get("/api/deploy/:id/status", limiter, async (req, res) => {
  const { data, error } = await supabase
    .from("deployments")
    .select("id, status, error_message, container_port, api_key_id, created_at, label, api_keys(api_key)")
    .eq("id", req.params.id)
    .single();

  if (error || !data) return res.status(404).json({ error: "Deployment not found." });

  res.json({
    success: true,
    deployment: {
      id: data.id,
      label: data.label,
      status: data.status,
      error: data.error_message,
      apiKey: data.api_keys?.api_key || null,
      endpoint: data.status === "running"
        ? `${process.env.PUBLIC_URL || `http://localhost:${PORT}`}/run/${data.user_id}/`
        : null,
      createdAt: data.created_at,
    }
  });
});

/* ── 3. LIST USER DEPLOYMENTS ── */
app.get("/api/deployments/:userId", limiter, async (req, res) => {
  const { data, error } = await supabase
    .from("deployments")
    .select("id, label, status, error_message, container_port, created_at, api_keys(api_key)")
    .eq("user_id", req.params.userId)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const base = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
  res.json({
    success: true,
    deployments: (data || []).map(d => ({
      id: d.id, label: d.label, status: d.status,
      error: d.error_message,
      apiKey: d.api_keys?.api_key || null,
      endpoint: d.status === "running" ? `${base}/run/${req.params.userId}/` : null,
      createdAt: d.created_at,
    }))
  });
});

/* ── 4. CONTAINER LOGS ── */
app.get("/api/deploy/:id/logs", requireApiKey, async (req, res) => {
  const { data } = await supabase
    .from("deployments")
    .select("container_id, user_id")
    .eq("id", req.params.id)
    .single();

  if (!data) return res.status(404).json({ error: "Not found." });
  if (data.user_id !== req.userId) return res.status(403).json({ error: "Forbidden." });

  const logs = await containerLogs(data.container_id);
  res.json({ success: true, logs });
});

/* ── 5. STOP / DELETE DEPLOYMENT ── */
app.delete("/api/deploy/:id", async (req, res) => {
  // Auth: accept either x-api-key header OR userId in body (for building/failed deploys that have no key yet)
  let userId = null;

  const apiKey = req.headers["x-api-key"];
  if (apiKey) {
    const { data: keyData } = await supabase
      .from("api_keys").select("user_id, is_active").eq("api_key", apiKey).single();
    if (keyData && keyData.is_active) userId = keyData.user_id;
  }

  // Fallback: userId from request body
  if (!userId && req.body?.userId) userId = req.body.userId;

  if (!userId) return res.status(401).json({ error: "Unauthorized." });

  const { data } = await supabase
    .from("deployments")
    .select("container_id, user_id, container_port")
    .eq("id", req.params.id)
    .single();

  if (!data) return res.status(404).json({ error: "Not found." });
  if (data.user_id !== userId) return res.status(403).json({ error: "Forbidden." });

  if (data.container_id) await removeContainer(data.container_id).catch(()=>{});
  if (data.container_port) portMap.delete(userId);

  await supabase.from("deployments").delete().eq("id", req.params.id);
  res.json({ success: true });
});

/* ── 6. API KEY MANAGEMENT ── */
app.get("/api/keys/:userId", limiter, async (req, res) => {
  const { data, error } = await supabase
    .from("api_keys")
    .select("id, api_key, label, is_active, created_at")
    .eq("user_id", req.params.userId)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, keys: data || [] });
});

/* ── 7. PROXY — /run/:userId/* → container ── */
app.all("/run/:userId/*", async (req, res) => {
  // Validate API key
  const apiKey = req.headers["x-api-key"];
  if (!apiKey) return res.status(401).json({ error: "Missing x-api-key header." });

  const { data: keyData } = await supabase
    .from("api_keys")
    .select("user_id, is_active")
    .eq("api_key", apiKey)
    .single();

  if (!keyData || !keyData.is_active)
    return res.status(401).json({ error: "Invalid or disabled API key." });

  // Key must belong to the userId in the URL (users can only call their own API)
  if (keyData.user_id !== req.params.userId)
    return res.status(403).json({ error: "This key cannot access this deployment." });

  const port = portMap.get(req.params.userId);
  if (!port) return res.status(503).json({ error: "No running deployment found for this user." });

  // Strip /run/:userId prefix, proxy rest to container
  req.url = req.url.replace(`/run/${req.params.userId}`, "") || "/";

  const start = Date.now();

  proxy.web(req, res, { target: `http://127.0.0.1:${port}` }, async (err) => {
    // Log request (best effort)
    await supabase.from("request_logs").insert({
      user_id: keyData.user_id,
      method: req.method,
      path: req.url,
      status_code: res.statusCode,
      duration_ms: Date.now() - start,
    }).catch(() => {});
  });
});

/* ── START ── */
app.listen(PORT, async () => {
  console.log(`Tabi Host v2 running on port ${PORT}`);
  await loadPortMap();
});
