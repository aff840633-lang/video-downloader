// server.js - Backend for the TikTok / Facebook downloader page.
// Needs only Node.js (no npm install). Uses yt-dlp (+ ffmpeg) to get the videos.
// Run:  node server.js   then open  http://localhost:3000

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { URL } = require("url");
const { Readable } = require("stream");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1"; // use HOST=0.0.0.0 to open from other devices on Wi-Fi
const YTDLP = process.env.YTDLP || "yt-dlp";
// Optional: put a cookies.txt (exported from your browser) next to server.js if Instagram asks for login
let COOKIES = process.env.COOKIES || path.join(__dirname, "cookies.txt");
if (process.env.COOKIES_B64) { // optional: base64 of cookies.txt set as a Render environment variable
  COOKIES = path.join(os.tmpdir(), "cookies.txt");
  fs.writeFileSync(COOKIES, Buffer.from(process.env.COOKIES_B64, "base64"), { mode: 0o600 });
}
const COOKIE_ARGS = fs.existsSync(COOKIES) ? ["--cookies", COOKIES] : [];
const COMMON = ["--retries", "3", "--socket-timeout", "30", "--no-warnings", "--no-playlist"];
// TikTok blocks many server IPs. --impersonate (needs curl-cffi, installed in the Dockerfile) makes yt-dlp look like Chrome.
const IMP = process.env.IMPERSONATE === "1" ? ["--impersonate", "chrome"] : [];
// Backup for TikTok when yt-dlp fails (third-party service)
const TIKWM = process.env.TIKWM_URL || "https://www.tikwm.com/api/";
const TIKWM_ORIGIN = new URL(TIKWM).origin;
const PROXY_HOSTS = ["tikwm.com", ...(process.env.PROXY_ALLOW || "").split(",").map((x) => x.trim()).filter(Boolean)];
const MAX_JOBS = 2; // how many downloads can run at the same time
const TMP = path.join(os.tmpdir(), "vd-downloads");

// Only these sites are allowed (same rules as index.html)
const RULES = {
  tiktok: /^https?:\/\/([\w-]+\.)?tiktok\.com\//i,
  facebook: /^https?:\/\/([\w-]+\.)?(facebook\.com|fb\.watch|fb\.com)\//i,
  instagram: /^https?:\/\/([\w-]+\.)?(instagram\.com|instagr\.am)\//i,
};

// What each download button means
const FORMATS = {
  hd: { args: ["-f", "bv*+ba/b", "--merge-output-format", "mp4"], ext: "mp4" },
  sd: { args: ["-f", "b[height<=480]/b", "--merge-output-format", "mp4"], ext: "mp4" },
  mp3: { args: ["-x", "--audio-format", "mp3"], ext: "mp3" },
};
const MIME = { mp4: "video/mp4", mp3: "audio/mpeg", webm: "video/webm", m4a: "audio/mp4" };

fs.mkdirSync(TMP, { recursive: true });
// clean leftovers from older runs
for (const d of fs.readdirSync(TMP)) fs.rmSync(path.join(TMP, d), { recursive: true, force: true });

let jobs = 0;

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

// Run yt-dlp safely (no shell) and collect its output
function runYtdlp(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(YTDLP, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("Timed out")); }, timeoutMs);
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e.code === "ENOENT" ? new Error("yt-dlp is not installed") : e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim().split("\n").pop() || "yt-dlp failed"));
    });
  });
}

// Run yt-dlp with impersonation; if impersonation itself is unavailable, retry without it
async function ytdlp(args, timeoutMs) {
  try {
    return await runYtdlp([...IMP, ...args], timeoutMs);
  } catch (e) {
    if (IMP.length && /impersonat/i.test(e.message)) return runYtdlp(args, timeoutMs);
    throw e;
  }
}

