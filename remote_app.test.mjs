import test from "node:test";
import assert from "node:assert/strict";

import {
  BUILT_IN_REWARD_PRESETS,
  buildTrainingJob,
  canOperate,
  isMachineFresh,
  latestVideoArtifact,
  machineState,
  slugify,
} from "./core.js";

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
    params: { task: "T", num_envs: 4, max_iterations: 8, device: "cuda:0" },
    preset: { id: "speed", values: { rew_scale_forward_vel: 5 } },
  });
  assert.equal(job.type, "start_training");
  assert.equal(job.payload.reward_preset_id, "speed");
  assert.deepEqual(job.payload.reward_overrides, { rew_scale_forward_vel: 5 });
});

test("latest video artifact prefers newest storage record", () => {
  const artifact = latestVideoArtifact("run-a", [
    { run_id: "run-a", kind: "video", storage_path: "old.mp4", created_at: "2026-05-15T00:00:00Z" },
    { run_id: "run-a", kind: "video", storage_path: "new.mp4", created_at: "2026-05-16T00:00:00Z" },
  ]);
  assert.equal(artifact.storage_path, "new.mp4");
});

test("slugify returns stable storage-safe ids", () => {
  assert.equal(slugify("Speed Focus Copy"), "speed-focus-copy");
});

test("built-in preset fallback keeps training usable before schema update", () => {
  assert.equal(BUILT_IN_REWARD_PRESETS.length >= 3, true);
  assert.equal(BUILT_IN_REWARD_PRESETS[0].id, "baseline");
});
