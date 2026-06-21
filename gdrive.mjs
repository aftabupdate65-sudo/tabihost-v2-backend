// gdrive.mjs — code files GDrive pe store/fetch karta hai
import { google } from "googleapis";
import fs from "fs";
import path from "path";
import { Readable } from "stream";

let _drive = null;

function getDrive() {
  if (_drive) return _drive;
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  _drive = google.drive({ version: "v3", auth });
  return _drive;
}

// Create a folder in Drive
export async function createFolder(name, parentId = null) {
  const drive = getDrive();
  const meta = { name, mimeType: "application/vnd.google-apps.folder" };
  if (parentId) meta.parents = [parentId];
  const res = await drive.files.create({ resource: meta, fields: "id" });
  return res.data.id;
}

// Upload a single file to Drive
export async function uploadFile(localPath, fileName, folderId = null) {
  const drive = getDrive();
  const meta = { name: fileName };
  if (folderId) meta.parents = [folderId];
  const res = await drive.files.create({
    resource: meta,
    media: { body: fs.createReadStream(localPath) },
    fields: "id",
  });
  return res.data.id;
}

// Upload code content (string) directly to Drive (no local file needed)
export async function uploadContent(content, fileName, folderId = null) {
  const drive = getDrive();
  const meta = { name: fileName };
  if (folderId) meta.parents = [folderId];
  const stream = Readable.from([content]);
  const res = await drive.files.create({
    resource: meta,
    media: { body: stream },
    fields: "id",
  });
  return res.data.id;
}

// Download file content from Drive as string
export async function fetchFileContent(fileId) {
  const drive = getDrive();
  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "text" }
  );
  return res.data;
}

// List files in a Drive folder
export async function listFolder(folderId) {
  const drive = getDrive();
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false`,
    fields: "files(id, name)",
  });
  return res.data.files || [];
}

// Delete a file or folder from Drive
export async function deleteFile(fileId) {
  const drive = getDrive();
  await drive.files.delete({ fileId }).catch(() => {});
}
