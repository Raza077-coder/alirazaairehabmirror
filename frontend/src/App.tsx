import { useCallback, useEffect, useRef, useState } from "react";
import {
  analyzeFrame,
  analyzeVideo,
  getExerciseState,
  resetSession,
  type ExerciseStateInfo,
  type FrameAnalysis,
  type VideoAnalysisResult,
} from "./api";

const EMPTY_FRAME: FrameAnalysis = {
  detected: false,
  state: "Ready",
  abduction_angle: 0,
  torso_lean: 0,
  symmetry: 100,
  rep_count: 0,
  feedback: [],
};

export default function App() {
  const [frame, setFrame] = useState<FrameAnalysis>(EMPTY_FRAME);
  const [videoResult, setVideoResult] = useState<VideoAnalysisResult | null>(null);
  const [stateInfo, setStateInfo] = useState<ExerciseStateInfo | null>(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveMode, setLiveMode] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const captureTimer = useRef<number | null>(null);

  useEffect(() => {
    getExerciseState()
      .then((s) => {
        setStateInfo(s);
      })
      .catch(() => {});
    return () => stopLive();
  }, []);

  const stopLive = useCallback(() => {
    if (captureTimer.current) {
      window.clearInterval(captureTimer.current);
      captureTimer.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setLiveMode(false);
  }, []);

  const startLive = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setLiveMode(true);
      captureTimer.current = window.setInterval(async () => {
        const video = videoRef.current;
        if (!video || video.videoWidth === 0) return;
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(video, 0, 0);
        canvas.toBlob(async (blob) => {
          if (!blob) return;
          const file = new File([blob], "frame.jpg", { type: "image/jpeg" });
          try {
            const result = await analyzeFrame(file);
            setFrame(result);
          } catch {
            /* transient */
          }
        }, "image/jpeg", 0.8);
      }, 200);
    } catch (e) {
      setError("Camera access denied. Use image/video upload instead.");
    }
  }, []);

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setProcessing(true);
    setError(null);
    try {
      const result = await analyzeFrame(file);
      setFrame(result);
    } catch {
      setError("Frame analysis failed. Is the backend running?");
    } finally {
      setProcessing(false);
    }
  };

  const handleVideoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setProcessing(true);
    setError(null);
    try {
      const result = await analyzeVideo(file);
      setVideoResult(result);
    } catch {
      setError("Video analysis failed. Is the backend running?");
    } finally {
      setProcessing(false);
    }
  };

  const handleReset = async () => {
    await resetSession();
    setFrame(EMPTY_FRAME);
    setVideoResult(null);
  };

  return (
    <div className="app">
      <header className="header">
        <h1>🪞 AI Rehab Mirror</h1>
        <p className="tagline">
          Building AI systems that don't just see the world, but understand human movement.
        </p>
      </header>

      <section className="controls">
        <button onClick={liveMode ? stopLive : startLive} className="btn primary">
          {liveMode ? "Stop Live Camera" : "Start Live Camera"}
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

      <div className="grid">
        <div className="card">
          <h2>Camera / Input</h2>
          <video ref={videoRef} className="video" muted playsInline />
          {!liveMode && (
            <div className="placeholder">Upload an image or video, or start the camera.</div>
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
            <span>Torso Lean</span>
            <strong>{frame.torso_lean.toFixed(1)}°</strong>
          </div>
          <div className="metric">
            <span>Symmetry</span>
            <strong>{frame.symmetry.toFixed(0)}%</strong>
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
              <strong>{videoResult.average_score.toFixed(1)}/100</strong>
            </div>
          </div>
          <video src={videoResult.video_url} controls className="video" />
          <table>
            <thead>
              <tr>
                <th>Rep</th>
                <th>Max Angle</th>
                <th>Hold (s)</th>
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
                  <td>{r.hold_seconds}</td>
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

      {stateInfo && (
        <section className="card">
          <h2>Exercise State Machine</h2>
          <p className="flow">{stateInfo.states.join(" → ")}</p>
          <div className="thresholds">
            {Object.entries(stateInfo.thresholds).map(([k, v]) => (
              <span key={k} className="chip">
                {k}: {v}
              </span>
            ))}
          </div>
        </section>
      )}

      <footer className="footer">
        <p>
          AI Rehab Mirror — computer vision physiotherapy assistant. MediaPipe Pose · OpenCV ·
          FastAPI · React/TypeScript.
        </p>
      </footer>
    </div>
  );
}