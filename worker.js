#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const jobs = require("./jobs");

const ROOT = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const LOG = path.join(ROOT, "logs", "worker.log");

function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}\n`;
  try {
    fs.appendFileSync(LOG, msg);
  } catch {}
  process.stdout.write(msg);
}

function copyIntoResults(job, srcAbs, name) {
  const destDir = path.join(jobs.resultsRoot(ROOT, cfg), job.id);
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, name || path.basename(srcAbs));
  fs.copyFileSync(srcAbs, dest);
  return `jobs/${job.id}/${path.basename(dest)}`.replace(/\\/g, "/");
}

function handleLocate(job) {
  const query = job.query || job.prompt;
  if (!query) throw new Error("query required");
  const roots = [
    path.join(ROOT, "inbox"),
    path.join(ROOT, "outbox"),
    path.join(process.env.USERPROFILE || "", "Desktop"),
    path.join(process.env.USERPROFILE || "", "Downloads"),
  ].filter((p) => p && fs.existsSync(p));
  const hits = [];
  function walk(dir, depth) {
    if (depth > 6 || hits.length >= 20) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith(".")) continue;
      const full = path.join(dir, ent.name);
      if (ent.name.toLowerCase().includes(String(query).toLowerCase())) {
        hits.push(full);
      }
      if (ent.isDirectory()) walk(full, depth + 1);
    }
  }
  for (const r of roots) walk(r, 0);
  const manifest = path.join(jobs.resultsRoot(ROOT, cfg), job.id, "locate.json");
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ query, hits }, null, 2));
  const paths = [`jobs/${job.id}/locate.json`];
  if (hits[0] && fs.existsSync(hits[0]) && fs.statSync(hits[0]).isFile()) {
    paths.push(copyIntoResults(job, hits[0]));
  }
  return paths;
}

function handleFetchPath(job) {
  const p = job.path;
  if (!p) throw new Error("path required");
  const abs = path.isAbsolute(p) ? p : path.join(process.env.USERPROFILE || "", p);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error("file not found: " + abs);
  return [copyIntoResults(job, abs)];
}

function handleGitlab() {
  throw new Error("gitlab_fetch not supported on PC — use peer mac");
}

function handleAgentPrompt(job) {
  const prompt = job.prompt || job.query;
  if (!prompt) throw new Error("prompt required");
  const work = path.join(ROOT, "work", job.id);
  fs.mkdirSync(work, { recursive: true });
  const agentBin = ["agent.cmd", "agent", "cursor-agent"].find((b) => {
    const r = spawnSync(b, ["--help"], { shell: true, encoding: "utf8" });
    return r.status === 0 || (r.stdout || r.stderr);
  });
  if (!agentBin) {
    const note = path.join(jobs.resultsRoot(ROOT, cfg), job.id, "NOTE.txt");
    fs.mkdirSync(path.dirname(note), { recursive: true });
    fs.writeFileSync(note, "agent CLI not found on PC. Prompt was:\n" + prompt + "\n");
    return [`jobs/${job.id}/NOTE.txt`];
  }
  const r = spawnSync(
    agentBin,
    ["-p", "--trust", "--workspace", work, "--force", prompt],
    { encoding: "utf8", shell: true, timeout: (job.timeout_sec || 600) * 1000 }
  );
  const out = path.join(jobs.resultsRoot(ROOT, cfg), job.id, "agent-stdout.txt");
  fs.writeFileSync(out, (r.stdout || "") + "\n" + (r.stderr || ""));
  return [`jobs/${job.id}/agent-stdout.txt`];
}

function processJob(job) {
  log(`run ${job.id} type=${job.type}`);
  let result_paths;
  switch (job.type) {
    case "locate":
      result_paths = handleLocate(job);
      break;
    case "fetch_path":
      result_paths = handleFetchPath(job);
      break;
    case "gitlab_fetch":
      result_paths = handleGitlab(job);
      break;
    case "agent_prompt":
      result_paths = handleAgentPrompt(job);
      break;
    default:
      throw new Error("unknown type");
  }
  jobs.updateJob(ROOT, job.id, { status: "done", progress: "finished", result_paths, error: null });
  log(`done ${job.id} -> ${result_paths.join(",")}`);
}

async function loop() {
  jobs.ensureJobDirs(ROOT, cfg);
  log("worker started");
  for (;;) {
    try {
      const job = jobs.claimNext(ROOT);
      if (!job) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      try {
        processJob(job);
      } catch (e) {
        jobs.updateJob(ROOT, job.id, {
          status: "error",
          error: String(e.message || e),
          progress: "failed",
        });
        log(`error ${job.id}: ${e.message || e}`);
      }
    } catch (e) {
      log(`loop error ${e.message || e}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

loop();
