import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";

// ---------------------------------------------------------------------------
// AI Rehab Mirror — Browser-based pose analysis engine
// Runs MediaPipe Pose Landmarker (WASM) directly in the browser so the live
// site performs REAL pose estimation with no backend dependency.
// ---------------------------------------------------------------------------

export interface FrameAnalysis {
  detected: boolean;
  state: string;
  abduction_angle: number;
  torso_lean: number;
  symmetry: number;
  rep_count: number;
  feedback: string[];
  movement_score: number;
  left_angle: number;
  right_angle: number;
}

export interface RepSummary {
  rep_number: number;
  max_angle: number;
  hold_seconds: number;
  avg_torso_lean: number;
  symmetry: number;
  score: number;
  quality: string[];
}

export interface VideoAnalysisResult {
  rep_count: number;
  average_score: number;
  reps: RepSummary[];
}

// MediaPipe pose landmark indices (BlazePose 33)
const L_SHOULDER = 11;
const R_SHOULDER = 12;
const L_ELBOW = 13;
const R_ELBOW = 14;
const L_HIP = 23;
const R_HIP = 24;

// Shoulder abduction state machine thresholds
const RAISE_ANGLE = 20; // degrees to leave "Ready"
const HOLD_MIN_ANGLE = 60; // min angle to be considered "Holding"
const HOLD_TARGET_ANGLE = 90; // ideal abduction angle
const HOLD_MIN_SECONDS = 1.0; // hold duration required for a quality rep
const LOWER_ANGLE = 30; // below this returns to "Lowering" -> "Ready"
const TORSO_LEAN_LIMIT = 10; // degrees of torso lean tolerated

export type ExerciseState =
  | "Ready"
  | "Raising"
  | "Holding"
  | "Lowering"
  | "Completed";

interface Landmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function angleAt(a: Landmark, b: Landmark, c: Landmark): number {
  const v1 = { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
  const v2 = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };
  const dot = v1.x * v2.x + v1.y * v2.y + v1.z * v2.z;
  const m1 = Math.hypot(v1.x, v1.y, v1.z);
  const m2 = Math.hypot(v2.x, v2.y, v2.z);
  if (m1 === 0 || m2 === 0) return 0;
  const cos = Math.max(-1, Math.min(1, dot / (m1 * m2)));
  return (Math.acos(cos) * 180) / Math.PI;
}

// Shoulder abduction angle: angle at the shoulder between the hip and the elbow.
// 0° = arm down at side, 90° = arm raised to shoulder height.
function abductionAngle(shoulder: Landmark, hip: Landmark, elbow: Landmark): number {
  return angleAt(hip, shoulder, elbow);
}

// Torso lean: angle of the spine (shoulder-mid to hip-mid) relative to vertical.
function torsoLean(landmarks: Landmark[]): number {
  const shoulderMid = {
    x: (landmarks[L_SHOULDER].x + landmarks[R_SHOULDER].x) / 2,
    y: (landmarks[L_SHOULDER].y + landmarks[R_SHOULDER].y) / 2,
    z: (landmarks[L_SHOULDER].z + landmarks[R_SHOULDER].z) / 2,
  };
  const hipMid = {
    x: (landmarks[L_HIP].x + landmarks[R_HIP].x) / 2,
    y: (landmarks[L_HIP].y + landmarks[R_HIP].y) / 2,
    z: (landmarks[L_HIP].z + landmarks[R_HIP].z) / 2,
  };
  // Vertical reference: straight down from shoulderMid
  const vertical = { x: shoulderMid.x, y: shoulderMid.y + 1, z: shoulderMid.z };
  return angleAt(shoulderMid, hipMid, vertical);
}

// Left/right symmetry: difference between left and right abduction angles.
function symmetryPercent(left: number, right: number): number {
  const diff = Math.abs(left - right);
  const pct = Math.max(0, 100 - diff * 2.5);
  return Math.min(100, pct);
}

