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

// Live FastAPI backend URL (deployed via Cloudflare quick tunnel).
const API_BASE = "https://episode-employers-last-resulting.trycloudflare.com";

// The live backend is always used — no demo-mode fallback.
export async function analyzeFrame(file: File): Promise<FrameAnalysis> {
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
  const res = await fetch(`${API_BASE}/api/exercise/state`);
  if (!res.ok) throw new Error("Failed to load exercise state");
  return res.json();
}

export async function resetSession(): Promise<void> {
  await fetch(`${API_BASE}/api/reset`, { method: "POST" });
}