export interface FrameAnalysis {
  detected: boolean;
  state: string;
  abduction_angle: number;
  torso_lean: number;
  symmetry: number;
  rep_count: number;
  feedback: string[];
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
  video_url: string;
}

export interface ExerciseStateInfo {
  states: string[];
  thresholds: Record<string, number>;
}

const API_BASE = ""; // proxied by Vite to the FastAPI backend

// Set to true when the live FastAPI backend is unreachable and demo data is used.
let demoActive = false;
export function isDemoActive(): boolean {
  return demoActive;
}

// ---------------------------------------------------------------------------
// Demo-mode fallback
// ---------------------------------------------------------------------------
// The static (GitHub Pages) deployment cannot run the Python/FastAPI backend.
// When the backend is unreachable, the UI falls back to realistic demo data so
// the site still renders and demonstrates the full experience end-to-end.
// If a live backend is ever deployed, set VITE_API_BASE to its URL and the
// real analysis pipeline will be used instead.
// ---------------------------------------------------------------------------

const DEMO_STATES = ["Ready", "Raising", "Holding", "Lowering", "Completed Rep"];

const DEMO_FEEDBACK_POOL: string[][] = [
  ["Raise your arm higher", "Keep your torso straight"],
  ["Hold position", "Good repetition"],
  ["Keep your torso straight", "Good repetition"],
  ["Raise your arm higher", "Hold position"],
  ["Good repetition", "Excellent control"],
];

const DEMO_QUALITY_POOL: string[][] = [
  ["Good range", "Stable torso"],
  ["Good range", "Slight lean"],
  ["Excellent control", "Good symmetry"],
  ["Good range", "Good symmetry"],
  ["Excellent control", "Stable torso"],
];

function demoFrame(): FrameAnalysis {
  const idx = Math.floor(Math.random() * DEMO_FEEDBACK_POOL.length);
  return {
    detected: true,
    state: DEMO_STATES[Math.floor(Math.random() * DEMO_STATES.length)],
    abduction_angle: 60 + Math.round(Math.random() * 100),
    torso_lean: Math.round(Math.random() * 8 * 10) / 10,
    symmetry: 82 + Math.round(Math.random() * 16),
    rep_count: Math.floor(Math.random() * 6),
    feedback: DEMO_FEEDBACK_POOL[idx],
  };
}

function demoVideo(): VideoAnalysisResult {
  const repCount = 3 + Math.floor(Math.random() * 3);
  const reps: RepSummary[] = [];
  for (let i = 1; i <= repCount; i++) {
    reps.push({
      rep_number: i,
      max_angle: 90 + Math.round(Math.random() * 30),
      hold_seconds: Math.round((1 + Math.random() * 2) * 10) / 10,
      avg_torso_lean: Math.round(Math.random() * 6 * 10) / 10,
      symmetry: 84 + Math.round(Math.random() * 14),
      score: 78 + Math.round(Math.random() * 20),
      quality: DEMO_QUALITY_POOL[Math.floor(Math.random() * DEMO_QUALITY_POOL.length)],
    });
  }
  return {
    rep_count: repCount,
    average_score: Math.round(reps.reduce((s, r) => s + r.score, 0) / repCount),
    reps,
    video_url: "",
  };
}

const DEMO_STATE_INFO: ExerciseStateInfo = {
  states: ["Ready", "Raising", "Holding", "Lowering", "Completed Rep"],
  thresholds: {
    raise_angle: 15,
    hold_angle: 80,
    lower_angle: 20,
    hold_seconds: 1.0,
    max_lean: 10,
  },
};

async function isBackendReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/api/health`, { method: "GET" });
    demoActive = !res.ok;
    return res.ok;
  } catch {
    demoActive = true;
    return false;
  }
}

export async function analyzeFrame(file: File): Promise<FrameAnalysis> {
  if (!(await isBackendReachable())) return demoFrame();
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${API_BASE}/api/analyze-frame`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error("Frame analysis failed");
  return res.json();
}

export async function analyzeVideo(file: File): Promise<VideoAnalysisResult> {
  if (!(await isBackendReachable())) return demoVideo();
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${API_BASE}/api/analyze-video`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error("Video analysis failed");
  return res.json();
}

export async function getExerciseState(): Promise<ExerciseStateInfo> {
  if (!(await isBackendReachable())) return DEMO_STATE_INFO;
  const res = await fetch(`${API_BASE}/api/exercise/state`);
  if (!res.ok) throw new Error("Failed to load exercise state");
  return res.json();
}

export async function resetSession(): Promise<void> {
  if (!(await isBackendReachable())) return;
  await fetch(`${API_BASE}/api/reset`, { method: "POST" });
}