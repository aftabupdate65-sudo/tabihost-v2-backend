// piston.mjs — Piston API se user code run karta hai
// Piston: https://github.com/engineer-man/piston (free, no auth needed)

const PISTON_URL = "https://emkc.org/api/v2/piston";

// Supported languages with their Piston runtime names
export const SUPPORTED_LANGUAGES = {
  javascript: { language: "javascript", version: "18.15.0", ext: "js" },
  python:     { language: "python",     version: "3.10.0",  ext: "py" },
  typescript: { language: "typescript", version: "5.0.3",   ext: "ts" },
  go:         { language: "go",         version: "1.16.2",  ext: "go" },
  rust:       { language: "rust",       version: "1.50.0",  ext: "rs" },
  php:        { language: "php",        version: "8.2.3",   ext: "php" },
  ruby:       { language: "ruby",       version: "3.0.1",   ext: "rb" },
  java:       { language: "java",       version: "15.0.2",  ext: "java" },
  c:          { language: "c",          version: "10.2.0",  ext: "c" },
  cpp:        { language: "c++",        version: "10.2.0",  ext: "cpp" },
  bash:       { language: "bash",       version: "5.2.0",   ext: "sh" },
};

/**
 * Run code via Piston API.
 * @param {string} language - e.g. "python", "javascript"
 * @param {Array<{name: string, content: string}>} files - code files
 * @param {string} stdin - optional stdin input
 * @param {string} entryFile - which file to run (for multi-file)
 */
export async function runCode(language, files, stdin = "", entryFile = null) {
  const lang = SUPPORTED_LANGUAGES[language];
  if (!lang) throw new Error(`Language "${language}" not supported.`);

  // Piston files format
  const pistonFiles = files.map((f, i) => ({
    name: f.name,
    content: f.content,
  }));

  // Entry file should be first in array
  if (entryFile) {
    const idx = pistonFiles.findIndex(f => f.name === entryFile);
    if (idx > 0) {
      const [entry] = pistonFiles.splice(idx, 1);
      pistonFiles.unshift(entry);
    }
  }

  const body = {
    language: lang.language,
    version: lang.version,
    files: pistonFiles,
    stdin,
    args: [],
    compile_timeout: 10000,
    run_timeout: 5000,
    compile_memory_limit: -1,
    run_memory_limit: -1,
  };

  const res = await fetch(`${PISTON_URL}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Piston API error: ${res.status}`);

  const data = await res.json();

  return {
    stdout: data.run?.stdout || "",
    stderr: data.run?.stderr || "",
    exitCode: data.run?.code ?? -1,
    compile: data.compile || null,
  };
}

// Get all available runtimes from Piston
export async function getRuntimes() {
  const res = await fetch(`${PISTON_URL}/runtimes`);
  return res.json();
}