// ---------------------------------------------------------------------------
// Temporal smoothing (EMA) — mirrors the backend's landmark smoothing
// ---------------------------------------------------------------------------

class EMASmoother {
  private smoothed: Record<number, { x: number; y: number; z: number }> = {};
  private alpha = 0.5;

  smooth(landmarks: Landmark[]): Landmark[] {
    return landmarks.map((lm, i) => {
      const prev = this.smoothed[i];
      if (!prev) {
        this.smoothed[i] = { x: lm.x, y: lm.y, z: lm.z };
        return lm;
      }
      const s = {
        x: this.alpha * lm.x + (1 - this.alpha) * prev.x,
        y: this.alpha * lm.y + (1 - this.alpha) * prev.y,
        z: this.alpha * lm.z + (1 - this.alpha) * prev.z,
      };
      this.smoothed[i] = s;
      return s;
    });
  }

  reset() {
    this.smoothed = {};
  }
}

// ---------------------------------------------------------------------------
// Exercise state machine
// ---------------------------------------------------------------------------

export class ShoulderAbductionMachine {
  state: ExerciseState = "Ready";
  repCount = 0;
  private holdStart: number | null = null;
  private holdDuration = 0;
  private maxAngle = 0;
  private repQuality: string[] = [];
  private repScores: number[] = [];
  private lastCompletedAt = 0;
  private smoother = new EMASmoother();

  reset() {
    this.state = "Ready";
    this.repCount = 0;
    this.holdStart = null;
    this.holdDuration = 0;
    this.maxAngle = 0;
    this.repQuality = [];
    this.repScores = [];
    this.smoother.reset();
  }

  getReps(): RepSummary[] {
    return this.repScores.map((score, i) => ({
      rep_number: i + 1,
      max_angle: 0,
      hold_seconds: 0,
      avg_torso_lean: 0,
      symmetry: 100,
      score,
      quality: [],
    }));
  }

  // Process one frame of smoothed landmarks. Returns the analysis result.
  process(landmarks: Landmark[]): FrameAnalysis {
    const smoothed = this.smoother.smooth(landmarks);

    const leftAngle = abductionAngle(
      smoothed[L_SHOULDER],
      smoothed[L_HIP],
      smoothed[L_ELBOW]
    );
    const rightAngle = abductionAngle(
      smoothed[R_SHOULDER],
      smoothed[R_HIP],
      smoothed[R_ELBOW]
    );
    // Use the more-raised arm as the active side for the state machine.
    const activeAngle = Math.max(leftAngle, rightAngle);
    const lean = torsoLean(smoothed);
    const symmetry = symmetryPercent(leftAngle, rightAngle);

    const feedback: string[] = [];
    const now = performance.now() / 1000;

    // --- State transitions ---
    switch (this.state) {
      case "Ready":
        if (activeAngle > RAISE_ANGLE) {
          this.state = "Raising";
          this.maxAngle = activeAngle;
          this.repQuality = [];
        }
        break;

      case "Raising":
        this.maxAngle = Math.max(this.maxAngle, activeAngle);
        if (activeAngle >= HOLD_MIN_ANGLE) {
          this.state = "Holding";
          this.holdStart = now;
        } else if (activeAngle < RAISE_ANGLE) {
          // Went back down without reaching hold — reset
          this.state = "Ready";
        }
        break;

      case "Holding":
        this.maxAngle = Math.max(this.maxAngle, activeAngle);
        if (this.holdStart !== null) {
          this.holdDuration = now - this.holdStart;
        }
        if (activeAngle < LOWER_ANGLE) {
          this.state = "Lowering";
        }
        break;

      case "Lowering":
        if (activeAngle < RAISE_ANGLE) {
          // Rep completed
          this.state = "Ready";
          this.repCount += 1;
          this.lastCompletedAt = now;
          const score = this.computeScore();
          this.repScores.push(score);
          this.holdStart = null;
          this.holdDuration = 0;
          this.maxAngle = 0;
        }
        break;

      case "Completed":
        this.state = "Ready";
        break;
    }

    // --- Form feedback ---
    if (this.state === "Raising" || this.state === "Holding") {
      if (activeAngle < HOLD_TARGET_ANGLE - 10) {
        feedback.push("Raise your arm higher");
      } else if (activeAngle > HOLD_TARGET_ANGLE + 20) {
        feedback.push("Lower your arm slightly");
      }
    }
    if (lean > TORSO_LEAN_LIMIT) {
      feedback.push("Keep your torso straight");
    }
    if (this.state === "Holding") {
      if (this.holdDuration < HOLD_MIN_SECONDS) {
        feedback.push("Hold position");
      } else {
        feedback.push("Good hold — keep it steady");
      }
    }
    if (this.state === "Ready" && now - this.lastCompletedAt < 1.5) {
      feedback.push("Good repetition");
    }
    if (symmetry < 70) {
      feedback.push("Move both arms evenly");
    }
    if (feedback.length === 0) {
      feedback.push("Stand tall and begin");
    }

    const movementScore = this.computeLiveScore(activeAngle, lean, symmetry);

    return {
      detected: true,
      state: this.state,
      abduction_angle: activeAngle,
      torso_lean: lean,
      symmetry,
      rep_count: this.repCount,
      feedback,
      movement_score: movementScore,
      left_angle: leftAngle,
      right_angle: rightAngle,
    };
  }

