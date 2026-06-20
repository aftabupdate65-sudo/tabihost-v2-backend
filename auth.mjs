// auth.mjs
import { supabase } from "./supabase.mjs";

export async function requireApiKey(req, res, next) {
  const key = req.headers["x-api-key"];
  if (!key) return res.status(401).json({ error: "Missing x-api-key header." });

  const { data, error } = await supabase
    .from("api_keys")
    .select("id, user_id, is_active")
    .eq("api_key", key)
    .single();

  if (error || !data) return res.status(401).json({ error: "Invalid API key." });
  if (!data.is_active) return res.status(403).json({ error: "API key is disabled." });

  req.apiKey = data;
  req.userId = data.user_id;
  next();
}
