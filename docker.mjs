// docker.mjs
// Manages user containers via the Docker CLI (available on Railway VMs).
// Each deployment gets its own container on a unique internal port.

import { execFile } from "child_process";
import { promisify } from "util";
import net from "net";

const exec = promisify(execFile);

const PORT_START = 4000;
const PORT_END   = 4999;
const usedPorts  = new Set(); // in-memory; persisted in DB as backup

/* ── Find a free port ── */
export async function getFreePort() {
  for (let p = PORT_START; p <= PORT_END; p++) {
    if (usedPorts.has(p)) continue;
    const free = await isPortFree(p);
    if (free) { usedPorts.add(p); return p; }
  }
  throw new Error("No free ports available (4000-4999).");
}

function isPortFree(port) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => { srv.close(); resolve(true); });
    srv.listen(port, "127.0.0.1");
  });
}

/**
 * Build a Docker image from a directory.
 * @param {string} buildDir - local path containing Dockerfile + code
 * @param {string} imageTag - e.g. "tabihost_user123"
 */
export async function buildImage(buildDir, imageTag) {
  // Timeout: 10 minutes for build
  await exec("docker", ["build", "-t", imageTag, buildDir], {
    timeout: 10 * 60 * 1000,
    maxBuffer: 1024 * 1024 * 10,
  });
}

/**
 * Run a container from an image, exposing it on an internal port.
 * Returns the container ID.
 */
export async function runContainer(imageTag, port, envVars = {}) {
  const envArgs = Object.entries(envVars).flatMap(([k, v]) => ["-e", `${k}=${v}`]);

  const { stdout } = await exec("docker", [
    "run", "-d",
    "--restart", "unless-stopped",
    "-p", `127.0.0.1:${port}:${port}`,
    "-e", `PORT=${port}`,
    ...envArgs,
    "--name", imageTag,
    "--memory", "256m",        // memory cap per container
    "--cpus", "0.5",           // CPU cap
    "--network", "bridge",
    imageTag,
  ]);
  return stdout.trim();
}

/**
 * Stop and remove a container + its image.
 */
export async function removeContainer(containerName) {
  try { await exec("docker", ["stop", containerName]); } catch (_) {}
  try { await exec("docker", ["rm",   containerName]); } catch (_) {}
  try { await exec("docker", ["rmi",  containerName]); } catch (_) {}
}

/**
 * Get container running status.
 */
export async function containerStatus(containerName) {
  try {
    const { stdout } = await exec("docker", [
      "inspect", "--format", "{{.State.Status}}", containerName,
    ]);
    return stdout.trim(); // "running" | "exited" | "paused" etc.
  } catch (_) {
    return "not_found";
  }
}

/**
 * Get last N lines of container logs.
 */
export async function containerLogs(containerName, lines = 100) {
  try {
    const { stdout } = await exec("docker", [
      "logs", "--tail", String(lines), containerName,
    ]);
    return stdout;
  } catch (_) {
    return "";
  }
}
