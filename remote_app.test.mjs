import test from "node:test";
import assert from "node:assert/strict";

import {
  BUILT_IN_REWARD_PRESETS,
  ACTIVE_REFRESH_MS,
  IDLE_REFRESH_MS,
  buildRunMetadataPatch,
  buildTrainingJob,
  canOperate,
  hasActiveRemoteWork,
  isMachineFresh,
  jobQueueLabel,
  jobRunId,
  latestVideoArtifact,
  machineState,
  refreshDelayForSnapshot,
  shouldReplaceVideoPanel,
  slugify,
  videoStateForRun,
} from "./core.js";
import {
  filterDeletedRuns,
  historyRunsForSnapshot,
  syntheticRunsFromJobs,
} from "./history_sync.js";

test("role helpers keep viewers read-only", () => {
  assert.equal(canOperate("viewer"), false);
  assert.equal(canOperate("operator"), true);
  assert.equal(canOperate("admin"), true);
});

test("machine freshness classifies stale heartbeat", () => {
  const recent = { heartbeat_at: new Date("2026-05-16T00:00:00Z").toISOString(), accept_jobs: true };
  const stale = { heartbeat_at: new Date("2026-05-15T23:00:00Z").toISOString(), accept_jobs: true };
  assert.equal(isMachineFresh(recent, Date.parse("2026-05-16T00:01:00Z")), true);
  assert.equal(machineState(recent, Date.parse("2026-05-16T00:01:00Z")), "ready");
  assert.equal(machineState(stale, Date.parse("2026-05-16T00:02:00Z")), "offline");
});

test("training job includes reward snapshot", () => {
  const job = buildTrainingJob({
    machineId: "lab-pc",
    role: "operator",
    userId: "user-one",
    requesterLabel: "phone user",
    params: { task: "T", num_envs: 4, max_iterations: 8, device: "cuda:0" },
    preset: { id: "speed", values: { rew_scale_forward_vel: 5 } },
  });
  assert.equal(job.type, "start_training");
  assert.equal(job.payload.reward_preset_id, "speed");
  assert.deepEqual(job.payload.reward_overrides, { rew_scale_forward_vel: 5 });
  assert.equal(job.payload.requester_id, "user-one");
  assert.equal(job.payload.requester_label, "phone user");
});

test("latest video artifact prefers newest storage record", () => {
  const artifact = latestVideoArtifact("run-a", [
    { run_id: "run-a", kind: "video", storage_path: "old.mp4", created_at: "2026-05-15T00:00:00Z" },
    { run_id: "run-a", kind: "video", storage_path: "new.mp4", created_at: "2026-05-16T00:00:00Z" },
  ]);
  assert.equal(artifact.storage_path, "new.mp4");
});

test("auto refresh interval follows active queue and GPU state", () => {
  assert.equal(refreshDelayForSnapshot({ jobs: [], machine: { gpu_locked: false } }), IDLE_REFRESH_MS);
  assert.equal(refreshDelayForSnapshot({ jobs: [{ status: "queued" }], machine: { gpu_locked: false } }), ACTIVE_REFRESH_MS);
  assert.equal(refreshDelayForSnapshot({ jobs: [], machine: { gpu_locked: true } }), ACTIVE_REFRESH_MS);
  assert.equal(hasActiveRemoteWork({ jobs: [{ status: "completed" }], machine: { gpu_locked: false } }), false);
});

test("job labels explain why a job is waiting", () => {
  const fresh = { heartbeat_at: new Date().toISOString(), accept_jobs: true, gpu_locked: true };
  assert.equal(jobQueueLabel({ status: "queued", type: "start_training" }, fresh), "waiting for GPU");
  assert.equal(jobQueueLabel({ status: "queued", type: "stop_process" }, fresh), "waiting for worker");
  assert.equal(jobQueueLabel({ status: "completed", type: "start_training" }, fresh), "launched");
  assert.equal(jobQueueLabel({ status: "failed", error: "boom" }, fresh), "boom");
});

test("job run id helper reads launched job result payloads", () => {
  assert.equal(jobRunId({ result: { payload: { id: "panel_run" } } }), "panel_run");
  assert.equal(jobRunId({ result: { local_run_id: "panel_run" } }), "panel_run");
  assert.equal(jobRunId({ payload: { run_id: "existing_run" } }), "existing_run");
});

test("run metadata patch trims fields and includes updated_at", () => {
  const patch = buildRunMetadataPatch({
    displayName: "  gait run  ",
    folder: "  tests  ",
    notes: "observed wobble",
    now: new Date("2026-05-16T00:00:00Z"),
  });
  assert.deepEqual(patch, {
    display_name: "gait run",
    folder: "tests",
    notes: "observed wobble",
    updated_at: "2026-05-16T00:00:00.000Z",
  });
});

test("video state distinguishes ready, uploading, recordable, and missing", () => {
  assert.equal(videoStateForRun({ id: "run-a" }, []).state, "missing");
  assert.equal(videoStateForRun({ id: "run-a", latest_checkpoint: "/tmp/model.pt" }, []).state, "recordable");
  assert.equal(videoStateForRun({ id: "run-a", latest_video: "/tmp/clip.mp4" }, []).state, "uploading");
  assert.equal(videoStateForRun({ id: "run-a" }, [
    { run_id: "run-a", kind: "video", storage_path: "runs/run-a/videos/clip.mp4" },
  ]).state, "ready");
});

test("video panel patching preserves active playback", () => {
  assert.equal(shouldReplaceVideoPanel({
    currentState: "ready",
    currentStorage: "runs/run-a/videos/clip.mp4",
    nextState: "ready",
    nextStorage: "runs/run-a/videos/clip.mp4",
    isPlaying: true,
  }), false);
  assert.equal(shouldReplaceVideoPanel({
    currentState: "uploading",
    currentStorage: "",
    nextState: "ready",
    nextStorage: "runs/run-a/videos/clip.mp4",
    isPlaying: false,
  }), true);
});

test("slugify returns stable storage-safe ids", () => {
  assert.equal(slugify("Speed Focus Copy"), "speed-focus-copy");
});

test("built-in preset fallback keeps training usable before schema update", () => {
  assert.equal(BUILT_IN_REWARD_PRESETS.length >= 3, true);
  assert.equal(BUILT_IN_REWARD_PRESETS[0].id, "baseline");
});

test("history tombstones hide deleted real runs by log directory name", () => {
  const visible = filterDeletedRuns([
    { id: "run-a", log_dir: "/repo/logs/rsl_rl/redrhex/2026-05-17_keep" },
    { id: "run-b", log_dir: "/repo/logs/rsl_rl/redrhex/2026-05-17_delete_me" },
  ], [
    { id: "alias-b", log_dir_name: "2026-05-17_delete_me" },
  ]);
  assert.deepEqual(visible.map((run) => run.id), ["run-a"]);
});

test("history tombstones keep old completed jobs from recreating deleted runs", () => {
  const jobs = [
    {
      id: "job-one",
      type: "start_training",
      status: "completed",
      created_at: "2026-05-17T00:00:00Z",
      result: { local_run_id: "panel_20260517_deleted" },
      payload: { display_name: "Deleted child launch" },
    },
  ];
  assert.deepEqual(syntheticRunsFromJobs(jobs, [], [{ id: "panel_20260517_deleted" }]), []);
  assert.deepEqual(historyRunsForSnapshot({ jobs, runs: [], runDeletions: [{ id: "panel_20260517_deleted" }] }), []);
});
