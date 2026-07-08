// Capture window: pick a source → record it (60s cap) → save raw WebM.
// Uses Electron's desktopCapturer (sources come from main via IPC) and the
// chromeMediaSource constraint to feed getUserMedia, then MediaRecorder.

const $ = (id) => document.getElementById(id);
const MAX_MS = 60_000; // 1-minute cap (raise later once the encoder is proven)

// Turn a getUserMedia DOMException into a message a human can act on. The big
// one on Windows: a webcam can only be opened by ONE app at a time, so if
// Discord/Zoom — or GifMayker's own Instant Replay — already holds it, the
// open fails with NotReadableError/TrackStartError ("Could not start video
// source"). macOS shares the camera, so this only bites on Windows.
function camGumMessage(e, isWebcam) {
  const name = e && e.name;
  if (isWebcam && (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError')) {
    return 'Your camera is in use by another app (Discord, Zoom, or GifMayker’s own Instant Replay). Close it there — or turn off Instant Replay — then try again.';
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return isWebcam ? 'Camera access was blocked — grant Camera permission and try again.' : 'Screen Recording access was blocked.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return isWebcam ? 'That camera wasn’t found — pick a different camera.' : 'That screen or window wasn’t found.';
  }
  return (isWebcam ? 'Couldn’t start the camera: ' : 'Couldn’t start capture: ') + ((e && e.message) || name || 'unknown error');
}

let selected = null;     // { id, name }
let stream = null;
let recorder = null;
let chunks = [];
let ticker = null;
let startTs = 0;
let lastSavedBlob = null;
let lastSavedPath = null;
let lastGifPath = null;  // most recent generated GIF (for the footer copy button)

// editor state (set after a capture finishes)
let clipDuration = 0;        // seconds
let videoW = 0, videoH = 0;  // source pixels
let cropOn = false;
let cropRatio = null;  // null = free form; otherwise width/height
let drag = null;
let loopTimer = null;  // drives the trimmed-region preview loop

// text-caption state: each = {id, text, fx, fy, sizeFrac, color, el}
// fx/fy = CENTER position as a fraction (0..1) of the OUTPUT region (the crop
// region when cropping, else the full frame); sizeFrac = font size as a fraction
// of that region's height. Stored as fractions so they map cleanly to output px.
let captions = [];
let selCap = null;
let capDrag = null;
let capSeq = 0;

// sticker (image overlay) state: each = {id, src, fx, fy, wFrac, hFrac, natW, natH, el, img}
// fx/fy = CENTER as a fraction of the OUTPUT region (same model as captions);
// wFrac/hFrac = width/height as fractions of the region's width/height (independent
// so stickers can be stretched, not just uniformly scaled).
let stickers = [];
let selSticker = null;
let skDrag = null;     // {s, r} while dragging
let skResize = null;   // {s, r, dir, box, aspect} while resizing
let skSeq = 0;
const SK_GRIPS = ['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w'];
// PiP replay: the webcam file that backs the webcam video-sticker (null otherwise).
let pipWebcamPath = null;

// Manual "Screen + Webcam" capture: when the user records a screen with the PiP
// webcam toggle on, we run a SECOND MediaRecorder for the camera in parallel and
// hand both files to the editor's webcam-sticker path (same as an Instant Replay
// PiP, just recorded here instead of the hidden buffer window).
let camStream = null;
let camRecorder = null;
let camChunks = [];
let pipMode = false;        // is THIS recording a screen+webcam capture?
let pipStopWait = 0;        // # of recorders still to fire onstop before we finish

// Unified paint order for ALL overlay items (captions + stickers), bottom→top.
// DOM z-index and the ffmpeg bake order both follow this, so text and images
// layer over each other however the user arranges them.
let zorder = [];

// black letterbox bars; top/bottom = fraction of region height, left/right =
// fraction of region width. 0 = off.
let bars = { top: 0, bottom: 0, left: 0, right: 0 };
let barDrag = null;

// ---- permission + sources ----
async function init() {
  $('permBtn').addEventListener('click', () => window.gifApp.openScreenPrefs());
  $('camPermBtn').addEventListener('click', () => window.gifApp.openCameraPrefs());

  // PiP webcam toggle: reveal the camera picker + refresh the hint.
  $('pipWebcam').addEventListener('change', () => {
    $('pipCam').style.display = $('pipWebcam').checked ? '' : 'none';
    if (selected) selectSource(selected, document.querySelector('.src.selected'));
  });

  const perm = await window.gifApp.capturePermission();
  if (perm === 'denied' || perm === 'restricted') {
    // Screen capture is blocked, but the webcam path may still work — show the
    // banner and load whatever sources we can (cameras) rather than dead-ending.
    $('perm').classList.add('show');
  } else if (perm === 'not-determined') {
    // macOS will prompt the first time we actually capture.
    $('perm').classList.add('show');
  }
  await loadSources();
}

// Webcams the OS knows about. Before camera permission is granted the labels
// (and sometimes deviceIds) come back empty, so we fall back to generic names
// and collapse unidentifiable cams into a single "Webcam" tile.
async function listCameras() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
  let devices = [];
  try { devices = await navigator.mediaDevices.enumerateDevices(); }
  catch { return []; }
  const cams = devices.filter((d) => d.kind === 'videoinput');
  if (!cams.length) return [];
  if (cams.every((d) => !d.deviceId)) {
    return [{ deviceId: '', label: 'Webcam' }];
  }
  return cams.map((d, i) => ({
    deviceId: d.deviceId,
    label: d.label || `Webcam ${i + 1}`,
  }));
}

async function loadSources() {
  let sources = [];
  try {
    sources = await window.gifApp.getSources();
  } catch (e) {
    // Screen permission denied throws here — keep going so cameras still load.
    sources = [];
  }

  const cams = await listCameras();

  if (!sources.length && !cams.length) {
    $('grid').innerHTML = '<div class="muted">No capturable sources found. Grant Screen Recording or Camera permission in System Settings, then reopen this window.</div>';
    $('hint').textContent = 'Waiting on a capture source.';
    return;
  }

  $('grid').innerHTML = '';
  for (const s of sources) {
    const el = document.createElement('div');
    el.className = 'src';
    el.dataset.id = s.id;
    const thumb = s.thumbnail
      ? `<span class="thumb" style="background-image:url('${s.thumbnail}')"></span>`
      : `<span class="thumb"></span>`;
    el.innerHTML = `${thumb}<div class="cap"><span class="tagdot ${s.isScreen ? '' : 'win'}"></span><span title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</span></div>`;
    el.addEventListener('click', () => selectSource({ kind: 'screen', id: s.id, name: s.name }, el));
    $('grid').appendChild(el);
  }

  for (const c of cams) {
    const el = document.createElement('div');
    el.className = 'src';
    el.innerHTML = `<span class="thumb camthumb">◉</span><div class="cap"><span class="tagdot cam"></span><span title="${escapeHtml(c.label)}">${escapeHtml(c.label)}</span></div>`;
    el.addEventListener('click', () => selectSource({ kind: 'webcam', deviceId: c.deviceId, name: c.label }, el));
    $('grid').appendChild(el);
  }

  // PiP toggle only makes sense when there's BOTH a screen/window and a camera.
  const pipBar = $('pipBar');
  if (sources.length && cams.length) {
    const sel = $('pipCam');
    sel.innerHTML = '';
    for (const c of cams) {
      const o = document.createElement('option');
      o.value = c.deviceId; o.textContent = c.label;
      sel.appendChild(o);
    }
    pipBar.classList.remove('hide');
  } else {
    pipBar.classList.add('hide');
    $('pipWebcam').checked = false;
    $('pipCam').style.display = 'none';
  }
}

// Is the current selection a screen+webcam (PiP) capture?
function pipRequested() {
  return !!(selected && selected.kind === 'screen' && $('pipWebcam').checked && !$('pipBar').classList.contains('hide'));
}