// Turn yt-dlp errors into short, clear messages
function friendly(msg) {
  const m = String(msg || "");
  if (/not installed/i.test(m)) return m;
  if (/timed out/i.test(m)) return "Took too long. Try again.";
  if (/unexpected response|report this issue/i.test(m)) return "TikTok did not answer the server. Try again in a minute.";
  if (/unsupported url/i.test(m)) return "This link type is not supported. Use a direct video link.";
  if (/private/i.test(m)) return "This video is private.";
  if (/login|log in|cookies|authenticat|rate-limit|empty media|sign in/i.test(m))
    return "This site asked for login, so this video can't be fetched from the server. Try another public link.";
  if (/unavailable|removed|deleted|not exist|404/i.test(m)) return "Video not found or removed.";
  if (/403|429|blocked|forbidden|too many/i.test(m)) return "The site blocked the server for now. Try again later.";
  return "Couldn't read this video. Check the link is public and try again.";
}

function checkUrl(mode, url) {
  return typeof url === "string" && url.length < 2000 && RULES[mode] && RULES[mode].test(url);
}

// ---- TikTok backup (used only when yt-dlp fails) ----
async function tiktokFallback(url) {
  const r = await fetch(TIKWM + "?hd=1&url=" + encodeURIComponent(url), {
    signal: AbortSignal.timeout(20000),
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!r.ok) throw new Error("fallback HTTP " + r.status);
  const j = await r.json();
  if (!j || j.code !== 0 || !j.data) throw new Error("fallback: " + (j && j.msg));
  const d = j.data;
  const abs = (p) => (p ? (String(p).startsWith("/") ? TIKWM_ORIGIN + p : String(p)) : "");
  const px = (p) => "/api/proxy?u=" + encodeURIComponent(abs(p));
  const links = [];
  const best = d.hdplay || d.play;
  if (best) links.push({ label: "Without watermark HD", url: px(best), type: "hd" });
  if (d.hdplay && d.play && d.play !== d.hdplay) links.push({ label: "Smaller size (SD)", url: px(d.play), type: "sd" });
  if (d.music) links.push({ label: "Download MP3", url: px(d.music), type: "mp3" });
  if (!links.length) throw new Error("fallback: no links");
  return {
    title: String(d.title || "Video").slice(0, 150),
    author: String((d.author && (d.author.nickname || d.author.unique_id)) || ""),
    thumbnail: abs(d.cover || ""),
    links,
  };
}

// GET /api/proxy?u=...  -> streams a file from an allowed host (only the TikTok backup's own files)
async function handleProxy(u, res) {
  let target;
  try { target = new URL(u.searchParams.get("u") || ""); } catch (_) { return sendJson(res, 400, { error: "Invalid request" }); }
  const hostOk = PROXY_HOSTS.some((h) => target.hostname === h || target.hostname.endsWith("." + h));
  if (!/^https?:$/.test(target.protocol) || !hostOk) return sendJson(res, 400, { error: "Invalid request" });
  try {
    const r = await fetch(target, { signal: AbortSignal.timeout(300000), headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok || !r.body) throw new Error("HTTP " + r.status);
    const ct = r.headers.get("content-type") || "application/octet-stream";
    const ext = /audio/i.test(ct) ? "mp3" : /video/i.test(ct) ? "mp4" : "bin";
    const h = {
      "Content-Type": ct,
      "Content-Disposition": `attachment; filename="tiktok-${Date.now()}.${ext}"`,
      "Cache-Control": "no-store",
    };
    if (r.headers.get("content-length")) h["Content-Length"] = r.headers.get("content-length");
    res.writeHead(200, h);
    const stream = Readable.fromWeb(r.body);
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  } catch (e) {
    console.error("proxy error:", e.message);
    if (!res.headersSent) sendJson(res, 502, { error: "Couldn't download this file. Try again." });
  }
}

// GET /api/tiktok?url=...  or  /api/facebook?url=...  or  /api/instagram?url=...
async function handleInfo(mode, u, res) {
  const url = (u.searchParams.get("url") || "").trim();
  if (!checkUrl(mode, url)) return sendJson(res, 400, { error: "Invalid link" });
  try {
    const raw = await ytdlp([...COOKIE_ARGS, ...COMMON, "-J", "--", url], 60000);
    const d = JSON.parse(raw);
    const q = encodeURIComponent(url);
    const links = [
      { label: "Without watermark HD", url: `/api/dl?mode=${mode}&type=hd&url=${q}`, type: "hd" },
      { label: "Smaller size (SD)", url: `/api/dl?mode=${mode}&type=sd&url=${q}`, type: "sd" },
      { label: "Download MP3", url: `/api/dl?mode=${mode}&type=mp3&url=${q}`, type: "mp3" },
    ];
    sendJson(res, 200, {
      title: String(d.title || d.description || "Video").slice(0, 150),
      author: String(d.uploader || d.channel || d.creator || ""),
      thumbnail: d.thumbnail || "",
      links,
    });
  } catch (e) {
    console.error("info error:", e.message);
    if (mode === "tiktok" && !/not installed/i.test(e.message)) {
      try {
        const fb = await tiktokFallback(url);
        return sendJson(res, 200, fb);
      } catch (e2) {
        console.error("fallback error:", e2.message);
      }
    }
    sendJson(res, e.message.includes("not installed") ? 500 : 502, { error: friendly(e.message) });
  }
}

// GET /api/dl?mode=...&type=hd|sd|mp3&url=...   -> sends the file
async function handleDownload(u, res) {
  const mode = u.searchParams.get("mode") || "";
  const type = u.searchParams.get("type") || "";
  const url = (u.searchParams.get("url") || "").trim();
  if (!checkUrl(mode, url) || !FORMATS[type]) return sendJson(res, 400, { error: "Invalid request" });
  if (jobs >= MAX_JOBS) return sendJson(res, 503, { error: "Busy, try again in a minute" });

  jobs++;
  const dir = fs.mkdtempSync(path.join(TMP, "d-"));
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    await ytdlp(
      [...COOKIE_ARGS, ...FORMATS[type].args, ...COMMON, "--restrict-filenames",
       "-o", path.join(dir, "video.%(ext)s"), "--", url],
      300000
    );
    const file = fs.readdirSync(dir).find((f) => !f.endsWith(".part"));
    if (!file) throw new Error("No file was created");
    const full = path.join(dir, file);
    const ext = path.extname(file).slice(1).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Length": fs.statSync(full).size,
      "Content-Disposition": `attachment; filename="${mode}-${Date.now()}.${ext}"`,
      "Cache-Control": "no-store",
    });
    const stream = fs.createReadStream(full);
    stream.pipe(res);
    res.on("close", () => { stream.destroy(); cleanup(); });
  } catch (e) {
    console.error("download error:", e.message);
    cleanup();
    sendJson(res, 502, { error: friendly(e.message) });
  } finally {
    jobs--;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed" });
    const u = new URL(req.url, "http://localhost");
    if (u.pathname === "/" || u.pathname === "/index.html") {
      const html = fs.readFileSync(path.join(__dirname, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(html);
    }
    if (u.pathname === "/health") return sendJson(res, 200, { ok: true });
    if (u.pathname === "/api/tiktok") return handleInfo("tiktok", u, res);
    if (u.pathname === "/api/facebook") return handleInfo("facebook", u, res);
    if (u.pathname === "/api/instagram") return handleInfo("instagram", u, res);
    if (u.pathname === "/api/dl") return handleDownload(u, res);
    if (u.pathname === "/api/proxy") return handleProxy(u, res);
    sendJson(res, 404, { error: "Not found" });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: "Server error" });
  }
});

// Keep yt-dlp fresh (sites change often): update 1 min after start and every 24h. Ignored if it fails.
function updateYtdlp() {
  if (process.env.AUTO_UPDATE === "0") return;
  const pip = process.env.YTDLP_PIP; // set in Dockerfile (pip-installed yt-dlp)
  const p = pip
    ? spawn(pip, ["install", "-U", "--quiet", "yt-dlp[default,curl-cffi]"], { stdio: "ignore" })
    : spawn(YTDLP, ["-U"], { stdio: "ignore" });
  p.on("error", () => {});
}
setTimeout(updateYtdlp, 60 * 1000).unref();
setInterval(updateYtdlp, 24 * 60 * 60 * 1000).unref();

// On Render the free service sleeps when idle: ping ourselves every 10 min so it stays awake.
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => fetch(process.env.RENDER_EXTERNAL_URL + "/health").catch(() => {}), 10 * 60 * 1000).unref();
}

server.listen(PORT, HOST, () => {
  console.log(`Server running -> http://localhost:${PORT}`);
  console.log("Stop with Ctrl+C");
});
