// server.mjs — Tabi Host v3 (Supabase storage, Piston execution)
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
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_, f, cb) => {
    if (f.originalname.endsWith(".zip")) return cb(null, true);
    cb(new Error("Only .zip files allowed"));
  },
});

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

/* ── Health ── */
app.get("/", (_, res) => res.json({
  status: "ok",
  service: "Tabi Host v3",
  languages: Object.keys(SUPPORTED_LANGUAGES),
}));

app.get("/api/languages", (_, res) => res.json({ languages: SUPPORTED_LANGUAGES }));

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
    // Unzip and read files
    const zip = new AdmZip(req.file.path);
    const entries = zip.getEntries().filter(e => !e.isDirectory);
    if (!entries.length) throw new Error("ZIP is empty.");

    // Convert files to [{name, content}] array
    const files = entries.map(e => ({
      name: e.entryName,
      content: e.getData().toString("utf8"),
    }));

    fs.unlinkSync(req.file.path);

    const entry_file = entryFile || entries[0].entryName;

    // Generate API key
    const apiKeyVal = "tabi_" + uuid().replace(/-/g, "");
    const { data: keyData } = await supabase
      .from("api_keys")
      .insert({ user_id: userId, api_key: apiKeyVal, label: label || "My API" })
      .select().single();

    // Save deployment + code files in Supabase
    const { data: deploy } = await supabase
      .from("deployments")
      .insert({
        user_id: userId,
        api_key_id: keyData.id,
        label: label || "My API",
        language,
        entry_file,
        code_files: JSON.stringify(files), // store code directly in Supabase
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
      files: files.map(f => f.name),
    });

  } catch (err) {
    console.error("[deploy/zip]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════
   DEPLOY — Code editor
   ══════════════════════════════════════ */
app.post("/api/deploy/code", limiter, async (req, res) => {
  const { userId, label, language, files } = req.body;

  if (!userId)   return res.status(400).json({ error: "userId required." });
  if (!language) return res.status(400).json({ error: "language required." });
  if (!files?.length) return res.status(400).json({ error: "files required." });
  if (!SUPPORTED_LANGUAGES[language]) return res.status(400).json({ error: `Language "${language}" not supported.` });

  try {
    const apiKeyVal = "tabi_" + uuid().replace(/-/g, "");
    const { data: keyData } = await supabase
      .from("api_keys")
      .insert({ user_id: userId, api_key: apiKeyVal, label: label || "My API" })
      .select().single();

    const { data: deploy } = await supabase
      .from("deployments")
      .insert({
        user_id: userId,
        api_key_id: keyData.id,
        label: label || "My API",
        language,
        entry_file: files[0].name,
        code_files: JSON.stringify(files),
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
   RUN — Execute deployed code
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
  if (deploy.status !== "active") return res.status(400).json({ error: "Deployment not active." });
  if (deploy.user_id !== keyData.user_id) return res.status(403).json({ error: "Forbidden." });

  const stdin = req.body?.stdin || req.body?.input || "";

  try {
    const start = Date.now();

    // Get code files from Supabase
    const files = JSON.parse(deploy.code_files || "[]");
    if (!files.length) throw new Error("No code files found.");

    // Run via Piston
    const result = await runCode(deploy.language, files, String(stdin), deploy.entry_file);
    const duration = Date.now() - start;

    // Log (best effort)
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
    .select("id, label, language, entry_file, status, created_at, api_keys(api_key)")
    .eq("user_id", req.params.userId)
    .eq("status", "active")
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const base = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
  res.json({
    success: true,
    deployments: (data || []).map(d => ({
      id: d.id, label: d.label, language: d.language,
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
    .select("user_id")
    .eq("id", req.params.id)
    .single();

  if (!data) return res.status(404).json({ error: "Not found." });
  if (data.user_id !== userId) return res.status(403).json({ error: "Forbidden." });

  await supabase.from("deployments").update({ status: "deleted" }).eq("id", req.params.id);
  res.json({ success: true });
});

/* ══════════════════════════════════════
   LOGS
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

app.listen(PORT, () => console.log(`Tabi Host v3 running on port ${PORT}`));
