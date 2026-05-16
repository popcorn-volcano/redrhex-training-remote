import { HEARTBEAT_STALE_MS } from "./config.js";

export const BUILT_IN_REWARD_PRESETS = [
  {
    id: "baseline",
    name: "Baseline",
    description: "The current default reward configuration. Good starting point for comparison runs.",
    values: {},
    built_in: true,
  },
  {
    id: "speed-focus",
    name: "Speed Focus",
    description: "Emphasises forward velocity and tracking. Faster but may be less stable.",
    values: {
      rew_scale_forward_vel: 5.0,
      rew_scale_vel_tracking: 6.0,
      rew_scale_ang_vel_tracking: 3.5,
      rew_scale_orientation: -0.1,
      rew_scale_base_height: -0.1,
    },
    built_in: true,
  },
  {
    id: "stability-focus",
    name: "Stability Focus",
    description: "Strongly penalises tilting and height deviation for early stability.",
    values: {
      rew_scale_forward_vel: 1.5,
      rew_scale_vel_tracking: 2.0,
      rew_scale_orientation: -0.6,
      rew_scale_base_height: -0.6,
      rew_scale_lin_vel_z: -0.3,
      rew_scale_alive: 0.3,
    },
    built_in: true,
  },
];

export const REWARD_FIELDS = [
  {
    name: "Locomotion Goals",
    fields: [
      ["rew_scale_forward_vel", "Forward Velocity", "Rewards movement in the commanded direction."],
      ["rew_scale_vel_tracking", "Linear Tracking", "Rewards matching the commanded XY velocity."],
      ["rew_scale_ang_vel_tracking", "Turn Tracking", "Rewards matching commanded yaw rate."],
      ["rew_scale_vel_tracking2", "Aux Tracking", "Secondary velocity tracking term."],
      ["rew_scale_direction_align", "Direction Alignment", "Rewards movement aligned with command direction."],
    ],
  },
  {
    name: "Rotation And Legs",
    fields: [
      ["rew_scale_rotation_direction", "In-place Rotation", "Extra reward for correct in-place turns."],
      ["rew_scale_smooth_rotation", "Smooth Rotation", "Rewards smooth rotation without abrupt changes."],
      ["rew_scale_rotation_dir", "Leg Direction", "Rewards legs rotating in the correct direction."],
      ["rew_scale_all_legs", "All Legs Active", "Encourages all legs to participate."],
      ["rew_scale_min_leg_vel", "Minimum Leg Speed", "Keeps the slowest leg moving."],
      ["rew_scale_mean_leg_vel", "Mean Leg Speed", "Rewards average leg rotation speed."],
    ],
  },
  {
    name: "Stability",
    fields: [
      ["rew_scale_orientation", "Body Tilt Penalty", "Penalizes body tilt away from upright."],
      ["rew_scale_base_height", "Height Penalty", "Penalizes body height deviation."],
      ["rew_scale_lin_vel_z", "Bounce Penalty", "Penalizes vertical bouncing."],
      ["rew_scale_ang_vel_xy", "Roll/Pitch Penalty", "Penalizes roll and pitch wobble."],
      ["rew_scale_collision", "Body Collision", "Penalizes body-ground collisions."],
    ],
  },
  {
    name: "Gait And Control",
    fields: [
      ["rew_scale_gait_coherence", "Tripod Coherence", "Rewards sync within tripod groups."],
      ["rew_scale_gait_phase_offset", "Tripod Antiphase", "Rewards classic alternating tripod phase."],
      ["rew_scale_continuous_support", "Ground Contact", "Rewards continuous support."],
      ["rew_scale_abad_action", "ABAD Motion", "Rewards ABAD response to commands."],
      ["rew_scale_abad_stability", "ABAD Symmetry", "Rewards useful ABAD symmetry/asymmetry."],
      ["rew_scale_alive", "Alive Bonus", "Small bonus while the robot is alive."],
      ["rew_scale_action_rate", "Action Smoothness", "Penalizes rapid command changes."],
      ["rew_scale_drive_acc", "Drive Accel Penalty", "Penalizes sudden drive acceleration."],
    ],
  },
];

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function slugify(value) {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `preset-${Date.now()}`;
}

export function canOperate(role) {
  return role === "operator" || role === "admin";
}

export function canEditPreset(role) {
  return canOperate(role);
}

export function canEditRun(role) {
  return canOperate(role);
}

export function isMachineFresh(machine, now = Date.now()) {
  if (!machine?.heartbeat_at) return false;
  const heartbeat = Date.parse(machine.heartbeat_at);
  return Number.isFinite(heartbeat) && now - heartbeat <= HEARTBEAT_STALE_MS;
}

export function machineState(machine, now = Date.now()) {
  if (!machine) return "missing";
  if (!isMachineFresh(machine, now)) return "offline";
  if (machine.accept_jobs) return machine.gpu_locked ? "busy" : "ready";
  return "paused";
}

export function statusTone(status) {
  const normalized = String(status || "").toLowerCase();
  if (["completed", "ready", "online", "accepting", "success"].includes(normalized)) return "good";
  if (["running", "claimed", "queued", "busy"].includes(normalized)) return "info";
  if (["failed", "cancelled", "offline", "missing"].includes(normalized)) return "bad";
  return "muted";
}

export function latestVideoArtifact(runId, artifacts = []) {
  const matches = artifacts
    .filter((artifact) => artifact.run_id === runId && artifact.kind === "video" && artifact.storage_path)
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  return matches[0] || null;
}

export function formatRelativeTime(iso, now = Date.now()) {
  if (!iso) return "unknown";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return String(iso);
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function buildTrainingJob({ machineId, params, preset, role, userId }) {
  const rewardValues = preset?.values && typeof preset.values === "object" ? preset.values : {};
  return {
    machine_id: machineId || null,
    type: "start_training",
    actor_id: userId || null,
    actor_role: role || "viewer",
    payload: {
      ...params,
      headless: true,
      reward_preset_id: preset?.id || "baseline",
      reward_overrides: rewardValues,
    },
  };
}

export function buildActionJob({ machineId, type, runId, role, userId }) {
  return {
    machine_id: machineId || null,
    type,
    actor_id: userId || null,
    actor_role: role || "viewer",
    payload: { run_id: runId },
  };
}

export function normalizePreset(raw) {
  return {
    id: String(raw?.id || ""),
    name: String(raw?.name || raw?.id || "Preset"),
    description: String(raw?.description || ""),
    values: raw?.values && typeof raw.values === "object" ? raw.values : {},
    built_in: Boolean(raw?.built_in),
    updated_at: raw?.updated_at || raw?.created_at || "",
  };
}