  private computeScore(): number {
    let score = 100;
    if (this.maxAngle < HOLD_TARGET_ANGLE - 15) score -= 20;
    if (this.holdDuration < HOLD_MIN_SECONDS) score -= 15;
    if (this.repQuality.includes("lean")) score -= 10;
    return Math.max(0, Math.round(score));
  }

  private computeLiveScore(
    angle: number,
    lean: number,
    symmetry: number
  ): number {
    let score = 100;
    const angleScore = Math.max(0, 100 - Math.abs(angle - HOLD_TARGET_ANGLE) * 1.2);
    const leanScore = Math.max(0, 100 - lean * 4);
    score = angleScore * 0.5 + leanScore * 0.3 + symmetry * 0.2;
    return Math.round(Math.max(0, Math.min(100, score)));
  }
}

// ---------------------------------------------------------------------------
// MediaPipe Pose Landmarker wrapper
// ---------------------------------------------------------------------------

let poseLandmarker: PoseLandmarker | null = null;
let loadingPromise: Promise<PoseLandmarker> | null = null;

export async function loadPoseLandmarker(): Promise<PoseLandmarker> {
  if (poseLandmarker) return poseLandmarker;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    const fileset = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
    );
    poseLandmarker = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: {
        // Load the model from MediaPipe's stable public CDN (avoids bundling
        // the 5.7MB binary in the repo).
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task",
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    return poseLandmarker;
  })();

  return loadingPromise;
}

export function detectPose(
  landmarker: PoseLandmarker,
  video: HTMLVideoElement,
  timestamp: number
): Landmark[] | null {
  const result = landmarker.detectForVideo(video, timestamp);
  if (!result.landmarks || result.landmarks.length === 0) return null;
  return result.landmarks[0] as unknown as Landmark[];
}

export function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  landmarks: Landmark[],
  width: number,
  height: number
) {
  const connections: [number, number][] = [
    [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
    [11, 23], [12, 24], [23, 24], [23, 25], [24, 26],
    [25, 27], [26, 28],
  ];
  const toPx = (lm: Landmark) => ({
    x: lm.x * width,
    y: lm.y * height,
  });

  ctx.lineWidth = 4;
  ctx.strokeStyle = "#4f8cff";
  ctx.lineCap = "round";
  for (const [a, b] of connections) {
    const pa = toPx(landmarks[a]);
    const pb = toPx(landmarks[b]);
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }

  ctx.fillStyle = "#7c5cff";
  for (const lm of landmarks) {
    const p = toPx(lm);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

export const EXERCISE_STATES = [
  "Ready",
  "Raising",
  "Holding",
  "Lowering",
  "Completed",
];