// server.mjs
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import AdmZip from "adm-zip";
import rateLimit from "express-rate-limit";
import fs from "fs";
import path from "path";
import { v4 as uuid } from "uuid";

import { supabase } from "./supabase.mjs";
import { runCode, SUPPORTED_LANGUAGES } from "./piston.mjs";
import {
  createFolder, uploadFile, uploadContent,
  fetchFileContent, listFolder, deleteFile
} from "./gdrive.mjs";

dotenv.config();

const app  = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_TMP = path.resolve("./tmp_uploads");
fs.mkdirSync(UPLOAD_TMP, { recursive: true });

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const limiter    = rateLimit({ windowMs: 60_000, max: 60 });
const runLimiter = rateLimit({ windowMs: 60_000, max: 20 });

const upload = multer({
  dest: UPLOAD_TMP,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (_, f, cb) => {
    if (f.originalname.endsWith(".zip")) return cb(null, true);
    cb(new Error("Only .zip files allowed"));
  },
});

/* ── Helper: validate API key ── */
async function validateKey(apiKey) {
  if (!apiKey) return null;
  const { data } = await supabase
    .from("api_keys")
    .select("id, user_id, is_active")
    .eq("api_key", apiKey)
    .single();
  if (!data || !data.is_active) return null;
  return data;
}

/* ══════════════════════════════════════
   HEALTH
   ══════════════════════════════════════ */
app.get("/", (_, res) => res.json({
  status: "ok",
  service: "Tabi Host v3 — Piston powered",
  languages: Object.keys(SUPPORTED_LANGUAGES),
}));

app.get("/api/languages", (_, res) => {
  res.json({ languages: SUPPORTED_LANGUAGES });
});

/* ══════════════════════════════════════
   DEPLOY — ZIP upload
   ══════════════════════════════════════ */
