import { jobDisplayStatus } from "./status_catalog.js?v=3.3.0-history-sync";

function clean(value) {
  return String(value || "").trim();
}

function basename(path) {
  const value = clean(path);
  if (!value) return "";
  return value.split(/[\\/]/).filter(Boolean).pop() || "";
}

export function normalizeRunDeletions(rows = []) {
  const ids = new Set();
  const logDirs = new Set();
  const logDirNames = new Set();
  const records = [];
  for (const row of rows || []) {
    const id = clean(row?.id);
    const logDir = clean(row?.log_dir);
    const logDirName = clean(row?.log_dir_name) || basename(logDir);
    if (id) ids.add(id);
    if (logDir) logDirs.add(logDir);
    if (logDirName) {
      ids.add(logDirName);
      logDirNames.add(logDirName);
    }
    records.push({ ...row, id, log_dir: logDir, log_dir_name: logDirName });
  }
  return { ids, logDirs, logDirNames, records };
}

export function jobRunId(job = {}) {
  const payload = job.payload && typeof job.payload === "object" ? job.payload : {};
  const result = job.result && typeof job.result === "object" ? job.result : {};
  const resultPayload = result.payload && typeof result.payload === "object" ? result.payload : {};
  return clean(
    payload.run_id
    || result.local_run_id
    || result.process_id
    || resultPayload.id
    || resultPayload.run_id
    || resultPayload.source_run_id
    || "",
  );
}

export function runDeletionKeys(run = {}) {
  const keys = {
    ids: [clean(run.id), clean(run.linked_run_id)],
    logDirs: [clean(run.log_dir)],
    logDirNames: [basename(run.log_dir)],
  };
  if (run.synthetic_job) {
    keys.ids.push(clean(run.linked_run_id));
  }
  return keys;
}

export function isDeletedRunLike(run = {}, deletions = normalizeRunDeletions()) {
  const keys = runDeletionKeys(run);
  return keys.ids.some((id) => id && deletions.ids.has(id))
    || keys.logDirs.some((logDir) => logDir && deletions.logDirs.has(logDir))
    || keys.logDirNames.some((name) => name && deletions.logDirNames.has(name));
}

export function filterDeletedRuns(runs = [], runDeletions = []) {
  const deletions = normalizeRunDeletions(runDeletions);
  return (runs || []).filter((run) => !isDeletedRunLike(run, deletions));
}

export function syntheticRunsFromJobs(jobs = [], realRuns = [], runDeletions = []) {
  const deletions = normalizeRunDeletions(runDeletions);
  const realIds = new Set((realRuns || []).map((run) => clean(run.id)).filter(Boolean));
  return (jobs || [])
    .filter((job) => job.type === "start_training")
    .filter((job) => {
      const linkedRunId = jobRunId(job);
      return !linkedRunId || !realIds.has(linkedRunId);
    })
    .filter((job) => ["queued", "claimed", "running", "completed", "failed"].includes(clean(job.status).toLowerCase()))
    .map((job) => {
      const payload = job.payload && typeof job.payload === "object" ? job.payload : {};
      const linkedRunId = jobRunId(job);
      const status = jobDisplayStatus(job);
      return {
        id: `job:${job.id}`,
        synthetic_job: true,
        job_id: job.id,
        linked_run_id: linkedRunId,
        source: "remote_job",
        status,
        display_name: payload.display_name || (status === "launched" ? "Training launched" : "Queued training"),
        created_at: job.created_at,
        updated_at: job.updated_at || job.created_at,
        folder: "",
        params: payload,
        created_by: job.actor_id || payload.requester_id || null,
      };
    })
    .filter((run) => !isDeletedRunLike(run, deletions));
}

export function historyRunsForSnapshot(snapshot = {}) {
  const runDeletions = snapshot.runDeletions || [];
  const realRuns = filterDeletedRuns(snapshot.runs || [], runDeletions);
  return [...syntheticRunsFromJobs(snapshot.jobs || [], realRuns, runDeletions), ...realRuns]
    .sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")));
}
