"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function jobsRoot(root) {
  return path.join(root, "jobs-meta");
}

function resultsRoot(root, cfg) {
  return path.join(path.resolve(root, cfg.inbox || "inbox"), "jobs");
}

function ensureJobDirs(root, cfg) {
  fs.mkdirSync(jobsRoot(root), { recursive: true });
  fs.mkdirSync(resultsRoot(root, cfg), { recursive: true });
}

function jobPath(root, id) {
  return path.join(jobsRoot(root), `${id}.json`);
}

function newId() {
  return crypto.randomBytes(8).toString("hex");
}

function readJob(root, id) {
  const p = jobPath(root, id);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJob(root, job) {
  const p = jobPath(root, job.id);
  fs.writeFileSync(p, JSON.stringify(job, null, 2));
  return job;
}

function listJobs(root, limit = 50) {
  const dir = jobsRoot(root);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at)))
    .slice(0, limit);
}

function createJob(root, cfg, body) {
  ensureJobDirs(root, cfg);
  const id = body.id || newId();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
    throw new Error("invalid id");
  }
  const type = body.type;
  const allowed = ["locate", "fetch_path", "gitlab_fetch", "agent_prompt"];
  if (!allowed.includes(type)) throw new Error("invalid type");
  const now = new Date().toISOString();
  const job = {
    id,
    status: "queued",
    from: body.from || "unknown",
    type,
    prompt: body.prompt || null,
    query: body.query || null,
    repo: body.repo || null,
    ref: body.ref || null,
    path: body.path || null,
    timeout_sec: body.timeout_sec || 600,
    progress: null,
    result_paths: [],
    error: null,
    created_at: now,
    updated_at: now,
  };
  fs.mkdirSync(path.join(resultsRoot(root, cfg), id), { recursive: true });
  return writeJob(root, job);
}

function updateJob(root, id, patch) {
  const job = readJob(root, id);
  if (!job) return null;
  Object.assign(job, patch, { updated_at: new Date().toISOString() });
  return writeJob(root, job);
}

function claimNext(root, types) {
  const jobs = listJobs(root, 200).filter(
    (j) => j.status === "queued" && (!types || types.includes(j.type))
  );
  // oldest first
  jobs.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const next = jobs[0];
  if (!next) return null;
  return updateJob(root, next.id, { status: "running", progress: "claimed" });
}

module.exports = {
  ensureJobDirs,
  resultsRoot,
  readJob,
  writeJob,
  listJobs,
  createJob,
  updateJob,
  claimNext,
};
