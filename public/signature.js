// Simple canvas-based signature pad, reusable by canvas element id.
const _sigState = {};

function initSignaturePad(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#0b3d63';
  let drawing = false;
  let hasDrawn = false;

  function pos(e) {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return { x: clientX - rect.left, y: clientY - rect.top };
  }
  function start(e) {
    e.preventDefault();
    drawing = true;
    hasDrawn = true;
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  }
  function move(e) {
    if (!drawing) return;
    e.preventDefault();
    const p = pos(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }
  function end() { drawing = false; }

  canvas.addEventListener('mousedown', start);
  canvas.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  canvas.addEventListener('touchstart', start, { passive: false });
  canvas.addEventListener('touchmove', move, { passive: false });
  canvas.addEventListener('touchend', end);

  _sigState[canvasId] = { canvas, ctx, get hasDrawn() { return hasDrawn; }, reset: () => { hasDrawn = false; } };
}

function clearSig(canvasId) {
  const s = _sigState[canvasId];
  if (!s) return;
  s.ctx.clearRect(0, 0, s.canvas.width, s.canvas.height);
  s.reset();
}

function getSignatureDataUrl(canvasId) {
  const s = _sigState[canvasId];
  if (!s || !s.hasDrawn) return '';
  return s.canvas.toDataURL('image/png');
}
