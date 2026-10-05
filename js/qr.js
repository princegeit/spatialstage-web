// QR codes for the phone pairing (pair.js): draw one, scan one.
//
// Needs two small MIT-licensed libraries kept next to this file so the pairing
// also works inside the Android app with no network: js/vendor/qrcode-generator.js
// (draws) and js/vendor/jsQR.js (reads a QR from camera frames).
//
// The offer code travels as a link - <remote.html>#<code> - so a phone's own
// camera app opens the right page with the code already filled in; the reply
// code is shown raw. codeFrom() accepts either.
(function () {
  'use strict';
  // The hosted copy of remote.html, for a PC page that is not itself reachable from the phone
  // (opened from localhost or a file).
  const PUBLIC_REMOTE = 'https://princegeit.github.io/spatialstage-web/remote.html';

  function svgOf(text) {
    const q = qrcode(0, 'L');   // lowest error correction: the codes are long, so fewer, larger modules
    q.addData(text);
    q.make();
    const n = q.getModuleCount(), quiet = 4, size = n + 2 * quiet;
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += 'M' + (c + quiet) + ',' + (r + quiet) + 'h1v1h-1z';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" shape-rendering="crispEdges" role="img" aria-label="QR code">' +
      '<rect width="100%" height="100%" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
  }
  function render(el, text) { el.innerHTML = svgOf(text); el.hidden = false; }

  function remoteUrl(code) {
    const here = typeof location !== 'undefined' ? location : null;
    const local = !here || !/^https?:$/.test(here.protocol) || ['localhost', '127.0.0.1', '[::1]'].includes(here.hostname);
    const base = local ? PUBLIC_REMOTE : new URL('remote.html', here.href).href;
    return base + '#' + code;
  }
  function codeFrom(text) {
    const t = String(text || '').trim(), i = t.indexOf('#');
    return (i >= 0 ? t.slice(i + 1) : t).trim();
  }

  // Camera -> QR text. Draws into `video`; calls onCode(text) once with the first code that
  // looks like a pairing code (or a link carrying one), then stops. Returns stop().
  async function scan(video, onCode, onError) {
    let stream = null, stopped = false, timer = null;
    const stop = () => {
      stopped = true; clearTimeout(timer);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    };
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
    } catch (e) { if (onError) onError(e); return stop; }
    video.srcObject = stream;
    video.setAttribute('playsinline', ''); video.muted = true;
    await video.play().catch(() => {});
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
    const tick = () => {
      if (stopped) return;
      if (video.videoWidth) {
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const hit = jsQR(img.data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
        if (hit && hit.data && hit.data.length > 20) { stop(); onCode(hit.data); return; }
      }
      timer = setTimeout(tick, 120);
    };
    tick();
    return stop;
  }

  window.SSQR = { render, remoteUrl, codeFrom, scan };
})();