function selectSource(s, el) {
  selected = s;
  document.querySelectorAll('.src').forEach((n) => n.classList.remove('selected'));
  if (el) el.classList.add('selected');
  $('recBtn').disabled = false;
  if (pipRequested()) {
    const camName = $('pipCam').selectedOptions[0]?.textContent || 'webcam';
    $('hint').textContent = `Selected: ${s.name} + ${camName} (Picture-in-Picture)`;
  } else {
    $('hint').textContent = `Selected: ${s.name}`;
  }
}

// ---- recording ----
function pickMime() {
  for (const m of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

function screenConstraints(id) {
  return { audio: false, video: { mandatory: {
    chromeMediaSource: 'desktop', chromeMediaSourceId: id,
    maxFrameRate: 30, maxWidth: 1920, maxHeight: 1080,
  } } };
}
function webcamConstraints(deviceId) {
  return { audio: false, video: {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 },
  } };
}

// Open a webcam with the restart cycle (open → close → reopen) that clears a
// stuck pipeline so it delivers real frames instead of black. Throws if the
// camera is genuinely busy/unavailable — caller decides how to react.
async function openCamera(deviceId) {
  const c = webcamConstraints(deviceId);
  const probe = await navigator.mediaDevices.getUserMedia(c);
  probe.getTracks().forEach((t) => t.stop());
  await new Promise((r) => setTimeout(r, 350)); // let the device release
  return navigator.mediaDevices.getUserMedia(c);
}

async function startRecording() {
  if (!selected) return;

  const isWebcam = selected.kind === 'webcam';
  pipMode = pipRequested();          // screen + parallel webcam
  const needCam = isWebcam || pipMode;
  let camNote = '';

  // Camera permission (single-webcam capture OR the PiP secondary camera).
  if (needCam) {
    const granted = await window.gifApp.askCamera();
    if (!granted) {
      if (isWebcam) { // webcam is the only source — can't proceed
        $('camPerm').classList.add('show');
        $('hint').textContent = 'Camera access is needed to record your webcam.';
        return;
      }
      pipMode = false;               // PiP: fall back to screen-only
      camNote = 'Webcam permission denied — recording the screen only.';
    } else {
      $('camPerm').classList.remove('show');
      // On Windows the webcam is single-owner — if our own webcam Instant Replay
      // is holding it in the background, free it first (then wait a beat for the
      // device to actually release before we open it here).
      try {
        const released = await window.gifApp.suspendReplayForCapture();
        if (released) await new Promise((r) => setTimeout(r, 300));
      } catch { /* non-fatal */ }
    }
  }

  // --- acquire the primary stream (webcam capture OR the screen for PiP) ---
  try {
    stream = isWebcam
      ? await openCamera(selected.deviceId)
      : await navigator.mediaDevices.getUserMedia(screenConstraints(selected.id));
  } catch (e) {
    console.error('[capture] getUserMedia failed:', e.name, e.message);
    // Show the technical error name in brackets too — a temporary diagnostic so
    // we can pin down the Windows webcam failure (NotReadable vs Overconstrained
    // vs NotFound each need a different fix).
    $('hint').textContent = `${camGumMessage(e, isWebcam)}  [${e.name}: ${e.message || 'no detail'}]`;
    return;
  }

  // --- PiP: acquire the webcam alongside the screen; drop it gracefully on failure ---
  if (pipMode) {
    try {
      camStream = await openCamera($('pipCam').value);
    } catch (e) {
      console.error('[capture] PiP webcam failed:', e.name, e.message);
      pipMode = false; camStream = null;
      camNote = 'Webcam unavailable (in use by another app?) — recording the screen only.';
    }
  }

  // Mirror the live self-view only when the PREVIEW shows the webcam (i.e. a
  // single-webcam capture). For PiP the preview is the screen, so no mirror.
  $('preview').classList.toggle('mirror', isWebcam);

  // switch UI to recording stage (hide Back so it can't interrupt a recording)
  $('homeBtn').style.display = 'none';
  $('tools').classList.remove('show');
  $('cropbox').classList.remove('show');
  $('copyWrap').classList.remove('show');
  $('copyMenu').classList.remove('show');
  $('grid').style.display = 'none';
  $('pipBar').classList.add('hide');
  $('stage').classList.add('show');
  $('preview').srcObject = stream;
  $('recBtn').style.display = 'none';
  $('stopBtn').style.display = '';
  $('step').textContent = 'Recording…';
  $('hint').textContent = camNote
    ? `${camNote} Auto-stops at 1:00.`
    : (pipMode ? 'Recording screen + webcam — auto-stops at 1:00.' : 'Recording — auto-stops at 1:00.');

  const mimeType = pickMime();
  chunks = [];
  recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

  if (pipMode) {
    // Dual recording: a second recorder for the webcam. Both onstop handlers
    // decrement a shared counter; the last one to fire assembles both files.
    camChunks = [];
    camRecorder = new MediaRecorder(camStream, mimeType ? { mimeType } : undefined);
    camRecorder.ondataavailable = (e) => { if (e.data && e.data.size) camChunks.push(e.data); };
    pipStopWait = 2;
    recorder.onstop = onOneStopped;
    camRecorder.onstop = onOneStopped;
    recorder.start();
    camRecorder.start();
  } else {
    recorder.onstop = onRecorderStop;
    recorder.start();
  }

  startTs = Date.now();
  ticker = setInterval(tick, 100);

  // If the user stops sharing via the OS, end cleanly.
  stream.getVideoTracks()[0].addEventListener('ended', stopRecording);
}

function tick() {
  const el = Date.now() - startTs;
  const pct = Math.min(100, (el / MAX_MS) * 100);
  $('barfill').style.width = pct + '%';
  $('timer').innerHTML = `${fmt(el)} <span class="max">/ 1:00 max</span>`;
  if (el >= MAX_MS) stopRecording();
}

function stopRecording() {
  if (ticker) { clearInterval(ticker); ticker = null; }
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  if (camRecorder && camRecorder.state !== 'inactive') camRecorder.stop();
  if (stream) { stream.getTracks().forEach((t) => t.stop()); }
  if (camStream) { camStream.getTracks().forEach((t) => t.stop()); }
}

// Shared "Captured" stage UI, used by both the single and PiP stop paths.
function showCapturedStage() {
  $('step').textContent = 'Captured';
  $('homeBtn').style.display = '';
  $('stopBtn').style.display = 'none';
  $('backBtn').style.display = '';
  $('gifBtn').style.display = '';
  $('gifBtn').disabled = !lastSavedPath; // need the file on disk to convert
  $('gifopts').classList.add('show');
  $('hint').textContent = `${fmt(Date.now() - startTs)} captured · trim/crop if you like, then make your GIF.`;
  // Intermediate WebM detail is hidden — users only care about the GIF.
  $('saved').style.display = 'none';
}

async function onRecorderStop() {
  const blob = new Blob(chunks, { type: 'video/webm' });
  lastSavedBlob = blob;

  // The recorded clip is un-mirrored — drop the live self-view mirror so the
  // editor preview and crop overlay match the actual GIF frames.
  $('preview').classList.remove('mirror');

  // replay the captured clip
  $('preview').srcObject = null;
  $('preview').src = URL.createObjectURL(blob);
  $('preview').muted = true;
  $('preview').loop = true;
  $('preview').play().catch(() => {});
  $('preview').addEventListener('loadedmetadata', initEditor, { once: true });

  // save to disk via main
  let res = null;
  try {
    res = await window.gifApp.saveCapture(await blob.arrayBuffer());
  } catch (e) {
    $('saved').style.display = 'block';
    $('saved').textContent = `Saved in memory but write failed: ${e.message}`;
  }

  lastSavedPath = res ? res.path : null;
  showCapturedStage();
}

// PiP: both recorders share this handler; the last one to stop assembles both
// files and hands them to the editor's webcam-sticker path.
function onOneStopped() {
  if (--pipStopWait > 0) return;
  onDualStop();
}

async function onDualStop() {
  const screenBlob = new Blob(chunks, { type: 'video/webm' });
  const camBlob = new Blob(camChunks, { type: 'video/webm' });
  lastSavedBlob = screenBlob;

  // Save BOTH files first so pipWebcamPath exists before the editor lays out —
  // addWebcamSticker (run on the screen clip's loadedmetadata) needs the path.
  let sres = null, cres = null;
  try {
    sres = await window.gifApp.saveCapture(await screenBlob.arrayBuffer());
  } catch (e) {
    $('saved').style.display = 'block';
    $('saved').textContent = `Saved in memory but write failed: ${e.message}`;
  }
  try { cres = await window.gifApp.saveCapture(await camBlob.arrayBuffer()); }
  catch (e) { console.error('[capture] webcam save failed:', e.message); }

  lastSavedPath = sres ? sres.path : null;
  pipWebcamPath = cres ? cres.path : null;

  // Show the screen as the base clip; add the webcam as a movable video-sticker
  // once the editor region exists (same as an Instant Replay PiP).
  $('preview').classList.remove('mirror');
  $('preview').srcObject = null;
  $('preview').src = lastSavedPath ? window.gifApp.toFileUrl(lastSavedPath) : URL.createObjectURL(screenBlob);
  $('preview').muted = true;
  $('preview').loop = true;
  $('preview').play().catch(() => {});
  $('preview').addEventListener('loadedmetadata', () => {
    initEditor();
    if (pipWebcamPath) setTimeout(() => addWebcamSticker(pipWebcamPath), 0);
  }, { once: true });

  showCapturedStage();
  if (pipWebcamPath) $('hint').textContent = `${fmt(Date.now() - startTs)} captured · drag/resize your webcam, trim/crop, then make your GIF.`;
}

// ---- GIF conversion (M3) ----
async function makeGif() {
  if (!lastSavedPath) return;
  const width = $('gifSize').value;        // e.g. '480' | '640'
  const fps = Number($('gifFps').value);
  const speed = Number($('gifSpeed').value); // 0.25 .. 5
  const trim = trimRect();                 // null = whole clip
  const crop = cropRect();                 // null = whole frame

  $('gifBtn').disabled = true;
  $('gifBtn').textContent = 'Converting…';
  $('gifopts').classList.add('show');
  $('hint').textContent = 'Encoding GIF — this takes a few seconds for longer clips.';
  $('gifout').style.display = 'none';
  $('gifwrap').classList.remove('show');
  $('copyWrap').classList.remove('show');
  $('copyMenu').classList.remove('show');

  const outSeconds = effectiveDuration() / (speed || 1);
  // Guard the maxed-speed + min-fps edge case that yields <1 frame (ffmpeg errors).
  if (outSeconds * fps < 1) {
    $('gifBtn').disabled = false;
    $('gifBtn').textContent = 'Make GIF';
    $('gifout').style.display = 'block';
    $('gifout').style.color = '#d56a4a';
    $('gifout').textContent = 'Too few frames at this speed × frame-rate — lower the speed or raise the fps.';
    $('hint').textContent = '';
    return;
  }
  $('gifout').style.color = '';
  let res;
  try {
    res = await window.gifApp.toGif({ src: lastSavedPath, fps, width, trim, crop, speed, outSeconds, layers: layerPayload(), bars, webcamSrc: pipWebcamPath });
  } catch (e) {
    res = { ok: false, error: e.message };
  }

  $('gifBtn').textContent = 'Make GIF';
  $('gifBtn').disabled = false;

  if (res && res.ok) {
    // Show the actual generated GIF below the (still-editable) source clip,
    // cache-busted so re-converting with new settings refreshes it.
    $('gifPreview').src = `${window.gifApp.toFileUrl(res.path)}?t=${Date.now()}`;
    $('gifwrap').classList.add('show');
    $('hint').textContent = '';
    // Copy lives in the footer (bottom-left) to keep the preview big. No detail shown.
    lastGifPath = res.path;
    const btn = $('gifCopy');
    btn.textContent = 'GIF ready to copy';
    btn.classList.remove('done');
    $('copyWrap').classList.add('show');
  } else {
    $('gifout').style.display = 'block';
    $('gifout').style.color = '#f87171';
    $('gifout').textContent = `Couldn't make GIF: ${(res && res.error) || 'unknown error'}`;
    $('hint').textContent = 'GIF conversion failed.';
  }
}

function resetToPicker() {
  // Clean up the raw .webm(s) from the previous capture (the GIF is what's kept).
  if (lastSavedPath && /\.webm$/i.test(lastSavedPath)) window.gifApp.deleteSource(lastSavedPath);
  if (pipWebcamPath && /\.webm$/i.test(pipWebcamPath)) window.gifApp.deleteSource(pipWebcamPath);
  camStream = null; camRecorder = null; camChunks = []; pipMode = false;
  selected = null;
  lastSavedBlob = null;
  lastSavedPath = null;
  clearCaptions();
  clearStickers();
  clearBars();
  pipWebcamPath = null; // a plain capture/replay has no webcam overlay
  $('preview').src = '';
  $('preview').srcObject = null;
  $('preview').style.display = '';
  $('preview').classList.remove('mirror');
  $('camPerm').classList.remove('show');
  $('gifPreview').src = '';
  $('gifwrap').classList.remove('show');
  $('copyWrap').classList.remove('show');
  $('copyMenu').classList.remove('show');
  lastGifPath = null;
  $('barfill').style.width = '0%';
  $('stage').classList.remove('show');
  $('grid').style.display = '';
  $('saved').style.display = 'none';
  $('gifout').style.display = 'none';
  $('gifout').style.color = '';
  $('gifopts').classList.remove('show');
  // reset trim + crop editor
  $('tools').classList.remove('show');
  cropOn = false;
  cropRatio = null;
  $('cropbox').classList.remove('show');
  $('cropReset').style.display = 'none';
  $('cropAspect').value = 'free';
  $('cropAspect').disabled = true;
  $('cropToggle').classList.remove('on');
  $('cropToggle').textContent = '▢ Crop: Off';
  if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
  clipDuration = 0; videoW = 0; videoH = 0;
  $('trimStart').value = 0; $('trimEnd').value = 1000;
  $('gifSpeed').value = '1';
  $('estSize').textContent = '';
  $('backBtn').style.display = 'none';
  $('gifBtn').style.display = 'none';
  $('gifBtn').textContent = 'Make GIF';
  $('recBtn').style.display = '';
  $('recBtn').disabled = true;
  $('step').textContent = 'Pick a source';
  $('hint').textContent = 'Choose a screen, window, or webcam to record.';
  document.querySelectorAll('.src').forEach((n) => n.classList.remove('selected'));
  loadSources();
}

// ---- trim + crop editor (M3) ----
function initEditor() {
  const v = $('preview');
  videoW = v.videoWidth; videoH = v.videoHeight;
  clearCaptions();
  clearStickers();
  clearBars();
  // MediaRecorder WebM often reports duration=Infinity until forced to seek.
  resolveDuration(v, (dur) => {
    clipDuration = isFinite(dur) && dur > 0 ? dur : 0;
    $('trimStart').value = 0;
    $('trimEnd').value = 1000;
    updateTrimUI();
    updateEstimate();
    applySpeed(); // reflect current speed on the preview
    // Loop the preview within the trim selection (tight timer for accuracy).
    if (loopTimer) clearInterval(loopTimer);
    loopTimer = setInterval(enforceTrimLoop, 40);
    $('tools').classList.add('show');
  });
}

// Mirror the chosen GIF speed on the source preview so it plays at that rate.
function applySpeed() {
  const speed = Number($('gifSpeed').value) || 1;
  try { $('preview').playbackRate = speed; } catch { /* ignore unsupported rates */ }
}

function resolveDuration(v, cb) {
  if (isFinite(v.duration) && v.duration > 0) { cb(v.duration); return; }
  const onSeek = () => {
    v.removeEventListener('seeked', onSeek);
    const d = v.duration;
    v.currentTime = 0;
    cb(d);
  };
  v.addEventListener('seeked', onSeek);
  v.currentTime = 1e7; // nudges WebM into reporting its real duration
}

function trimValues() {
  let a = Number($('trimStart').value), b = Number($('trimEnd').value);
  if (a > b) { const t = a; a = b; b = t; }
  return { a, b };
}

function updateTrimUI() {
  const { a, b } = trimValues();
  $('trimsel').style.left = (a / 10) + '%';
  $('trimsel').style.width = ((b - a) / 10) + '%';
  const sSec = (a / 1000) * clipDuration, eSec = (b / 1000) * clipDuration;
  $('tStart').textContent = fmtSec(sSec);
  $('tEnd').textContent = fmtSec(eSec);
  $('tDur').textContent = (a <= 0 && b >= 1000) ? 'full clip' : `${fmtSec(eSec - sSec)} selected`;
}

function onTrimInput(which) {
  let a = Number($('trimStart').value), b = Number($('trimEnd').value);
  const MIN = 20; // keep at least ~2% of the clip
  if (b - a < MIN) {
    if (which === 'start') { a = Math.max(0, b - MIN); $('trimStart').value = a; }
    else { b = Math.min(1000, a + MIN); $('trimEnd').value = b; }
  }
  updateTrimUI();
  updateEstimate();
  // Scrub to the handle being dragged so you see that exact frame. For the end
  // handle, sit just before it (the loop would otherwise instantly jump away).
  if (clipDuration) {
    const { start, end } = trimSeconds();
    $('preview').currentTime = which === 'start' ? start : Math.max(start, end - 0.12);
  }
}

// start/end of the trim selection in seconds (always defined once a clip loads)
function trimSeconds() {
  if (!clipDuration) return { start: 0, end: 0 };
  const { a, b } = trimValues();
  return { start: (a / 1000) * clipDuration, end: (b / 1000) * clipDuration };
}

// Loop the PREVIEW within the trimmed range so it plays exactly what the GIF
// will contain (instead of the whole clip).
function enforceTrimLoop() {
  if (!clipDuration) return;
  const v = $('preview');
  const { start, end } = trimSeconds();
  if (v.currentTime >= end - 0.03 || v.currentTime < start - 0.08) {
    v.currentTime = start;
    if (v.paused) v.play().catch(() => {});
  }
}

function trimRect() {
  if (!clipDuration) return null;
  const { a, b } = trimValues();
  if (a <= 0 && b >= 1000) return null; // whole clip
  const start = (a / 1000) * clipDuration;
  const duration = Math.max(0.1, ((b - a) / 1000) * clipDuration);
  return { start, duration };
}

function setCropDefault() {
  const vp = $('viewport');
  const w = vp.clientWidth, h = vp.clientHeight;
  const box = $('cropbox');
  box.style.left = Math.round(w * 0.15) + 'px';
  box.style.top = Math.round(h * 0.15) + 'px';
  box.style.width = Math.round(w * 0.7) + 'px';
  box.style.height = Math.round(h * 0.7) + 'px';
}

function toggleCrop() {
  cropOn = !cropOn;
  $('cropbox').classList.toggle('show', cropOn);
  $('cropReset').style.display = cropOn ? '' : 'none';
  $('cropAspect').disabled = !cropOn;
  $('cropToggle').classList.toggle('on', cropOn);
  $('cropToggle').textContent = cropOn ? '▣ Crop: On' : '▢ Crop: Off';
  if (cropOn) { setCropDefault(); if (cropRatio) fitBoxToAspect(); }
  updateEstimate();
  renderCaptions(); // region switched between full-frame and crop box
  renderStickers();
  renderBars();
}

function ratioVal(s) { const [a, b] = s.split(':').map(Number); return a / b; }

function applyAspect() {
  const v = $('cropAspect').value;
  cropRatio = v === 'free' ? null : ratioVal(v);
  if (cropOn && cropRatio) fitBoxToAspect();
  updateEstimate();
  renderCaptions();
  renderStickers();
  renderBars();
}

// Reshape the current box to the locked ratio, kept centered and inside bounds.
function fitBoxToAspect() {
  const vp = $('viewport');
  const W = vp.clientWidth, H = vp.clientHeight;
  const box = $('cropbox');
  let w = box.offsetWidth, h = w / cropRatio;
  if (h > H) { h = H; w = h * cropRatio; }
  if (w > W) { w = W; h = w / cropRatio; }
  const cx = box.offsetLeft + box.offsetWidth / 2, cy = box.offsetTop + box.offsetHeight / 2;
  box.style.left = Math.min(Math.max(0, cx - w / 2), W - w) + 'px';
  box.style.top = Math.min(Math.max(0, cy - h / 2), H - h) + 'px';
  box.style.width = w + 'px';
  box.style.height = h + 'px';
}

function startDrag(e, mode) {
  e.preventDefault();
  const box = $('cropbox');
  drag = { mode, sx: e.clientX, sy: e.clientY,
    l: box.offsetLeft, t: box.offsetTop, w: box.offsetWidth, h: box.offsetHeight };
  document.addEventListener('mousemove', onDrag);
  document.addEventListener('mouseup', endDrag);
}

function onDrag(e) {
  if (!drag) return;
  const vp = $('viewport');
  const rect = vp.getBoundingClientRect();
  const W = vp.clientWidth, H = vp.clientHeight;
  const box = $('cropbox');

  if (drag.mode === 'move') {
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    box.style.left = Math.min(Math.max(0, drag.l + dx), W - drag.w) + 'px';
    box.style.top = Math.min(Math.max(0, drag.t + dy), H - drag.h) + 'px';
    return;
  }

  const px = Math.min(Math.max(0, e.clientX - rect.left), W);
  const py = Math.min(Math.max(0, e.clientY - rect.top), H);
  const MIN = 20;

  // Edge resize: only the dragged side moves; the opposite side stays anchored.
  if (drag.mode.length === 1) {
    const m = drag.mode;
    let l = drag.l, t = drag.t, r = drag.l + drag.w, b = drag.t + drag.h;
    if (m === 'e') r = Math.max(px, l + MIN);
    if (m === 'w') l = Math.min(px, r - MIN);
    if (m === 's') b = Math.max(py, t + MIN);
    if (m === 'n') t = Math.min(py, b - MIN);
    let w = r - l, h = b - t;

    if (cropRatio) {
      if (m === 'e' || m === 'w') {           // width drives height, keep vertical center
        h = Math.min(w / cropRatio, H);
        w = h * cropRatio;
        if (m === 'e') r = l + w; else l = r - w;
        let t2 = (drag.t + drag.h / 2) - h / 2;
        t = Math.min(Math.max(0, t2), H - h);
      } else {                                 // n/s: height drives width, keep horizontal center
        w = Math.min(h * cropRatio, W);
        h = w / cropRatio;
        if (m === 's') b = t + h; else t = b - h;
        let l2 = (drag.l + drag.w / 2) - w / 2;
        l = Math.min(Math.max(0, l2), W - w);
      }
    }
    box.style.left = l + 'px';
    box.style.top = t + 'px';
    box.style.width = (r - l) + 'px';
    box.style.height = (b - t) + 'px';
    return;
  }

  // Corner resize: the diagonally opposite corner stays anchored.
  const l0 = drag.l, t0 = drag.t, r0 = drag.l + drag.w, b0 = drag.t + drag.h;
  let ax, ay; // anchored (fixed) corner
  if (drag.mode === 'se') { ax = l0; ay = t0; }
  if (drag.mode === 'sw') { ax = r0; ay = t0; }
  if (drag.mode === 'ne') { ax = l0; ay = b0; }
  if (drag.mode === 'nw') { ax = r0; ay = b0; }

  let w = Math.abs(px - ax), h = Math.abs(py - ay);
  const availX = px >= ax ? W - ax : ax;
  const availY = py >= ay ? H - ay : ay;

  if (cropRatio) {
    h = w / cropRatio;                                  // width drives height
    if (h < MIN) { h = MIN; w = h * cropRatio; }
    if (w < MIN) { w = MIN; h = w / cropRatio; }
    if (w > availX) { w = availX; h = w / cropRatio; }  // clamp to space, keep ratio
    if (h > availY) { h = availY; w = h * cropRatio; }
  } else {
    w = Math.min(Math.max(MIN, w), availX);
    h = Math.min(Math.max(MIN, h), availY);
  }

  const left = px >= ax ? ax : ax - w;
  const top = py >= ay ? ay : ay - h;
  box.style.left = left + 'px';
  box.style.top = top + 'px';
  box.style.width = w + 'px';
  box.style.height = h + 'px';
}

function endDrag() {
  drag = null;
  document.removeEventListener('mousemove', onDrag);
  document.removeEventListener('mouseup', endDrag);
  updateEstimate(); // crop region changed → refresh estimate
  renderCaptions(); // keep captions aligned to the new crop region
  renderStickers();
  renderBars();
}

function cropRect() {
  if (!cropOn || !videoW) return null;
  const vb = $('preview').getBoundingClientRect();
  const bb = $('cropbox').getBoundingClientRect();
  if (!vb.width) return null;
  const sx = videoW / vb.width, sy = videoH / vb.height;
  let x = Math.round((bb.left - vb.left) * sx);
  let y = Math.round((bb.top - vb.top) * sy);
  let w = Math.round(bb.width * sx);
  let h = Math.round(bb.height * sy);
  x = Math.max(0, Math.min(x, videoW - 2));
  y = Math.max(0, Math.min(y, videoH - 2));
  w = Math.max(2, Math.min(w, videoW - x));
  h = Math.max(2, Math.min(h, videoH - y));
  if (x === 0 && y === 0 && w >= videoW - 1 && h >= videoH - 1) return null; // ~full frame
  return { x, y, w, h };
}

// ---- size estimate ----
// GIF size is content-dependent (motion = more bytes), so this is a rough
// guide only: output pixels × frames × a typical bytes-per-pixel-frame factor.
const EST_BPP = 0.05;

function effectiveDuration() {
  const t = trimRect();
  return t ? t.duration : clipDuration;
}

function outputDims() {
  let bw = videoW, bh = videoH;       // base = crop region if active, else full frame
  const c = cropRect();
  if (c) { bw = c.w; bh = c.h; }
  const sel = $('gifSize').value;
  if (!bw) return { w: bw, h: bh };
  const w = Number(sel);
  return { w, h: Math.round(w * bh / bw) };
}

// ---- text captions ----
// The output region (in viewport px) that becomes the GIF frame: the crop box
// when cropping, else the whole preview. Captions are placed relative to it.
function outputRegion() {
  const vp = $('viewport');
  if (cropOn) {
    const b = $('cropbox');
    return { L: b.offsetLeft, T: b.offsetTop, W: b.offsetWidth, H: b.offsetHeight };
  }
  return { L: 0, T: 0, W: vp.clientWidth, H: vp.clientHeight };
}

function renderCaptions() {
  const r = outputRegion();
  for (const c of captions) {
    if (!c.el) continue;
    c.el.style.left = (r.L + c.fx * r.W) + 'px';
    c.el.style.top = (r.T + c.fy * r.H) + 'px';
    c.el.style.fontSize = Math.max(8, Math.round(c.sizeFrac * r.H)) + 'px';
    c.el.style.color = c.color;
    c.el.textContent = c.text || ' ';
    c.el.style.zIndex = zorder.indexOf(c) + 1;
    c.el.classList.toggle('sel', c === selCap);
  }
}

function addCaption() {
  const c = { id: ++capSeq, text: 'TEXT', fx: 0.5, fy: 0.15, sizeFrac: 0.12, color: '#ffffff' };
  const el = document.createElement('div');
  el.className = 'txtcap';
  el.addEventListener('mousedown', (e) => startCapDrag(e, c));
  $('overlayLayer').appendChild(el);
  c.el = el;
  captions.push(c);
  zorder.push(c); // newest on top
  selectCaption(c);
  $('capText').focus();
  $('capText').select();
}

function selectCaption(c) {
  selCap = c || null;
  const on = !!selCap;
  for (const id of ['capText', 'capColor', 'capSmaller', 'capBigger', 'capDel']) $(id).disabled = !on;
  if (on) { $('capText').value = selCap.text; $('capColor').value = selCap.color; }
  else { $('capText').value = ''; }
  if (selCap && selSticker) { selSticker = null; $('skDel').disabled = true; renderStickers(); } // one selection across layers
  renderCaptions();
  updateLayerButtons();
}

function deleteCaption(c) {
  c = c || selCap;
  if (!c) return;
  if (c.el) c.el.remove();
  captions = captions.filter((x) => x !== c);
  zorder = zorder.filter((x) => x !== c);
  selectCaption(captions[captions.length - 1] || null);
}

function clearCaptions() {
  for (const c of captions) if (c.el) c.el.remove();
  zorder = zorder.filter((x) => !captions.includes(x));
  captions = [];
  selectCaption(null);
}

// --- Snap guides: soft-snap a dragged overlay's center to the output region's
// center + rule-of-thirds lines, flashing an alignment guide while it holds. ---
const SNAP_TARGETS = [1 / 3, 0.5, 2 / 3];
const SNAP_TOL = 0.02; // within 2% of a line → snap onto it
function snapAxis(v) {
  for (const t of SNAP_TARGETS) if (Math.abs(v - t) <= SNAP_TOL) return { v: t, on: true };
  return { v, on: false };
}
// sx/sy = snapped fraction to draw a guide at, or null to hide that axis' guide.
function showGuides(sx, sy) {
  const r = outputRegion();
  const gv = $('capGuideV'), gh = $('capGuideH');
  if (gv) {
    if (sx == null) gv.classList.remove('on');
    else { gv.style.left = (r.L + sx * r.W) + 'px'; gv.style.top = r.T + 'px'; gv.style.height = r.H + 'px'; gv.classList.add('on'); }
  }
  if (gh) {
    if (sy == null) gh.classList.remove('on');
    else { gh.style.top = (r.T + sy * r.H) + 'px'; gh.style.left = r.L + 'px'; gh.style.width = r.W + 'px'; gh.classList.add('on'); }
  }
}
function hideGuides() { $('capGuideV')?.classList.remove('on'); $('capGuideH')?.classList.remove('on'); }

function startCapDrag(e, c) {
  e.preventDefault();
  e.stopPropagation();
  selectCaption(c);
  capDrag = { c, r: outputRegion() };
  document.addEventListener('mousemove', onCapDrag);
  document.addEventListener('mouseup', endCapDrag);
}

function onCapDrag(e) {
  if (!capDrag) return;
  const vp = $('viewport').getBoundingClientRect();
  const r = capDrag.r;
  const ax = snapAxis(Math.max(0, Math.min(1, (e.clientX - vp.left - r.L) / r.W)));
  const ay = snapAxis(Math.max(0, Math.min(1, (e.clientY - vp.top - r.T) / r.H)));
  capDrag.c.fx = ax.v; capDrag.c.fy = ay.v;
  showGuides(ax.on ? ax.v : null, ay.on ? ay.v : null);
  renderCaptions();
}

function endCapDrag() {
  capDrag = null;
  hideGuides();
  document.removeEventListener('mousemove', onCapDrag);
  document.removeEventListener('mouseup', endCapDrag);
}

// Build the ordered overlay payload (bottom→top) ffmpeg bakes: text → drawtext
// args, stickers → output-pixel width/height. Order follows `zorder`, so stacking
// is preserved in the output exactly as shown in the editor.
function layerPayload() {
  const out = outputDims();
  const payload = [];
  for (const item of zorder) {
    if (captions.includes(item)) {
      if (!String(item.text || '').trim().length) continue;
      payload.push({ kind: 'text', text: item.text, fx: item.fx, fy: item.fy, size: Math.round(item.sizeFrac * out.h), color: item.color });
    } else if (stickers.includes(item)) {
      const box = { fx: item.fx, fy: item.fy, w: Math.max(1, Math.round(item.wFrac * out.w)), h: Math.max(1, Math.round(item.hFrac * out.h)) };
      if (item.kind === 'webcam') payload.push({ kind: 'webcam', ...box }); // webcam video overlay
      else payload.push({ kind: 'sticker', path: item.src, ...box });
    }
  }
  return payload;
}

// ---- layer ordering (shared by captions + stickers) ----
function selectedLayer() { return selCap || selSticker; }

function reorderLayer(dir) {
  const item = selectedLayer();
  if (!item) return;
  const i = zorder.indexOf(item);
  const j = i + (dir > 0 ? 1 : -1);
  if (i < 0 || j < 0 || j >= zorder.length) return;
  zorder.splice(i, 1);
  zorder.splice(j, 0, item);
  renderCaptions();
  renderStickers();
  updateLayerButtons();
}

function updateLayerButtons() {
  const item = selectedLayer();
  const i = item ? zorder.indexOf(item) : -1;
  $('layerForward').disabled = i < 0 || i >= zorder.length - 1;
  $('layerBack').disabled = i <= 0;
}

// ---- image / sticker overlays ----
// Position is a center fraction of the output region (crop box when cropping,
// else the full frame); wFrac/hFrac are width/height fractions of the region so a
// sticker can be stretched independently on each axis.
function renderStickers() {
  const r = outputRegion();
  for (const s of stickers) {
    if (!s.el) continue;
    s.el.style.left = (r.L + s.fx * r.W) + 'px';
    s.el.style.top = (r.T + s.fy * r.H) + 'px';
    s.el.style.width = Math.max(8, s.wFrac * r.W) + 'px';
    s.el.style.height = Math.max(8, s.hFrac * r.H) + 'px';
    s.el.style.zIndex = zorder.indexOf(s) + 1;
    s.el.classList.toggle('sel', s === selSticker);
  }
}

function addSticker(src) {
  const s = { id: ++skSeq, src, fx: 0.5, fy: 0.5, wFrac: 0.3, hFrac: 0.3, natW: 0, natH: 0 };
  const el = document.createElement('div');
  el.className = 'sticker';
  const img = document.createElement('img');
  img.draggable = false;
  img.onload = () => {
    s.natW = img.naturalWidth; s.natH = img.naturalHeight;
    // Start at the image's natural aspect for the current region.
    const r = outputRegion();
    if (s.natW && r.H) s.hFrac = (s.wFrac * r.W) * (s.natH / s.natW) / r.H;
    renderStickers();
  };
  img.src = window.gifApp.toFileUrl(src);
  el.appendChild(img);
  for (const dir of SK_GRIPS) {
    const g = document.createElement('span');
    g.className = 'skgrip ' + dir;
    g.addEventListener('mousedown', (e) => startStickerResize(e, s, dir));
    el.appendChild(g);
  }
  el.addEventListener('mousedown', (e) => startStickerDrag(e, s));
  $('overlayLayer').appendChild(el);
  s.el = el; s.img = img;
  stickers.push(s);
  zorder.push(s); // newest on top
  selectSticker(s);
}

// The PiP webcam is a "video sticker": same drag/resize/z-order machinery as an
// image sticker, but the element is a looping <video> playing the webcam clip and
// it's flagged kind:'webcam' so the export composites the webcam VIDEO input.
function addWebcamSticker(src) {
  const s = { id: ++skSeq, kind: 'webcam', src, fx: 0.82, fy: 0.82, wFrac: 0.28, hFrac: 0.28, natW: 0, natH: 0 };
  const el = document.createElement('div');
  el.className = 'sticker webcam';
  const vid = document.createElement('video');
  vid.muted = true; vid.loop = true; vid.autoplay = true; vid.playsInline = true; vid.draggable = false;
  vid.addEventListener('loadedmetadata', () => {
    s.natW = vid.videoWidth; s.natH = vid.videoHeight;
    const r = outputRegion();
    if (s.natW && r.H) s.hFrac = (s.wFrac * r.W) * (s.natH / s.natW) / r.H; // start at natural aspect
    renderStickers();
  });
  vid.src = window.gifApp.toFileUrl(src);
  vid.play().catch(() => {});
  el.appendChild(vid);
  for (const dir of SK_GRIPS) {
    const g = document.createElement('span');
    g.className = 'skgrip ' + dir;
    g.addEventListener('mousedown', (e) => startStickerResize(e, s, dir));
    el.appendChild(g);
  }
  el.addEventListener('mousedown', (e) => startStickerDrag(e, s));
  $('overlayLayer').appendChild(el);
  s.el = el; s.vid = vid;
  stickers.push(s);
  zorder.push(s); // newest on top
  selectSticker(s);
}

function selectSticker(s) {
  selSticker = s || null;
  $('skDel').disabled = !selSticker;
  if (selSticker) selectCaption(null); // one selection at a time across layers
  renderStickers();
  updateLayerButtons();
}

function deleteSticker(s) {
  s = s || selSticker;
  if (!s) return;
  if (s.el) s.el.remove();
  stickers = stickers.filter((x) => x !== s);
  zorder = zorder.filter((x) => x !== s);
  selectSticker(null);
}

function clearStickers() {
  for (const s of stickers) if (s.el) s.el.remove();
  zorder = zorder.filter((x) => !stickers.includes(x));
  stickers = [];
  selectSticker(null);
}

function startStickerDrag(e, s) {
  e.preventDefault();
  e.stopPropagation();
  selectSticker(s);
  skDrag = { s, r: outputRegion() };
  document.addEventListener('mousemove', onStickerDrag);
  document.addEventListener('mouseup', endStickerDrag);
}

function onStickerDrag(e) {
  if (!skDrag) return;
  const vp = $('viewport').getBoundingClientRect();
  const r = skDrag.r;
  const ax = snapAxis(Math.max(0, Math.min(1, (e.clientX - vp.left - r.L) / r.W)));
  const ay = snapAxis(Math.max(0, Math.min(1, (e.clientY - vp.top - r.T) / r.H)));
  skDrag.s.fx = ax.v; skDrag.s.fy = ay.v;
  showGuides(ax.on ? ax.v : null, ay.on ? ay.v : null);
  renderStickers();
}

function endStickerDrag() {
  skDrag = null;
  hideGuides();
  document.removeEventListener('mousemove', onStickerDrag);
  document.removeEventListener('mouseup', endStickerDrag);
}

// 8-handle resize. Corners (nw/ne/sw/se) scale uniformly (aspect-locked) from the
// opposite corner; edge midpoints (n/s/e/w) stretch a single axis with the
// opposite edge anchored. Math is done in region pixels, then converted back to
// the center + width/height fractions the sticker stores.
function startStickerResize(e, s, dir) {
  e.preventDefault();
  e.stopPropagation();
  selectSticker(s);
  const r = outputRegion();
  const cx = s.fx * r.W, cy = s.fy * r.H, hw = (s.wFrac * r.W) / 2, hh = (s.hFrac * r.H) / 2;
  const wPx = s.wFrac * r.W;
  skResize = {
    s, r, dir,
    box: { left: cx - hw, right: cx + hw, top: cy - hh, bottom: cy + hh },
    aspect: wPx > 0 ? (s.hFrac * r.H) / wPx : 1, // height/width, for aspect-locked corners
  };
  document.addEventListener('mousemove', onStickerResize);
  document.addEventListener('mouseup', endStickerResize);
}

// Pure geometry for an 8-handle resize, in region pixels. `uniform` locks aspect
// (proportional scale) on every handle; otherwise corners stretch both axes and
// edges stretch a single axis. `aspect` = height/width. Returns the new box.
function resizeBox(box, dir, mx, my, aspect, uniform) {
  let { left, right, top, bottom } = box;
  const MIN = 12;
  if (dir.length === 2) { // corner — anchor = opposite corner
    const anchorX = dir.includes('w') ? right : left;
    const anchorY = dir.includes('n') ? bottom : top;
    let newW, newH;
    if (uniform) { newW = Math.max(MIN, Math.abs(mx - anchorX), Math.abs(my - anchorY) / aspect); newH = newW * aspect; }
    else { newW = Math.max(MIN, Math.abs(mx - anchorX)); newH = Math.max(MIN, Math.abs(my - anchorY)); }
    if (dir.includes('e')) { left = anchorX; right = anchorX + newW; } else { right = anchorX; left = anchorX - newW; }
    if (dir.includes('s')) { top = anchorY; bottom = anchorY + newH; } else { bottom = anchorY; top = anchorY - newH; }
  } else if (uniform) { // edge, locked aspect → grow the other axis about the center
    if (dir === 'e' || dir === 'w') {
      const anchorX = dir === 'e' ? left : right;
      const newW = Math.max(MIN, Math.abs(mx - anchorX)), newH = newW * aspect;
      if (dir === 'e') { left = anchorX; right = anchorX + newW; } else { right = anchorX; left = anchorX - newW; }
      const cy = (top + bottom) / 2; top = cy - newH / 2; bottom = cy + newH / 2;
    } else {
      const anchorY = dir === 's' ? top : bottom;
      const newH = Math.max(MIN, Math.abs(my - anchorY)), newW = newH / aspect;
      if (dir === 's') { top = anchorY; bottom = anchorY + newH; } else { bottom = anchorY; top = anchorY - newH; }
      const cx = (left + right) / 2; left = cx - newW / 2; right = cx + newW / 2;
    }
  } else { // edge, free → stretch one axis, opposite edge anchored
    if (dir === 'e') right = Math.max(left + MIN, mx);
    else if (dir === 'w') left = Math.min(right - MIN, mx);
    else if (dir === 's') bottom = Math.max(top + MIN, my);
    else if (dir === 'n') top = Math.min(bottom - MIN, my);
  }
  return { left, right, top, bottom };
}

function onStickerResize(e) {
  if (!skResize) return;
  const { s, r, dir, aspect } = skResize;
  const uniform = $('skUniform').checked; // lock aspect ratio (scale) vs free stretch
  const vp = $('viewport').getBoundingClientRect();
  const mx = e.clientX - vp.left - r.L; // region-relative pixels
  const my = e.clientY - vp.top - r.T;
  let { left, right, top, bottom } = skResize.box;
  const b = resizeBox({ left, right, top, bottom }, dir, mx, my, aspect, uniform);
  s.fx = ((b.left + b.right) / 2) / r.W;
  s.fy = ((b.top + b.bottom) / 2) / r.H;
  s.wFrac = (b.right - b.left) / r.W;
  s.hFrac = (b.bottom - b.top) / r.H;
  renderStickers();
}

function endStickerResize() {
  skResize = null;
  document.removeEventListener('mousemove', onStickerResize);
  document.removeEventListener('mouseup', endStickerResize);
}

// ---- black letterbox bars (top / bottom / left / right) ----
function renderBars() {
  const r = outputRegion();
  // Pixel-snap so a bar's far edge reaches the media edge exactly (floor the near
  // edge, ceil the far edge). Any ≤1px overlap is clipped by overflow:hidden, so
  // no sliver of the GIF peeks past the bar from sub-pixel rounding.
  const L = Math.floor(r.L), T = Math.floor(r.T);
  const R = Math.ceil(r.L + r.W), B = Math.ceil(r.T + r.H);
  const place = (el, on, x, y, w, h) => {
    if (!on) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.style.left = x + 'px'; el.style.top = y + 'px'; el.style.width = w + 'px'; el.style.height = h + 'px';
  };
  place($('barTop'), bars.top > 0, L, T, R - L, Math.ceil(r.T + bars.top * r.H) - T);
  const bTop = Math.floor(r.T + r.H - bars.bottom * r.H);
  place($('barBottom'), bars.bottom > 0, L, bTop, R - L, B - bTop);
  place($('barLeft'), bars.left > 0, L, T, Math.ceil(r.L + bars.left * r.W) - L, B - T);
  const rLeft = Math.floor(r.L + r.W - bars.right * r.W);
  place($('barRight'), bars.right > 0, rLeft, T, R - rLeft, B - T);
}

function updateBarButtons() {
  $('barTopBtn').classList.toggle('on', bars.top > 0);
  $('barBottomBtn').classList.toggle('on', bars.bottom > 0);
  $('barLeftBtn').classList.toggle('on', bars.left > 0);
  $('barRightBtn').classList.toggle('on', bars.right > 0);
}

function toggleBar(which) {
  bars[which] = bars[which] > 0 ? 0 : 0.15; // default thickness when turning on
  renderBars();
  updateBarButtons();
}

// Make each active opposite pair equal (to the thicker of the two).
function equalizeBars() {
  if (bars.top > 0 && bars.bottom > 0) { const m = Math.max(bars.top, bars.bottom); bars.top = bars.bottom = m; }
  if (bars.left > 0 && bars.right > 0) { const m = Math.max(bars.left, bars.right); bars.left = bars.right = m; }
  renderBars();
}

function clearBars() { bars = { top: 0, bottom: 0, left: 0, right: 0 }; renderBars(); updateBarButtons(); }

function startBarDrag(e, which) {
  e.preventDefault();
  e.stopPropagation();
  barDrag = { which, r: outputRegion() };
  document.addEventListener('mousemove', onBarDrag);
  document.addEventListener('mouseup', endBarDrag);
}

function onBarDrag(e) {
  if (!barDrag) return;
  const vp = $('viewport').getBoundingClientRect();
  const r = barDrag.r;
  const which = barDrag.which;
  let frac;
  if (which === 'top' || which === 'bottom') {
    const y = e.clientY - vp.top - r.T; // region px from top
    frac = which === 'top' ? y / r.H : (r.H - y) / r.H;
  } else {
    const x = e.clientX - vp.left - r.L; // region px from left
    frac = which === 'left' ? x / r.W : (r.W - x) / r.W;
  }
  bars[which] = Math.max(0.03, Math.min(0.6, frac));
  renderBars();
}

function endBarDrag() {
  barDrag = null;
  document.removeEventListener('mousemove', onBarDrag);
  document.removeEventListener('mouseup', endBarDrag);
}

// ---- sticker recents tray ----
async function refreshStickerTray() {
  const items = await window.gifApp.stickersList();
  const tray = $('skTray');
  tray.innerHTML = '';
  if (!items.length) {
    const empty = document.createElement('span');
    empty.className = 'skempty';
    empty.textContent = 'No saved stickers yet —';
    tray.appendChild(empty);
  }
  for (const it of items) {
    const thumb = document.createElement('div');
    thumb.className = 'skthumb';
    thumb.title = it.name || 'sticker';
    const img = document.createElement('img');
    img.src = window.gifApp.toFileUrl(it.path);
    thumb.appendChild(img);
    const rm = document.createElement('button');
    rm.className = 'skrm';
    rm.textContent = '×';
    rm.title = 'Remove from recents';
    rm.addEventListener('click', async (e) => { e.stopPropagation(); await window.gifApp.stickersRemove(it.id); refreshStickerTray(); });
    thumb.appendChild(rm);
    thumb.addEventListener('click', () => addSticker(it.path));
    tray.appendChild(thumb);
  }
  const up = document.createElement('button');
  up.className = 'skupload';
  up.textContent = '＋';
  up.title = 'Upload an image';
  up.addEventListener('click', uploadSticker);
  tray.appendChild(up);
}

async function uploadSticker() {
  const res = await window.gifApp.stickersImport();
  await refreshStickerTray();
  if (res && res.ok && res.item) addSticker(res.item.path); // drop the just-uploaded one onto the video
}

function updateEstimate() {
  if (!videoW || !clipDuration) { $('estSize').textContent = ''; return; }
  const { w, h } = outputDims();
  const fps = Number($('gifFps').value);
  const speed = Number($('gifSpeed').value) || 1;
  // speed retimes the clip: the GIF runs for duration/speed, so fewer frames.
  const frames = Math.max(1, Math.round(fps * (effectiveDuration() / speed)));
  $('estSize').textContent = `~${fmtBytes(w * h * frames * EST_BPP)} est.`;
}

function fmtBytes(b) {
  return b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';
}

// ---- save location ----
async function loadSaveDir() {
  try {
    const dir = await window.gifApp.getSaveDir();
    $('saveDir').textContent = dir;
    $('saveDir').title = dir;
  } catch { /* leave placeholder */ }
}

// ---- helpers ----
function fmt(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function fmtSec(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- Instant Replay: load an external clip into the editor (Phase 2) ----
function loadClip(file) {
  resetToPicker();
  $('grid').style.display = 'none';
  $('recBtn').style.display = 'none';
  $('stage').classList.add('show');
  $('homeBtn').style.display = '';
  $('backBtn').style.display = '';
  $('gifBtn').style.display = '';
  $('gifopts').classList.add('show');
  $('step').textContent = 'Replay';
  lastSavedBlob = null;
  lastSavedPath = file;
  $('gifBtn').disabled = false;
  const v = $('preview');
  v.srcObject = null;
  v.src = window.gifApp.toFileUrl(file);
  v.muted = true; v.loop = true;
  v.play().catch(() => {});
  v.addEventListener('loadedmetadata', initEditor, { once: true });
  $('hint').textContent = 'Replay loaded — trim/crop, then make your GIF.';
}
window.gifApp.onLoadClip(loadClip);

// A PiP replay: load the screen as the base clip, then add the webcam as a movable
// video sticker once the editor has laid out (initEditor also runs on the same
// loadedmetadata; the setTimeout lets it finish first so the region exists).
function loadPip({ screen, webcam }) {
  loadClip(screen);          // resetToPicker clears pipWebcamPath; set it after
  pipWebcamPath = webcam || null;
  if (!pipWebcamPath) return;
  const cam = pipWebcamPath;
  const v = $('preview');
  const add = () => setTimeout(() => addWebcamSticker(cam), 0);
  if (v.readyState >= 1) add();
  else v.addEventListener('loadedmetadata', add, { once: true });
  $('hint').textContent = 'Replay loaded — drag/resize your webcam, trim/crop, then make your GIF.';
}
window.gifApp.onLoadPip(loadPip);

// ---- wire buttons ----
$('homeBtn').addEventListener('click', () => {
  if (lastSavedPath && /\.webm$/i.test(lastSavedPath)) window.gifApp.deleteSource(lastSavedPath);
  if (pipWebcamPath && /\.webm$/i.test(pipWebcamPath)) window.gifApp.deleteSource(pipWebcamPath);
  window.gifApp.closeCapture();
});
$('recBtn').addEventListener('click', startRecording);
$('stopBtn').addEventListener('click', stopRecording);
$('backBtn').addEventListener('click', resetToPicker);
$('gifBtn').addEventListener('click', makeGif);
// Live conversion progress on the Make GIF button.
window.gifApp.onGifProgress((pct) => {
  const b = $('gifBtn');
  if (b.disabled && b.textContent.startsWith('Converting')) b.textContent = `Converting… ${pct}%`;
});
$('gifCopy').addEventListener('click', async () => {
  if (!lastGifPath) return;
  const btn = $('gifCopy');
  const r = await window.gifApp.copyGif(lastGifPath);
  if (r && r.ok) {
    btn.textContent = '✓ Copied — paste anywhere';
    btn.classList.add('done');
    setTimeout(() => { btn.textContent = 'GIF ready to copy'; btn.classList.remove('done'); }, 1600);
  } else {
    btn.textContent = `Copy failed: ${(r && r.error) || 'error'}`;
  }
});

// ▾ actions menu
$('gifMore').addEventListener('click', (e) => { e.stopPropagation(); $('copyMenu').classList.toggle('show'); });
document.addEventListener('click', (e) => {
  if (!$('copyWrap').contains(e.target)) $('copyMenu').classList.remove('show');
});
$('miPin').addEventListener('click', async () => {
  $('copyMenu').classList.remove('show');
  if (!lastGifPath) return;
  const r = await window.gifApp.sbAdd(lastGifPath);
  $('hint').textContent = (r && r.ok) ? 'Pinned to GifBoard' : 'Could not pin to GifBoard';
});
$('miOpen').addEventListener('click', () => { $('copyMenu').classList.remove('show'); if (lastGifPath) window.gifApp.openCapture(lastGifPath); });
$('miReveal').addEventListener('click', () => { $('copyMenu').classList.remove('show'); if (lastGifPath) window.gifApp.revealCapture(lastGifPath); });

// trim + crop
$('trimStart').addEventListener('input', () => onTrimInput('start'));
$('trimEnd').addEventListener('input', () => onTrimInput('end'));
$('cropToggle').addEventListener('click', toggleCrop);
$('cropReset').addEventListener('click', () => { setCropDefault(); if (cropRatio) fitBoxToAspect(); updateEstimate(); renderCaptions(); renderStickers(); renderBars(); });
$('cropAspect').addEventListener('change', applyAspect);

// text captions
$('addCap').addEventListener('click', addCaption);
$('capText').addEventListener('input', () => { if (selCap) { selCap.text = $('capText').value; renderCaptions(); } });
$('capColor').addEventListener('input', () => { if (selCap) { selCap.color = $('capColor').value; renderCaptions(); } });
$('capSmaller').addEventListener('click', () => { if (selCap) { selCap.sizeFrac = Math.max(0.04, selCap.sizeFrac - 0.02); renderCaptions(); } });
$('capBigger').addEventListener('click', () => { if (selCap) { selCap.sizeFrac = Math.min(0.6, selCap.sizeFrac + 0.02); renderCaptions(); } });
$('capDel').addEventListener('click', () => deleteCaption());
// stickers
$('stickerToggle').addEventListener('click', () => {
  const tray = $('skTray');
  const show = tray.style.display === 'none';
  tray.style.display = show ? '' : 'none';
  if (show) refreshStickerTray();
});
$('skDel').addEventListener('click', () => deleteSticker());
$('layerForward').addEventListener('click', () => reorderLayer(1));
$('layerBack').addEventListener('click', () => reorderLayer(-1));
// black bars
$('barTopBtn').addEventListener('click', () => toggleBar('top'));
$('barBottomBtn').addEventListener('click', () => toggleBar('bottom'));
$('barLeftBtn').addEventListener('click', () => toggleBar('left'));
$('barRightBtn').addEventListener('click', () => toggleBar('right'));
$('barEqualBtn').addEventListener('click', equalizeBars);
$('barTop').querySelector('.baredge').addEventListener('mousedown', (e) => startBarDrag(e, 'top'));
$('barBottom').querySelector('.baredge').addEventListener('mousedown', (e) => startBarDrag(e, 'bottom'));
$('barLeft').querySelector('.baredge').addEventListener('mousedown', (e) => startBarDrag(e, 'left'));
$('barRight').querySelector('.baredge').addEventListener('mousedown', (e) => startBarDrag(e, 'right'));
window.addEventListener('resize', () => { renderCaptions(); renderStickers(); renderBars(); });
$('gifSize').addEventListener('change', updateEstimate);
$('gifFps').addEventListener('change', updateEstimate);
$('gifSpeed').addEventListener('change', () => { applySpeed(); updateEstimate(); });
// crop box: drag a corner handle to resize, drag the body to move
$('cropbox').addEventListener('mousedown', (e) => {
  const corner = e.target.dataset.corner;
  if (corner) { e.stopPropagation(); startDrag(e, corner); }
  else startDrag(e, 'move');
});

// save location
$('changeDirBtn').addEventListener('click', async () => {
  const res = await window.gifApp.chooseSaveDir();
  if (res && res.dir) { $('saveDir').textContent = res.dir; $('saveDir').title = res.dir; }
});
$('openDirBtn').addEventListener('click', () => window.gifApp.openSaveDir());

loadSaveDir();
init();