app.post("/api/deploy/zip", limiter, upload.single("code"), async (req, res) => {
  const { userId, label, language, entryFile } = req.body;

  if (!req.file) return res.status(400).json({ error: "No ZIP uploaded." });
  if (!userId)   return res.status(400).json({ error: "userId required." });
  if (!language) return res.status(400).json({ error: "language required." });
  if (!SUPPORTED_LANGUAGES[language]) return res.status(400).json({ error: `Language "${language}" not supported.` });

  try {
    // 1. Unzip
    const zip = new AdmZip(req.file.path);
    const entries = zip.getEntries().filter(e => !e.isDirectory);

    if (entries.length === 0) throw new Error("ZIP is empty.");

    // 2. Create Drive folder
    const folderName = `tabihost_${userId}_${Date.now()}`;
    const folderId = await createFolder(
      folderName,
      process.env.GDRIVE_PARENT_FOLDER_ID || null
    );

    // 3. Upload each file to Drive
    const tmpDir = path.join(UPLOAD_TMP, uuid());
    fs.mkdirSync(tmpDir, { recursive: true });

    for (const entry of entries) {
      const filePath = path.join(tmpDir, entry.entryName);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, entry.getData());
      await uploadFile(filePath, entry.entryName, folderId);
    }

    // Cleanup tmp
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.unlinkSync(req.file.path);

    // 4. Generate API key
    const apiKeyVal = "tabi_" + uuid().replace(/-/g, "");
    const { data: keyData } = await supabase
      .from("api_keys")
      .insert({ user_id: userId, api_key: apiKeyVal, label: label || "My API" })
      .select().single();

    // 5. Save deployment metadata to Supabase
    const entry_file = entryFile || entries[0].entryName;
    const { data: deploy } = await supabase
      .from("deployments")
      .insert({
        user_id: userId,
        api_key_id: keyData.id,
        label: label || "My API",
        language,
        entry_file,
        drive_folder_id: folderId,
        status: "active",
      })
      .select().single();

    res.json({
      success: true,
      deploymentId: deploy.id,
      apiKey: apiKeyVal,
      endpoint: `${process.env.PUBLIC_URL}/run/${deploy.id}`,
      language,
      entryFile: entry_file,
      files: entries.map(e => e.entryName),
    });

  } catch (err) {
    console.error("[deploy/zip]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════
   DEPLOY — Direct code editor
   ══════════════════════════════════════ */
app.post("/api/deploy/code", limiter, async (req, res) => {
  const { userId, label, language, files } = req.body;
  // files: [{ name: "main.py", content: "print('hello')" }, ...]

  if (!userId)   return res.status(400).json({ error: "userId required." });
  if (!language) return res.status(400).json({ error: "language required." });
  if (!files || !files.length) return res.status(400).json({ error: "files required." });
  if (!SUPPORTED_LANGUAGES[language]) return res.status(400).json({ error: `Language "${language}" not supported.` });

  try {
    // 1. Create Drive folder
    const folderId = await createFolder(
      `tabihost_${userId}_${Date.now()}`,
      process.env.GDRIVE_PARENT_FOLDER_ID || null
    );

    // 2. Upload each file content to Drive
    for (const file of files) {
      await uploadContent(file.content, file.name, folderId);
    }

    // 3. Generate API key
    const apiKeyVal = "tabi_" + uuid().replace(/-/g, "");
    const { data: keyData } = await supabase
      .from("api_keys")
      .insert({ user_id: userId, api_key: apiKeyVal, label: label || "My API" })
      .select().single();

    // 4. Save metadata
    const { data: deploy } = await supabase
      .from("deployments")
      .insert({
        user_id: userId,
        api_key_id: keyData.id,
        label: label || "My API",
        language,
        entry_file: files[0].name,
        drive_folder_id: folderId,
        status: "active",
      })
      .select().single();

    res.json({
      success: true,
      deploymentId: deploy.id,
      apiKey: apiKeyVal,
      endpoint: `${process.env.PUBLIC_URL}/run/${deploy.id}`,
      language,
      entryFile: files[0].name,
    });

  } catch (err) {
    console.error("[deploy/code]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════
   RUN — Execute user's deployed code
   POST /run/:deploymentId
   Header: x-api-key
   Body: { "stdin": "optional input" }
   ══════════════════════════════════════ */
app.post("/run/:deploymentId", runLimiter, async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  const keyData = await validateKey(apiKey);
  if (!keyData) return res.status(401).json({ error: "Invalid or missing API key." });

  const { data: deploy } = await supabase
    .from("deployments")
    .select("*")
    .eq("id", req.params.deploymentId)
    .single();

  if (!deploy) return res.status(404).json({ error: "Deployment not found." });
  if (deploy.status !== "active") return res.status(400).json({ error: "Deployment is not active." });
  if (deploy.user_id !== keyData.user_id) return res.status(403).json({ error: "Forbidden." });

  const stdin = req.body?.stdin || req.body?.input || "";

  try {
    const start = Date.now();

    // 1. Fetch code files from Drive
    let files = [];

    if (deploy.drive_folder_id) {
      // Multi-file: fetch all files from folder
      const driveFiles = await listFolder(deploy.drive_folder_id);
      files = await Promise.all(
        driveFiles.map(async f => ({
          name: f.name,
          content: await fetchFileContent(f.id),
        }))
      );
    } else if (deploy.drive_file_id) {
      // Single file
      const content = await fetchFileContent(deploy.drive_file_id);
      files = [{ name: deploy.entry_file, content }];
    }

    if (!files.length) throw new Error("No code files found in storage.");

    // 2. Run via Piston
    const result = await runCode(
      deploy.language,
      files,
      String(stdin),
      deploy.entry_file
    );

    const duration = Date.now() - start;

    // 3. Log to Supabase (best effort)
    await supabase.from("request_logs").insert({
      deployment_id: deploy.id,
      user_id: keyData.user_id,
      input_data: String(stdin).slice(0, 500),
      output_data: result.stdout.slice(0, 1000),
      exit_code: result.exitCode,
      run_time_ms: duration,
    }).catch(() => {});

    res.json({
      success: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      runTimeMs: duration,
      language: deploy.language,
    });

  } catch (err) {
    console.error("[run]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════
   LIST deployments
   ══════════════════════════════════════ */
app.get("/api/deployments/:userId", limiter, async (req, res) => {
  const { data, error } = await supabase
    .from("deployments")
    .select("*, api_keys(api_key)")
    .eq("user_id", req.params.userId)
    .eq("status", "active")
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const base = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
  res.json({
    success: true,
    deployments: (data || []).map(d => ({
      id: d.id,
      label: d.label,
      language: d.language,
      entryFile: d.entry_file,
      apiKey: d.api_keys?.api_key || null,
      endpoint: `${base}/run/${d.id}`,
      createdAt: d.created_at,
    })),
  });
});

/* ══════════════════════════════════════
   DELETE deployment
   ══════════════════════════════════════ */
app.delete("/api/deploy/:id", limiter, async (req, res) => {
  const userId = req.body?.userId;
  if (!userId) return res.status(400).json({ error: "userId required." });

  const { data } = await supabase
    .from("deployments")
    .select("user_id, drive_folder_id, drive_file_id")
    .eq("id", req.params.id)
    .single();

  if (!data) return res.status(404).json({ error: "Not found." });
  if (data.user_id !== userId) return res.status(403).json({ error: "Forbidden." });

  // Delete from Drive
  if (data.drive_folder_id) await deleteFile(data.drive_folder_id);
  if (data.drive_file_id)   await deleteFile(data.drive_file_id);

  // Soft delete in Supabase
  await supabase.from("deployments").update({ status: "deleted" }).eq("id", req.params.id);

  res.json({ success: true });
});

/* ══════════════════════════════════════
   REQUEST LOGS
   ══════════════════════════════════════ */
app.get("/api/logs/:deploymentId", limiter, async (req, res) => {
  const { data } = await supabase
    .from("request_logs")
    .select("*")
    .eq("deployment_id", req.params.deploymentId)
    .order("created_at", { ascending: false })
    .limit(50);

  res.json({ success: true, logs: data || [] });
});

/* ── START ── */
app.listen(PORT, () => console.log(`Tabi Host v3 running on port ${PORT}`));
