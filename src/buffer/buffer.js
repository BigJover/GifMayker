// Instant Replay buffer (Phase 2) — runs in a hidden window.
// Continuously records the screen in short self-contained segments and keeps
// only the last N seconds worth (a ring buffer). On "save", it flushes the
// current segment and hands all kept segments to main to stitch + open.
//
// Why segments: a WebM stream isn't trimmable from the front (only the first
// chunk has the header), so we record discrete clips and keep the recent ones.

const SEG_MS = 3000; // length of each rolling segment
let stream = null;
let recorder = null;
let segments = [];   // array of complete webm Blobs
let keepSegs = 11;   // ~seconds/SEG + 1
let running = false;
let saveRequested = false;

function pickMime() {
  for (const m of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

// Same camera-contention story as the capture window: on Windows the webcam is
// single-owner, so an open fails if another app (or our own webcam capture)
// holds it. Give main a message the user can act on.
function camGumMessage(e, isWebcam) {
  const name = e && e.name;
  if (isWebcam && (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError')) {
    return 'your camera is in use by another app (Discord, Zoom, or a webcam capture). Close it there, then turn Instant Replay off and on.';
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') return isWebcam ? 'camera access was blocked.' : 'screen recording access was blocked.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return isWebcam ? 'the selected camera wasn’t found.' : 'the selected screen wasn’t found.';
  return (e && e.message) || name || 'unknown error';
}

async function startBuffer({ mode, sourceId, deviceId, seconds }) {
  if (running) return;
  const isWebcam = mode === 'webcam';
  if (!isWebcam && !sourceId) { console.error('[buffer] no source id'); return; }
  keepSegs = Math.ceil((seconds || 30) / (SEG_MS / 1000)) + 1;
  const constraints = isWebcam
    ? {
        audio: false,
        video: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 },
        },
      }
    : {
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId,
            maxWidth: 1280, maxHeight: 720, maxFrameRate: 30, // lighter than capture
          },
        },
      };
  try {
    if (isWebcam) {
      // Restart the camera before recording: a clean open → close → reopen
      // cycle resets a stuck pipeline (left by a crash or another app grabbing
      // it) so it delivers real frames instead of black. If the camera is
      // genuinely busy/unavailable, this first open throws → handled below.
      const probe = await navigator.mediaDevices.getUserMedia(constraints);
      probe.getTracks().forEach((t) => t.stop());
      await new Promise((r) => setTimeout(r, 350)); // let the device fully release
    }
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    console.error('[buffer] getUserMedia failed:', e.name, e.message);
    try { window.gifApp.replayError(camGumMessage(e, isWebcam)); } catch { /* ignore */ }
    try { window.gifApp.replayArmed(false); } catch { /* ignore */ }
    return;
  }
  running = true;
  cycle();
  // Tell main the buffer is genuinely recording (so Save Replay knows it can
  // actually flush a clip, vs. a buffer that exists but never grabbed a source).
  try { window.gifApp.replayArmed(true); } catch { /* ignore */ }
  console.log('[buffer] armed;', isWebcam ? 'webcam' : 'screen', 'keeping', keepSegs, 'segments');
}

function cycle() {
  if (!running || !stream) return;
  const chunks = [];
  const mime = pickMime();
  recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onstop = async () => {
    if (chunks.length) {
      segments.push(new Blob(chunks, { type: 'video/webm' }));
      while (segments.length > keepSegs) segments.shift();
    }
    if (saveRequested) {
      saveRequested = false;
      try {
        const bufs = await Promise.all(segments.map((b) => b.arrayBuffer()));
        await window.gifApp.replaySubmit(bufs);
      } catch (e) { console.error('[buffer] submit failed:', e.message); }
    }
    if (running) cycle();
  };
  recorder.start();
  setTimeout(() => { if (recorder && recorder.state !== 'inactive') recorder.stop(); }, SEG_MS);
}

function stopBuffer() {
  running = false;
  saveRequested = false;
  try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch { /* ignore */ }
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  segments = [];
}

// Flush the in-progress segment so the saved clip includes up to "now".
function saveBuffer() {
  if (!running) return;
  saveRequested = true;
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}

window.gifApp.onReplayStart(startBuffer);
window.gifApp.onReplayStop(stopBuffer);
window.gifApp.onReplaySave(saveBuffer);
