// Instant Replay buffer (Phase 2) — runs in a hidden window.
// Continuously records in short self-contained segments and keeps only the last
// N seconds worth (a ring buffer). On "save", it flushes the current segment and
// hands all kept segments to main to stitch + open.
//
// Sources: 'screen' (a monitor), 'webcam' (the camera), or 'pip' (screen AND
// webcam recorded as TWO SEPARATE tracks). For PiP nothing is composited here —
// both tracks are saved as separate files and the webcam becomes a movable video
// overlay ("video sticker") in the editor, composited at GIF-export time.
//
// Why segments: a WebM stream isn't trimmable from the front (only the first
// chunk has the header), so we record discrete clips and keep the recent ones.

const SEG_MS = 3000; // length of each rolling segment
let tracks = [];     // [{ name, stream, recorder, segments, _flush }]
let keepSegs = 11;   // ~seconds/SEG + 1
let running = false;
let saving = false;

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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function screenConstraints(sourceId) {
  return {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxWidth: 1280, maxHeight: 720, maxFrameRate: 30, // lighter than capture
      },
    },
  };
}
function webcamConstraints(deviceId) {
  return {
    audio: false,
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 },
    },
  };
}

// Grab the webcam with a clean open → close → reopen cycle: it resets a stuck
// pipeline (left by a crash or another app grabbing it) so the camera delivers
// real frames instead of black. If it's genuinely busy, the first open throws.
async function grabWebcamFresh(deviceId) {
  const probe = await navigator.mediaDevices.getUserMedia(webcamConstraints(deviceId));
  probe.getTracks().forEach((t) => t.stop());
  await wait(350); // let the device fully release
  return navigator.mediaDevices.getUserMedia(webcamConstraints(deviceId));
}

function addTrack(name, stream) {
  tracks.push({ name, stream, recorder: null, segments: [], _flush: null });
}

async function startBuffer({ mode, sourceId, deviceId, seconds }) {
  if (running) return;
  keepSegs = Math.ceil((seconds || 30) / (SEG_MS / 1000)) + 1;
  tracks = [];
  try {
    if (mode === 'pip') {
      // Screen is required; the webcam is best-effort. If the camera is busy
      // (Discord on Windows), record screen-only and tell the user, rather than
      // failing the whole replay.
      if (!sourceId) throw new Error('no screen source');
      addTrack('screen', await navigator.mediaDevices.getUserMedia(screenConstraints(sourceId)));
      try {
        addTrack('webcam', await grabWebcamFresh(deviceId));
      } catch (e) {
        console.error('[buffer] pip webcam failed:', e.name, e.message);
        try { window.gifApp.replayNotice('Your webcam is in use — recording screen only for this replay.'); } catch { /* ignore */ }
      }
    } else if (mode === 'webcam') {
      addTrack('webcam', await grabWebcamFresh(deviceId));
    } else {
      if (!sourceId) { console.error('[buffer] no source id'); try { window.gifApp.replayArmed(false); } catch { /* ignore */ } return; }
      addTrack('screen', await navigator.mediaDevices.getUserMedia(screenConstraints(sourceId)));
    }
  } catch (e) {
    console.error('[buffer] start failed:', e.name, e.message);
    try { window.gifApp.replayError(camGumMessage(e, mode !== 'screen')); } catch { /* ignore */ }
    try { window.gifApp.replayArmed(false); } catch { /* ignore */ }
    cleanup();
    return;
  }
  running = true;
  tracks.forEach((t) => cycleTrack(t));
  // Tell main the buffer is genuinely recording (so Save Replay knows it can
  // actually flush a clip, vs. a buffer that exists but never grabbed a source).
  try { window.gifApp.replayArmed(true); } catch { /* ignore */ }
  console.log('[buffer] armed;', mode, 'tracks:', tracks.map((t) => t.name).join('+'), 'keeping', keepSegs, 'segments');
}

// One rolling recorder per track; self-restarts every SEG_MS to keep discrete,
// front-trimmable segments.
function cycleTrack(t) {
  if (!running || !t.stream) return;
  const chunks = [];
  const mime = pickMime();
  t.recorder = new MediaRecorder(t.stream, mime ? { mimeType: mime } : undefined);
  t.recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  t.recorder.onstop = () => {
    if (chunks.length) {
      t.segments.push(new Blob(chunks, { type: 'video/webm' }));
      while (t.segments.length > keepSegs) t.segments.shift();
    }
    if (t._flush) { const done = t._flush; t._flush = null; done(t.segments.slice()); }
    if (running) cycleTrack(t);
  };
  t.recorder.start();
  setTimeout(() => { if (t.recorder && t.recorder.state !== 'inactive') t.recorder.stop(); }, SEG_MS);
}

// Flush a track's in-progress segment so the saved clip includes up to "now",
// resolving with the segment list once the recorder finalises.
function flushTrack(t) {
  return new Promise((res) => {
    if (t.recorder && t.recorder.state !== 'inactive') { t._flush = res; t.recorder.stop(); }
    else res(t.segments.slice());
  });
}

function cleanup() {
  tracks.forEach((t) => { try { if (t.stream) t.stream.getTracks().forEach((x) => x.stop()); } catch { /* ignore */ } });
  tracks = [];
}

function stopBuffer() {
  running = false;
  saving = false;
  tracks.forEach((t) => { try { if (t.recorder && t.recorder.state !== 'inactive') t.recorder.stop(); } catch { /* ignore */ } });
  cleanup();
}

// Flush every track and hand main a { trackName: [ArrayBuffer, …] } payload
// (one entry per track — 'screen', 'webcam', or both for PiP).
async function saveBuffer() {
  if (!running || saving) return;
  saving = true;
  try {
    const payload = {};
    await Promise.all(tracks.map(async (t) => {
      const segs = await flushTrack(t);
      payload[t.name] = await Promise.all(segs.map((b) => b.arrayBuffer()));
    }));
    await window.gifApp.replaySubmit(payload);
  } catch (e) { console.error('[buffer] submit failed:', e.message); }
  saving = false;
}

window.gifApp.onReplayStart(startBuffer);
window.gifApp.onReplayStop(stopBuffer);
window.gifApp.onReplaySave(saveBuffer);
