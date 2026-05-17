import test from "node:test";
import assert from "node:assert/strict";

import {
  BUILT_IN_REWARD_PRESETS,
  ACTIVE_REFRESH_MS,
  IDLE_REFRESH_MS,
  PENDING_CONFIRMATION_REFRESH_MS,
  VIDEO_REFRESH_MS,
  artifactBelongsToRun,
  buildRunMetadataPatch,
  buildTrainingJob,
  canOperate,
  hasActiveRemoteWork,
  hasPendingTrainingConfirmation,
  hasVideoRefreshPulse,
  isMachineFresh,
  jobQueueLabel,
  jobRunId,
  latestTensorboardSummaryArtifactForRun,
  latestVideoArtifact,
  machineState,
  refreshDelayForSnapshot,
  shouldReplaceVideoPanel,
  slugify,
  tensorboardSummaryStateForRun,
  videoArtifactForCheckpoint,
  videoStateForCheckpoint,
  videoStateForRun,
} from "./core.js";
import {
  historyTimeValue,
  historyRunsForSnapshot,
  jobClientRequestId,
  realRunConfirmsJob,
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
    clientRequestId: "child-123",
    params: { task: "T", num_envs: 4, max_iterations: 8, device: "cuda:0", display_name: "Launch A", folder: "tests" },
    preset: { id: "speed", values: { rew_scale_forward_vel: 5 } },
  });
  assert.equal(job.type, "start_training");
  assert.equal(job.payload.display_name, "Launch A");
  assert.equal(job.payload.folder, "tests");
  assert.equal(jobClientRequestId(job), "child-123");
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

test("auto refresh briefly speeds up while training waits for mother confirmation", () => {
  const now = new Date().toISOString();
  const pending = { id: "job-a", type: "start_training", status: "queued", created_at: now, payload: { display_name: "launch-a" } };
  assert.equal(hasPendingTrainingConfirmation({ jobs: [pending], runs: [] }), true);
  assert.equal(refreshDelayForSnapshot({ jobs: [pending], runs: [], machine: { gpu_locked: false } }), PENDING_CONFIRMATION_REFRESH_MS);
  assert.equal(
    hasPendingTrainingConfirmation({ jobs: [{ ...pending, result: { local_run_id: "panel-a" } }], runs: [{ id: "panel-a" }] }),
    false,
  );
});

