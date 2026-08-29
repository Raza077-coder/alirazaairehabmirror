import { useCallback, useEffect, useRef, useState } from "react";
import {
  loadPoseLandmarker,
  detectPose,
  drawSkeleton,
  ShoulderAbductionMachine,
  EXERCISE_STATES,
  type FrameAnalysis,
  type VideoAnalysisResult,
} from "./poseAnalysis";

const EMPTY_FRAME: FrameAnalysis = {
  detected: false,
  state: "Ready",
  abduction_angle: 0,
  torso_lean: 0,
  symmetry: 100,
  rep_count: 0,
  feedback: [],
  movement_score: 0,
  left_angle: 0,
  right_angle: 0,
};

export default function App() {
  const [frame, setFrame] = useState<FrameAnalysis>(EMPTY_FRAME);
  const [videoResult, setVideoResult] = useState<VideoAnalysisResult | null>(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveMode, setLiveMode] = useState(false);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelReady, setModelReady] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const machineRef = useRef<ShoulderAbductionMachine>(
    new ShoulderAbductionMachine()
  );
  const lastVideoTimeRef = useRef(-1);

  // Load the MediaPipe pose model once on mount.
  useEffect(() => {
    let cancelled = false;
    setModelLoading(true);
    loadPoseLandmarker()
      .then(() => {
        if (!cancelled) {
          setModelReady(true);
          setModelLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setModelLoading(false);
          setError("Failed to load the pose model. Check your connection.");
        }
      });
    return () => {
      cancelled = true;
      stopLive();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopLive = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    lastVideoTimeRef.current = -1;
    setLiveMode(false);
  }, []);

  const analyzeLoop = useCallback(async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const landmarker = await loadPoseLandmarker();
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const tick = () => {
      if (!liveModeRef.current) return;
      if (video.readyState >= 2 && video.currentTime !== lastVideoTimeRef.current) {
        lastVideoTimeRef.current = video.currentTime;
        const landmarks = detectPose(
          landmarker,
          video,
          performance.now()
        );
        if (landmarks) {
          const result = machineRef.current.process(landmarks);
          setFrame(result);
          // Draw skeleton overlay
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          drawSkeleton(ctx, landmarks, canvas.width, canvas.height);
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const liveModeRef = useRef(false);
  useEffect(() => {
    liveModeRef.current = liveMode;
  }, [liveMode]);

  const startLive = useCallback(async () => {
    setError(null);
    if (!modelReady) {
      setError("Pose model is still loading. Please wait a moment.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 } },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setLiveMode(true);
      machineRef.current.reset();
      analyzeLoop();
    } catch (e) {
      setError("Camera access denied. Allow camera permission and try again.");
    }
  }, [modelReady, analyzeLoop]);

  const handleImageUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setProcessing(true);
      setError(null);
      try {
        const landmarker = await loadPoseLandmarker();
        const bitmap = await createImageBitmap(file);
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(bitmap, 0, 0);
        const result = landmarker.detect(canvas);
        if (result.landmarks && result.landmarks.length > 0) {
          const lm = result.landmarks[0] as unknown as {
            x: number;
            y: number;
            z: number;
          }[];
          const analysis = machineRef.current.process(lm);
          setFrame(analysis);
          // Draw skeleton on the preview canvas
          const preview = canvasRef.current;
          if (preview) {
            preview.width = bitmap.width;
            preview.height = bitmap.height;
            const pctx = preview.getContext("2d");
            if (pctx) {
              pctx.drawImage(bitmap, 0, 0);
              drawSkeleton(pctx, lm, preview.width, preview.height);
            }
          }
        } else {
          setError("No pose detected in the image. Try a full-body photo.");
        }
      } catch {
        setError("Image analysis failed. Try another image.");
      } finally {
        setProcessing(false);
      }
    },
    []
  );

  const handleVideoUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setProcessing(true);
      setError(null);
      try {
        const landmarker = await loadPoseLandmarker();
        const url = URL.createObjectURL(file);
        const video = document.createElement("video");
        video.src = url;
        video.muted = true;
        await new Promise<void>((resolve) => {
          video.onloadeddata = () => resolve();
          video.onerror = () => resolve();
        });
        await video.play();

        const machine = new ShoulderAbductionMachine();
        const reps: VideoAnalysisResult["reps"] = [];
        let lastTime = -1;

        const stepFrames = () => {
          if (video.readyState >= 2 && video.currentTime !== lastTime) {
            lastTime = video.currentTime;
            const lm = detectPose(landmarker, video, performance.now());
            if (lm) {
              const res = machine.process(lm);
              if (res.rep_count > reps.length) {
                reps.push({
                  rep_number: reps.length + 1,
                  max_angle: Math.round(res.abduction_angle),
                  hold_seconds: 1,
                  avg_torso_lean: Math.round(res.torso_lean),
                  symmetry: Math.round(res.symmetry),
                  score: res.movement_score,
                  quality: res.feedback,
                });
              }
            }
          }
          if (video.currentTime < video.duration - 0.05) {
            requestAnimationFrame(stepFrames);
          } else {
            const avg =
              reps.length > 0
                ? reps.reduce((s, r) => s + r.score, 0) / reps.length
                : 0;
            setVideoResult({
              rep_count: reps.length,
              average_score: Math.round(avg),
              reps,
            });
            setProcessing(false);
            URL.revokeObjectURL(url);
          }
        };
        stepFrames();
      } catch {
        setError("Video analysis failed. Try another video.");
        setProcessing(false);
      }
    },
    []
  );

  const handleReset = useCallback(() => {
    machineRef.current.reset();
    setFrame(EMPTY_FRAME);
    setVideoResult(null);
  }, []);

  return (
    <div className="app">
      <header className="header">
        <h1>🩺 AI Rehab Mirror</h1>
        <p className="tagline">
          Building AI systems that don't just see the world, but understand
          human movement.
        </p>
      </header>

      <section className="controls">
        <button
          onClick={liveMode ? stopLive : startLive}
          className="btn primary"
          disabled={!modelReady}
        >
          {modelLoading
            ? "Loading pose model…"
            : liveMode
            ? "Stop Live Camera"
            : "Start Live Camera"}
        </button>
        <label className="btn">
          Analyze Image
          <input type="file" accept="image/*" hidden onChange={handleImageUpload} />
        </label>
        <label className="btn">
          Analyze Video
          <input type="file" accept="video/*" hidden onChange={handleVideoUpload} />
        </label>
        <button onClick={handleReset} className="btn ghost">
          Reset Session
        </button>
      </section>

      {error && <div className="error">{error}</div>}
      {processing && <div className="processing">Processing…</div>}
      {!modelReady && !error && (
        <div className="processing">Loading MediaPipe pose model (WASM)…</div>
      )}

      <div className="grid">
        <div className="card">
          <h2>Camera / Input</h2>
          <div className="video-wrap">
            <video ref={videoRef} className="video" muted playsInline />
            <canvas ref={canvasRef} className="overlay" />
          </div>
          {!liveMode && (
            <div className="placeholder">
              Start the camera, or upload an image/video. Pose analysis runs
              entirely in your browser (MediaPipe WASM) — no server needed.
            </div>
          )}
        </div>

        <div className="card">
          <h2>Live Metrics</h2>
          <div className="metric">
            <span>State</span>
            <strong className="state">{frame.state}</strong>
          </div>
          <div className="metric">
            <span>Abduction Angle</span>
            <strong>{frame.abduction_angle.toFixed(1)}°</strong>
          </div>
          <div className="metric">
            <span>Left / Right</span>
            <strong>
              {frame.left_angle.toFixed(0)}° / {frame.right_angle.toFixed(0)}°
            </strong>
          </div>
          <div className="metric">
            <span>Torso Lean</span>
            <strong>{frame.torso_lean.toFixed(1)}°</strong>
          </div>
          <div className="metric">
            <span>Symmetry</span>
            <strong>{frame.symmetry.toFixed(0)}%</strong>
          </div>
          <div className="metric">
            <span>Movement Score</span>
            <strong>{frame.movement_score}/100</strong>
          </div>
          <div className="metric">
            <span>Reps Completed</span>
            <strong>{frame.rep_count}</strong>
          </div>
          <div className="feedback">
            <h3>Feedback</h3>
            {frame.feedback.length === 0 ? (
              <p className="muted">No feedback yet</p>
            ) : (
              <ul>
                {frame.feedback.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      {videoResult && (
        <section className="card result">
          <h2>Video Analysis Report</h2>
          <div className="summary">
            <div className="metric">
              <span>Reps</span>
              <strong>{videoResult.rep_count}</strong>
            </div>
            <div className="metric">
              <span>Average Score</span>
              <strong>{videoResult.average_score}/100</strong>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Rep</th>
                <th>Max Angle</th>
                <th>Lean</th>
                <th>Symmetry</th>
                <th>Score</th>
                <th>Quality</th>
              </tr>
            </thead>
            <tbody>
              {videoResult.reps.map((r) => (
                <tr key={r.rep_number}>
                  <td>{r.rep_number}</td>
                  <td>{r.max_angle}°</td>
                  <td>{r.avg_torso_lean}°</td>
                  <td>{r.symmetry}%</td>
                  <td>{r.score}</td>
                  <td>{r.quality.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="card">
        <h2>Exercise State Machine</h2>
        <p className="flow">{EXERCISE_STATES.join(" → ")}</p>
        <div className="thresholds">
          <span className="chip">Raise: &gt;20°</span>
          <span className="chip">Hold: ≥60°</span>
          <span className="chip">Target: 90°</span>
          <span className="chip">Hold ≥1s</span>
          <span className="chip">Lean limit: 10°</span>
        </div>
      </section>

      <footer className="footer">
        <p>
          AI Rehab Mirror — computer vision physiotherapy assistant. MediaPipe
          Pose (in-browser WASM) · React/TypeScript · Vite.
        </p>
      </footer>
    </div>
  );
}