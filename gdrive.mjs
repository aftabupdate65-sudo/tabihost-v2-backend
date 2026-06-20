// gdrive.mjs
import { google } from "googleapis";
import fs from "fs";

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

/**
 * Creates a folder in Drive for a deployment.
 */
export async function createDeploymentFolder(name, parentId = null) {
  const drive = getDrive();
  const meta = { name, mimeType: "application/vnd.google-apps.folder" };
  if (parentId) meta.parents = [parentId];
  const res = await drive.files.create({ resource: meta, fields: "id" });
  return res.data.id;
}

/**
 * Uploads a file (ZIP) to a Drive folder.
 */
export async function uploadFile(localPath, fileName, mimeType, folderId) {
  const drive = getDrive();
  const res = await drive.files.create({
    resource: { name: fileName, parents: folderId ? [folderId] : [] },
    media: { mimeType, body: fs.createReadStream(localPath) },
    fields: "id",
  });
  return res.data.id;
}

/**
 * Downloads a file from Drive to a local path.
 */
export async function downloadFile(fileId, destPath) {
  const drive = getDrive();
  const dest = fs.createWriteStream(destPath);
  const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "stream" });
  await new Promise((resolve, reject) => {
    res.data.pipe(dest);
    dest.on("finish", resolve);
    dest.on("error", reject);
  });
}