test("auto refresh briefly speeds up while video is recording or uploading", () => {
  const nowMs = Date.parse("2026-05-16T00:20:00Z");
  const videoJob = { id: "video-job", type: "record_video", status: "completed", updated_at: "2026-05-16T00:19:00Z" };
  const uploadingRun = { id: "run-a", latest_video: "/tmp/clip.mp4", video_status: "completed" };
  assert.equal(hasVideoRefreshPulse({ jobs: [videoJob], runs: [], artifacts: [] }, nowMs), true);
  assert.equal(refreshDelayForSnapshot({ jobs: [], runs: [uploadingRun], artifacts: [] }), VIDEO_REFRESH_MS);
  assert.equal(
    hasVideoRefreshPulse({
      jobs: [],
      runs: [uploadingRun],
      artifacts: [{ run_id: "run-a", kind: "video", storage_path: "runs/run-a/videos/clip.mp4" }],
    }, nowMs),
    false,
  );
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

test("video artifacts must belong to the selected run and log directory", () => {
  const run = {
    id: "run-a",
    log_dir: "/logs/run-a",
    latest_checkpoint: "/logs/run-a/model_7.pt",
  };
  const ownVideo = {
    run_id: "run-a",
    kind: "video",
    local_path: "/logs/run-a/videos/play/model_7_clip.mp4",
    storage_path: "runs/run-a/videos/model_7_clip.mp4",
    created_at: "2026-05-16T00:00:00Z",
  };
  const leakedVideo = {
    run_id: "run-a",
    kind: "video",
    local_path: "/logs/other-run/videos/play/model_7_clip.mp4",
    storage_path: "runs/run-a/videos/model_7_other.mp4",
    created_at: "2026-05-17T00:00:00Z",
  };
  assert.equal(artifactBelongsToRun(run, ownVideo), true);
  assert.equal(artifactBelongsToRun(run, leakedVideo), false);
  assert.equal(videoArtifactForCheckpoint(run, [leakedVideo, ownVideo], run.latest_checkpoint), ownVideo);
});

test("tensorboard summary artifacts must belong to the selected run and log directory", () => {
  const run = {
    id: "run-a",
    log_dir: "/logs/run-a",
  };
  const ownSummary = {
    run_id: "run-a",
    kind: "tensorboard_summary",
    local_path: "/logs/run-a/training_panel/tensorboard_summary.png",
    public_url: "https://mother.example.com/api/runs/run-a/tensorboard-summary.png",
    created_at: "2026-05-16T00:00:00Z",
  };
  const leakedSummary = {
    run_id: "run-a",
    kind: "tensorboard_summary",
    local_path: "/logs/other-run/training_panel/tensorboard_summary.png",
    public_url: "https://mother.example.com/api/runs/other-run/tensorboard-summary.png",
    created_at: "2026-05-17T00:00:00Z",
  };
  assert.equal(latestTensorboardSummaryArtifactForRun(run, [leakedSummary, ownSummary]), ownSummary);
  assert.equal(tensorboardSummaryStateForRun(run, [leakedSummary, ownSummary]).url, ownSummary.public_url);
  assert.equal(tensorboardSummaryStateForRun({ id: "run-a", has_tensorboard: true }, []).state, "generating");
});

test("checkpoint video selection does not fall back to a different checkpoint video", () => {
  const run = {
    id: "run-a",
    log_dir: "/logs/run-a",
    latest_checkpoint: "/logs/run-a/model_9.pt",
  };
  const olderVideo = {
    run_id: "run-a",
    kind: "video",
    local_path: "/logs/run-a/videos/play/model_7_clip.mp4",
    storage_path: "runs/run-a/videos/model_7_clip.mp4",
    created_at: "2026-05-17T00:00:00Z",
  };
  assert.equal(videoArtifactForCheckpoint(run, [olderVideo], run.latest_checkpoint), null);
  assert.equal(videoStateForCheckpoint(run, [olderVideo], run.latest_checkpoint).state, "recordable");
  assert.equal(videoStateForRun({ ...run, latest_video: "/logs/other-run/videos/play/model_9_clip.mp4" }, []).state, "recordable");
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

test("history sort can switch between newest, oldest, and name", () => {
  const snapshot = {
    runs: [
      { id: "run-b", display_name: "Zeta", created_at: "2026-05-16T00:00:00Z", updated_at: "2026-05-16T00:00:00Z" },
      { id: "run-a", display_name: "Alpha", created_at: "2026-05-15T00:00:00Z", updated_at: "2026-05-17T00:00:00Z" },
    ],
    jobs: [],
    runDeletions: [],
  };
  assert.equal(historyTimeValue(snapshot.runs[1]), Date.parse("2026-05-15T00:00:00Z"));
  assert.deepEqual(historyRunsForSnapshot(snapshot, { sortBy: "newest" }).map((run) => run.id), ["run-b", "run-a"]);
  assert.deepEqual(historyRunsForSnapshot(snapshot, { sortBy: "time" }).map((run) => run.id), ["run-b", "run-a"]);
  assert.deepEqual(historyRunsForSnapshot(snapshot, { sortBy: "oldest" }).map((run) => run.id), ["run-a", "run-b"]);
  assert.deepEqual(historyRunsForSnapshot(snapshot, { sortBy: "name" }).map((run) => run.id), ["run-a", "run-b"]);
});

test("history only shows fresh unconfirmed training jobs as pending placeholders", () => {
  const nowMs = Date.parse("2026-05-16T00:20:00Z");
  const jobs = [
    { id: "fresh", type: "start_training", status: "queued", created_at: "2026-05-16T00:15:00Z", payload: { display_name: "New request" } },
    { id: "old", type: "start_training", status: "queued", created_at: "2026-05-15T23:00:00Z", payload: { display_name: "Old request" } },
    { id: "done", type: "start_training", status: "completed", created_at: "2026-05-16T00:10:00Z", result: { local_run_id: "panel_run" }, payload: {} },
    { id: "failed", type: "start_training", status: "failed", created_at: "2026-05-16T00:18:00Z", payload: {} },
  ];
  const synthetic = syntheticRunsFromJobs(jobs, [], [], { nowMs });
  assert.equal(synthetic.length, 1);
  assert.equal(synthetic[0].job_id, "fresh");
  assert.equal(synthetic[0].pending_confirmation, true);
  assert.equal(synthetic[0].display_name, "New request");
});

test("local optimistic pending training jobs appear before Supabase refresh", () => {
  const nowMs = Date.parse("2026-05-16T00:20:00Z");
  const localPending = [{
    id: "local:child-123",
    type: "start_training",
    status: "queued",
    created_at: "2026-05-16T00:20:00Z",
    payload: { client_request_id: "child-123", display_name: "Launch A", folder: "tests" },
  }];
  const runs = historyRunsForSnapshot({ runs: [], jobs: [], runDeletions: [] }, { localPendingTrainingJobs: localPending, nowMs });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, "job:local:child-123");
  assert.equal(runs[0].folder, "tests");
  assert.equal(runs[0].pending_confirmation, true);
});

test("remote queued job replaces local optimistic pending job", () => {
  const nowMs = Date.parse("2026-05-16T00:20:00Z");
  const localPending = {
    id: "local:child-123",
    type: "start_training",
    status: "queued",
    created_at: "2026-05-16T00:20:00Z",
    payload: { client_request_id: "child-123", display_name: "Launch A" },
  };
  const remoteJob = {
    id: "remote-job",
    type: "start_training",
    status: "queued",
    created_at: "2026-05-16T00:20:01Z",
    payload: { client_request_id: "child-123", display_name: "Launch A" },
  };
  const runs = historyRunsForSnapshot({ runs: [], jobs: [remoteJob], runDeletions: [] }, { localPendingTrainingJobs: [localPending], nowMs });
  assert.deepEqual(runs.map((run) => run.id), ["job:remote-job"]);
});

test("pending training placeholder disappears once a matching real run syncs", () => {
  const nowMs = Date.parse("2026-05-16T00:20:00Z");
  const job = {
    id: "fresh",
    type: "start_training",
    status: "running",
    created_at: "2026-05-16T00:15:00Z",
    payload: {
      display_name: "Named launch",
      task: "Template-Redrhex-Direct-v0",
      num_envs: 4,
      max_iterations: 8,
      device: "cuda:0",
      reward_preset_id: "baseline",
      terrain_preset_id: "baseline",
      client_request_id: "child-123",
    },
  };
  const realRun = {
    id: "panel_20260516_001505_123456",
    display_name: "Named launch",
    created_at: "2026-05-16T00:15:05Z",
    updated_at: "2026-05-16T00:15:05Z",
    params: job.payload,
  };
  assert.equal(realRunConfirmsJob(job, [realRun]), true);
  assert.deepEqual(syntheticRunsFromJobs([job], [realRun], [], { nowMs }), []);
});

test("blank pending training is not hidden by an older run with matching params", () => {
  const nowMs = Date.parse("2026-05-16T00:20:00Z");
  const payload = { task: "Template-Redrhex-Direct-v0", num_envs: 4, max_iterations: 8, device: "cuda:0" };
  const job = {
    id: "fresh-blank",
    type: "start_training",
    status: "queued",
    created_at: "2026-05-16T00:20:00Z",
    payload,
  };
  const olderRun = {
    id: "old-run",
    created_at: "2026-05-16T00:00:00Z",
    updated_at: "2026-05-16T00:00:00Z",
    params: payload,
  };
  assert.equal(realRunConfirmsJob(job, [olderRun]), false);
  assert.equal(syntheticRunsFromJobs([job], [olderRun], [], { nowMs }).length, 1);
});
