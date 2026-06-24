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

async function startBuffer({ mode, sourceId, deviceId, seconds }) {
  if (running) return;
  const isWebcam = mode === 'webcam';
  if (!isWebcam && !sourceId) { console.error('[buffer] no source id'); return; }
  keepSegs = Math.ceil((seconds || 30) / (SEG_MS / 1000)) + 1;
  try {
    stream = await navigator.mediaDevices.getUserMedia(
      isWebcam
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
          }
    );
  } catch (e) {
    console.error('[buffer] getUserMedia failed:', e.message);
    try { window.gifApp.replayError(e.message || (isWebcam ? 'webcam capture failed' : 'screen capture failed')); } catch { /* ignore */ }
    return;
  }
  running = true;
  cycle();
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
