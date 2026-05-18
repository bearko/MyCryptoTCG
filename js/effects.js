// ============================================================
// effects.js — 紙吹雪 / sprite float / shake
// ============================================================

/**
 * 紙吹雪を降らせる
 * @param {number} count - 紙吹雪の数 (default 50)
 * @param {number} ms    - レイヤー hide までの時間 (default 3000ms)
 */
export function triggerConfetti(count = 50, ms = 3000) {
  const layer = document.getElementById("confettiLayer");
  if (!layer) return;
  layer.classList.remove("hidden");
  layer.innerHTML = "";  // 既存 piece 片付け

  const colors = [
    "#ffd700", "#ff6b9d", "#5ecf8a", "#56ccf2",
    "#bb86fc", "#ff9844", "#f9f871", "#ff5252",
  ];
  const W = window.innerWidth || 800;

  for (let i = 0; i < count; i++) {
    const piece = document.createElement("span");
    piece.className = "confetti-piece";
    piece.style.left = (Math.random() * W) + "px";
    piece.style.background = colors[i % colors.length];
    piece.style.setProperty("--cx", (Math.random() * 200 - 100) + "px");
    piece.style.animationDuration = (1.8 + Math.random() * 1.4).toFixed(2) + "s";
    piece.style.animationDelay = (Math.random() * 0.6).toFixed(2) + "s";
    layer.appendChild(piece);
  }

  setTimeout(() => {
    layer.classList.add("hidden");
    layer.innerHTML = "";
  }, ms);
}

/**
 * 要素に shake animation を当てる (= reflow 強制でリトリガ可能)
 * @param {HTMLElement} el
 */
export function applyShake(el) {
  if (!el) return;
  el.classList.remove("shake");
  void el.offsetWidth;
  el.classList.add("shake");
}

// ============================================================
// Sprite Float (= +N が浮上して消える)
// ============================================================

const _spriteFloats = [];
let _floatId = 0;
const FLOAT_TTL_MS = 1500;

/**
 * @param {{ value: string, x: number, y: number, color?: string }} opts
 */
export function pushSpriteFloat({ value, x, y, color = "#fff" }) {
  const layer = document.getElementById("floatLayer");
  if (!layer) return;
  layer.classList.remove("hidden");

  const piece = document.createElement("span");
  piece.className = "sprite-float";
  piece.style.left = `${x}px`;
  piece.style.top = `${y}px`;
  piece.style.color = color;
  piece.textContent = String(value);
  layer.appendChild(piece);

  const id = ++_floatId;
  _spriteFloats.push({ id, el: piece, createdAt: Date.now() });

  setTimeout(() => {
    piece.remove();
    const idx = _spriteFloats.findIndex((s) => s.id === id);
    if (idx >= 0) _spriteFloats.splice(idx, 1);
    if (_spriteFloats.length === 0) layer.classList.add("hidden");
  }, FLOAT_TTL_MS);
}
