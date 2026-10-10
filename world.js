export const TILE = 40;
export const COLS = 20;
export const ROWS = 14;
export const landmarks = [
  { x: 4, y: 3, name: 'Starlight Grove', description: 'The trees hum softly under a sky full of impossible stars.', color: '#b58ad8', symbol: '✦' },
  { x: 15, y: 3, name: 'Sunrise House', description: 'A warm little house with a light always on for travelers.', color: '#efaa75', symbol: '⌂' },
  { x: 10, y: 10, name: 'Moonwell', description: 'A still pool reflects a moon that seems to be here even by day.', color: '#8dbdd1', symbol: '☾' },
  { x: 16, y: 10, name: 'The Garden', description: 'Every flower has a story. The wind tells a different one each visit.', color: '#db9bb3', symbol: '✿' },
];
export const start = { x: 10, y: 6 };

export function move(position, direction) {
  const offsets = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
  const offset = offsets[direction];
  if (!offset) return position;
  return {
    x: Math.max(0, Math.min(COLS - 1, position.x + offset[0])),
    y: Math.max(0, Math.min(ROWS - 1, position.y + offset[1])),
  };
}

export function landmarkAt(position) {
  return landmarks.find((place) => place.x === position.x && place.y === position.y);
}

function draw(canvas, position) {
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#b7d6af';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const n = (x * 47 + y * 91 + x * y * 13) % 19;
      ctx.fillStyle = n < 5 ? '#adcea7' : n < 12 ? '#b9d9b3' : '#c1dfb8';
      ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
      if (n === 2 || n === 15) {
        ctx.fillStyle = n === 2 ? '#fff2b9' : '#fff9e6';
        ctx.beginPath();
        ctx.arc(x * TILE + 10 + n, y * TILE + 14, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  // A winding path gives the four places a shared center.
  ctx.strokeStyle = '#e6d5aa';
  ctx.lineWidth = 18;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(180, 140);
  ctx.quadraticCurveTo(330, 310, 420, 260);
  ctx.quadraticCurveTo(530, 180, 620, 140);
  ctx.moveTo(420, 260);
  ctx.quadraticCurveTo(380, 390, 420, 420);
  ctx.quadraticCurveTo(540, 470, 660, 420);
  ctx.stroke();
  for (const place of landmarks) {
    const px = (place.x + .5) * TILE;
    const py = (place.y + .5) * TILE;
    ctx.fillStyle = '#ffffff77';
    ctx.beginPath(); ctx.arc(px, py, 26, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = place.color;
    ctx.beginPath(); ctx.arc(px, py, 20, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 25px system-ui';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(place.symbol, px, py + 1);
  }
  const px = (position.x + .5) * TILE;
  const py = (position.y + .5) * TILE;
  ctx.fillStyle = '#38546b55';
  ctx.beginPath(); ctx.ellipse(px, py + 16, 14, 5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#3d5875';
  ctx.beginPath(); ctx.arc(px, py, 15, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#f6d7b7';
  ctx.beginPath(); ctx.arc(px, py - 5, 10, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#334454';
  ctx.beginPath(); ctx.arc(px, py - 9, 10, Math.PI, Math.PI * 2); ctx.fill();
}

if (typeof document !== 'undefined') {
  const canvas = document.querySelector('#world');
  const placeElement = document.querySelector('#place');
  const descriptionElement = document.querySelector('#description');
  const messageElement = document.querySelector('#message');
  let position = start;
  try {
    const saved = JSON.parse(localStorage.getItem('lucy-position'));
    if (Number.isInteger(saved?.x) && Number.isInteger(saved?.y) && saved.x >= 0 && saved.x < COLS && saved.y >= 0 && saved.y < ROWS) position = saved;
  } catch { /* Start at the meadow if storage is unavailable. */ }

  function render() {
    draw(canvas, position);
    const place = landmarkAt(position);
    placeElement.textContent = place?.name || 'The Meadow';
    descriptionElement.textContent = place?.description || 'A quiet place to wander. Follow a path or make your own.';
    messageElement.textContent = place ? `You discovered ${place.name}!` : 'Find the glowing places and step onto them.';
    try { localStorage.setItem('lucy-position', JSON.stringify(position)); } catch { /* Storage is optional. */ }
  }

  function step(direction) { position = move(position, direction); render(); }
  const keys = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right' };
  document.addEventListener('keydown', (event) => {
    const direction = keys[event.key] || keys[event.key.toLowerCase()];
    if (direction) { event.preventDefault(); step(direction); }
  });
  document.querySelectorAll('[data-move]').forEach((button) => button.addEventListener('click', () => step(button.dataset.move)));
  document.querySelector('#reset').addEventListener('click', () => { position = start; render(); });
  render();
}
