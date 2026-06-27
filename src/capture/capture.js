// Capture window: pick a source → record it (60s cap) → save raw WebM.
// Uses Electron's desktopCapturer (sources come from main via IPC) and the
// chromeMediaSource constraint to feed getUserMedia, then MediaRecorder.

const $ = (id) => document.getElementById(id);
const MAX_MS = 60_000; // 1-minute cap (raise later once the encoder is proven)

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

// ---- permission + sources ----
async function init() {
  $('permBtn').addEventListener('click', () => window.gifApp.openScreenPrefs());
  $('camPermBtn').addEventListener('click', () => window.gifApp.openCameraPrefs());

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
}

function selectSource(s, el) {
  selected = s;
  document.querySelectorAll('.src').forEach((n) => n.classList.remove('selected'));
  el.classList.add('selected');
  $('recBtn').disabled = false;
  $('hint').textContent = `Selected: ${s.name}`;
}

// ---- recording ----
function pickMime() {
  for (const m of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

async function startRecording() {
  if (!selected) return;

  const isWebcam = selected.kind === 'webcam';

  // Webcam uses the OS Camera permission (separate from Screen Recording).
  if (isWebcam) {
    const granted = await window.gifApp.askCamera();
    if (!granted) {
      $('camPerm').classList.add('show');
      $('hint').textContent = 'Camera access is needed to record your webcam.';
      return;
    }
    $('camPerm').classList.remove('show');
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia(
      isWebcam
        ? {
            audio: false,
            video: {
              ...(selected.deviceId ? { deviceId: { exact: selected.deviceId } } : {}),
              width: { ideal: 1280 },
              height: { ideal: 720 },
              frameRate: { ideal: 30 },
            },
          }
        : {
            audio: false,
            video: {
              mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: selected.id,
                maxFrameRate: 30,
                maxWidth: 1920,
                maxHeight: 1080,
              },
            },
          }
    );
  } catch (e) {
    $('hint').textContent = `Capture failed: ${e.message}`;
    return;
  }

  // Mirror the live self-view for a natural feel (recorded output stays normal).
  $('preview').classList.toggle('mirror', isWebcam);

  // switch UI to recording stage (hide Back so it can't interrupt a recording)
  $('homeBtn').style.display = 'none';
  $('tools').classList.remove('show');
  $('cropbox').classList.remove('show');
  $('copyWrap').classList.remove('show');
  $('copyMenu').classList.remove('show');
  $('grid').style.display = 'none';
  $('stage').classList.add('show');
  $('preview').srcObject = stream;
  $('recBtn').style.display = 'none';
  $('stopBtn').style.display = '';
  $('step').textContent = 'Recording…';
  $('hint').textContent = 'Recording — auto-stops at 1:00.';

  chunks = [];
  const mimeType = pickMime();
  recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onstop = onRecorderStop;
  recorder.start();

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
  if (stream) { stream.getTracks().forEach((t) => t.stop()); }
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
    res = await window.gifApp.toGif({ src: lastSavedPath, fps, width, trim, crop, speed, outSeconds, captions: captionPayload() });
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
  // Clean up the raw .webm from the previous capture (the GIF is what's kept).
  if (lastSavedPath && /\.webm$/i.test(lastSavedPath)) window.gifApp.deleteSource(lastSavedPath);
  selected = null;
  lastSavedBlob = null;
  lastSavedPath = null;
  clearCaptions();
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
}

function ratioVal(s) { const [a, b] = s.split(':').map(Number); return a / b; }

function applyAspect() {
  const v = $('cropAspect').value;
  cropRatio = v === 'free' ? null : ratioVal(v);
  if (cropOn && cropRatio) fitBoxToAspect();
  updateEstimate();
  renderCaptions();
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
    c.el.classList.toggle('sel', c === selCap);
  }
}

function addCaption() {
  const c = { id: ++capSeq, text: 'TEXT', fx: 0.5, fy: 0.15, sizeFrac: 0.12, color: '#ffffff' };
  const el = document.createElement('div');
  el.className = 'txtcap';
  el.addEventListener('mousedown', (e) => startCapDrag(e, c));
  $('capLayer').appendChild(el);
  c.el = el;
  captions.push(c);
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
  renderCaptions();
}

function deleteCaption(c) {
  c = c || selCap;
  if (!c) return;
  if (c.el) c.el.remove();
  captions = captions.filter((x) => x !== c);
  selectCaption(captions[captions.length - 1] || null);
}

function clearCaptions() {
  for (const c of captions) if (c.el) c.el.remove();
  captions = [];
  selectCaption(null);
}

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
  capDrag.c.fx = Math.max(0, Math.min(1, (e.clientX - vp.left - r.L) / r.W));
  capDrag.c.fy = Math.max(0, Math.min(1, (e.clientY - vp.top - r.T) / r.H));
  renderCaptions();
}

function endCapDrag() {
  capDrag = null;
  document.removeEventListener('mousemove', onCapDrag);
  document.removeEventListener('mouseup', endCapDrag);
}

// Map captions → the payload ffmpeg drawtext needs: font size in OUTPUT pixels
// (size fraction × output height) plus the center fractions + color.
function captionPayload() {
  if (!captions.length) return [];
  const out = outputDims();
  return captions
    .filter((c) => String(c.text || '').trim().length)
    .map((c) => ({ text: c.text, fx: c.fx, fy: c.fy, size: Math.round(c.sizeFrac * out.h), color: c.color }));
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

// ---- wire buttons ----
$('homeBtn').addEventListener('click', () => {
  if (lastSavedPath && /\.webm$/i.test(lastSavedPath)) window.gifApp.deleteSource(lastSavedPath);
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
$('cropReset').addEventListener('click', () => { setCropDefault(); if (cropRatio) fitBoxToAspect(); updateEstimate(); renderCaptions(); });
$('cropAspect').addEventListener('change', applyAspect);

// text captions
$('addCap').addEventListener('click', addCaption);
$('capText').addEventListener('input', () => { if (selCap) { selCap.text = $('capText').value; renderCaptions(); } });
$('capColor').addEventListener('input', () => { if (selCap) { selCap.color = $('capColor').value; renderCaptions(); } });
$('capSmaller').addEventListener('click', () => { if (selCap) { selCap.sizeFrac = Math.max(0.04, selCap.sizeFrac - 0.02); renderCaptions(); } });
$('capBigger').addEventListener('click', () => { if (selCap) { selCap.sizeFrac = Math.min(0.6, selCap.sizeFrac + 0.02); renderCaptions(); } });
$('capDel').addEventListener('click', () => deleteCaption());
window.addEventListener('resize', renderCaptions);
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
