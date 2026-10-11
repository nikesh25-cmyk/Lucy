// One shared tile map powers both server movement and the browser renderer.
export const TILE = 40;
export const COLS = 20;
export const ROWS = 14;
export const start = Object.freeze({ x: 10, y: 6 });
export const landmarks = [
  { x: 10, y: 6, name: 'Welcome Plaza', description: 'The heart of the world. Meet visiting agents, introduce yourself, and follow the paths to a shared mission.', color: '#d9a36d', symbol: '✧' },
  { x: 11, y: 6, name: 'Mission Board', description: 'Find a mission, claim a task, and submit evidence for human review.', color: '#637f69', symbol: '▤' },
  { x: 4, y: 3, name: 'Climate Grove', description: 'A living garden for climate research, practical environmental learning, and careful evidence.', color: '#64a87e', symbol: '✿' },
  { x: 15, y: 3, name: 'Peace Pavilion', description: 'A quiet meeting place for thoughtful dialogue and nonpartisan peace resources.', color: '#8b91c9', symbol: '☮' },
  { x: 10, y: 10, name: 'Contribution Gallery', description: 'Explore contributions and evidence accepted by mission reviewers.', color: '#8dbdd1', symbol: '☆' },
  { x: 16, y: 10, name: 'Help Point', description: 'Learn how to connect an agent, explore the world, and manage your character.', color: '#db9bb3', symbol: '?' },
];

const map = Array.from({ length: ROWS }, () => Array(COLS).fill('meadow'));
const paint = (x, y, width, height, type) => {
  for (let row = y; row < y + height; row++) for (let col = x; col < x + width; col++) map[row][col] = type;
};
// Paths form an accessible loop with short branches to every destination.
paint(3, 3, 14, 1, 'path');
paint(4, 3, 1, 8, 'path');
paint(15, 3, 1, 8, 'path');
paint(4, 6, 12, 1, 'path');
paint(4, 10, 13, 1, 'path');
paint(10, 6, 1, 5, 'path');
paint(8, 4, 5, 4, 'plaza');
paint(3, 2, 4, 1, 'garden');
paint(3, 4, 4, 1, 'garden');
paint(0, 0, 3, 3, 'water');
paint(0, 3, 2, 4, 'water');
paint(1, 5, 2, 2, 'water');
paint(0, 7, 2, 3, 'water');
paint(1, 10, 2, 2, 'water');
paint(3, 5, 2, 1, 'bridge');
// A second small pond and a wooden bridge mark the south garden.
paint(6, 11, 3, 2, 'water');
paint(7, 10, 1, 4, 'bridge');
paint(14, 1, 3, 2, 'building');
paint(9, 8, 3, 2, 'building');
paint(16, 8, 2, 2, 'building');
paint(9, 5, 1, 1, 'fountain');
const trees = [[4, 0], [6, 0], [9, 0], [11, 1], [18, 0], [19, 2], [6, 1], [2, 3], [7, 4], [18, 4], [19, 6], [2, 8], [6, 8], [7, 9], [18, 10], [4, 12], [10, 12], [13, 12], [16, 12], [19, 12], [0, 13]];
for (const [x, y] of trees) map[y][x] = 'tree';
export const terrain = Object.freeze(map.map((row) => Object.freeze(row)));

export function terrainAt(position, world) {
  const tiles = world ? getWorldDefinition(world).terrain : terrain;
  if (!Number.isInteger(position?.x) || !Number.isInteger(position?.y)) return undefined;
  return tiles[position.y]?.[position.x];
}

export function walkable(position, world) {
  const type = terrainAt(position, world);
  return type !== undefined && !['water', 'tree', 'building', 'fountain', 'wall'].includes(type);
}

export function move(position, direction, world) {
  const offsets = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
  const offset = offsets[direction];
  if (!offset || !Number.isInteger(position?.x) || !Number.isInteger(position?.y)) return position;
  const next = { x: position.x + offset[0], y: position.y + offset[1] };
  return walkable(next, world) ? next : position;
}

export function landmarkAt(position, world) {
  return (world ? getWorldDefinition(world).landmarks : landmarks).find((place) => place.x === position?.x && place.y === position?.y);
}

const definitions = new Map();
const cellNoise = (x, y, seed = 17) => ((Math.imul(x + 11, 73856093) ^ Math.imul(y + 29, 19349663) ^ seed) >>> 0) % 997;
const makeGrid = (columns, rows, fill = 'meadow') => Array.from({ length: rows }, () => Array(columns).fill(fill));
function paintGrid(grid, x, y, width, height, type) {
  for (let row = y; row < y + height; row++) for (let col = x; col < x + width; col++) {
    if (grid[row]?.[col] !== undefined) grid[row][col] = type;
  }
}
function road(grid, a, b) {
  const [left, right] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
  const [top, bottom] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
  for (let x = left; x <= right; x++) grid[a.y][x] = grid[a.y][x] === 'water' ? 'bridge' : 'path';
  for (let y = top; y <= bottom; y++) grid[y][b.x] = grid[y][b.x] === 'water' ? 'bridge' : 'path';
}
const portal = (x, y, name, targetWorldId) => ({ x, y, name, targetWorldId });

function makeCommons() {
  const columns = 96;
  const rows = 64;
  const grid = makeGrid(columns, rows);
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
    const n = cellNoise(x, y);
    if (n < 145 && (x > 21 || y > 15)) grid[y][x] = 'tree';
    else if (n > 932) grid[y][x] = 'garden';
    const river = 48 + Math.round(Math.sin(y / 7) * 4);
    if (Math.abs(x - river) < 2) grid[y][x] = 'water';
    if ((x - 76) ** 2 / 80 + (y - 13) ** 2 / 28 < 1) grid[y][x] = 'water';
  }
  // Preserve the original welcoming town and existing saved arrival coordinates.
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) grid[y][x] = terrain[y][x];
  const sites = [
    ...landmarks,
    { x: 30, y: 9, name: 'Orchard Square', description: 'Shared orchard and outdoor conversation tables.', symbol: '✿', color: '#95ac70' },
    { x: 35, y: 24, name: 'Open Air Theatre', description: 'A terraced gathering place for world announcements and public meetings.', symbol: '▤', color: '#b69078' },
    { x: 62, y: 7, name: 'Riverside Commons', description: 'A meeting district across the river, with benches and quiet paths.', symbol: '✧', color: '#7da5ae' },
    { x: 80, y: 24, name: 'East Garden', description: 'A communal growing space surrounded by flowers and orchards.', symbol: '✿', color: '#9aac73' },
    { x: 20, y: 44, name: 'Countryside Camp', description: 'An open countryside rest area for roaming agents and human visitors.', symbol: '▲', color: '#c6a371' },
    { x: 63, y: 44, name: 'Reflection Garden', description: 'A peaceful outdoor meditation space beside the southern river.', symbol: '☮', color: '#ad96b6' },
    { x: 84, y: 53, name: 'Home District', description: 'Visit personal gardens and homes created by the inhabitants.', symbol: '⌂', color: '#d1ac8b' },
  ];
  const outdoorObjects = [];
  for (const site of sites.slice(6)) {
    paintGrid(grid, site.x - 3, site.y - 3, 7, 7, 'meadow');
    paintGrid(grid, site.x - 2, site.y - 2, 5, 5, 'plaza');
    road(grid, start, site);
    outdoorObjects.push({ type: 'bench', x: site.x - 2, y: site.y - 1 }, { type: 'bench', x: site.x + 2, y: site.y - 1 }, { type: 'lamp', x: site.x - 2, y: site.y + 2 }, { type: 'flowers', x: site.x + 2, y: site.y + 2 });
  }
  // Additional roads make a navigable loop around both sides of the river.
  for (const y of [6, 20, 36, 50]) road(grid, { x: 10, y }, { x: 87, y });
  road(grid, { x: 25, y: 6 }, { x: 25, y: 55 });
  road(grid, { x: 85, y: 6 }, { x: 85, y: 55 });
  road(grid, { x: 19, y: 6 }, { x: 19, y: 55 });
  for (let y = 6; y <= 12; y += 2) for (let x = 27; x <= 34; x += 2) {
    if (grid[y][x] === 'meadow') outdoorObjects.push({ type: 'tree', x, y });
  }
  for (let y = 21; y <= 27; y += 2) for (let x = 76; x <= 83; x += 2) {
    if (grid[y][x] === 'meadow') outdoorObjects.push({ type: 'farm', x, y });
  }
  // Theatre terraces leave the central route open.
  for (let y = 22; y <= 26; y += 2) for (const x of [32, 38]) outdoorObjects.push({ type: 'bench', x, y });
  // Decorative trees never leave isolated walkable islands.
  const queue = [start];
  const seen = new Set([`${start.x},${start.y}`]);
  for (let i = 0; i < queue.length; i++) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const x = queue[i].x + dx; const y = queue[i].y + dy; const type = grid[y]?.[x];
    const key = `${x},${y}`;
    if (type && !['water', 'tree', 'building', 'fountain'].includes(type) && !seen.has(key)) { seen.add(key); queue.push({ x, y }); }
  }
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
    if (!['water', 'tree', 'building', 'fountain'].includes(grid[y][x]) && !seen.has(`${x},${y}`)) grid[y][x] = 'tree';
  }
  return { id: 'commons', name: 'The Commons', kind: 'outdoors', columns, rows, start, terrain: grid, landmarks: sites, objects: outdoorObjects,
    portals: [portal(11, 6, 'Meeting Hall', 'hall'), portal(15, 3, 'Peace Pavilion', 'pavilion'), portal(10, 10, 'Contribution Gallery', 'gallery'), portal(4, 3, 'Meditation Grove', 'meditation')] };
}

function makeInterior(id) {
  const names = { hall: 'Meeting Hall', pavilion: 'Peace Pavilion', gallery: 'Contribution Gallery', meditation: 'Meditation Sanctuary' };
  const grid = makeGrid(COLS, ROWS, 'floor');
  paintGrid(grid, 0, 0, COLS, 1, 'wall');
  paintGrid(grid, 0, ROWS - 1, COLS, 1, 'wall');
  paintGrid(grid, 0, 0, 1, ROWS, 'wall');
  paintGrid(grid, COLS - 1, 0, 1, ROWS, 'wall');
  paintGrid(grid, 4, 3, 12, 7, id === 'meditation' ? 'garden' : 'rug');
  const roomObjects = [];
  if (id === 'hall' || id === 'pavilion') {
    for (const x of [4, 7, 12, 15]) for (const y of [4, 7]) roomObjects.push({ type: 'bench', x, y });
    roomObjects.push({ type: 'table', x: 9, y: 4 }, { type: 'table', x: 10, y: 7 });
  } else if (id === 'gallery') {
    for (const x of [3, 7, 12, 16]) roomObjects.push({ type: 'display', x, y: 3 });
    for (const x of [5, 14]) roomObjects.push({ type: 'bench', x, y: 8 });
  } else {
    for (const x of [5, 9, 13]) for (const y of [4, 7]) roomObjects.push({ type: 'cushion', x, y });
    roomObjects.push({ type: 'fountain', x: 10, y: 2 }, { type: 'flowers', x: 3, y: 5 }, { type: 'flowers', x: 16, y: 5 });
  }
  for (const x of [2, 17]) for (const y of [2, 10]) roomObjects.push({ type: 'lamp', x, y });
  const arrival = { x: 10, y: 11 };
  return { id, name: names[id], kind: 'interior', columns: COLS, rows: ROWS, start: arrival, terrain: grid, objects: roomObjects,
    landmarks: [{ x: 10, y: 5, name: names[id], description: id === 'meditation' ? 'A quiet sanctuary. Sit on a cushion, rest, or meditate.' : 'An indoor shared space for meetings, conversation, and cooperation.', color: '#a8a0c0', symbol: id === 'meditation' ? '☮' : '✧' }],
    portals: [portal(10, 11, 'Return to the Commons', 'commons')] };
}

function makeHome(id) {
  const columns = 32; const rows = 24;
  const grid = makeGrid(columns, rows);
  paintGrid(grid, 0, 0, columns, 1, 'tree');
  paintGrid(grid, 0, rows - 1, columns, 1, 'tree');
  paintGrid(grid, 0, 0, 1, rows, 'tree');
  paintGrid(grid, columns - 1, 0, 1, rows, 'tree');
  paintGrid(grid, 1, 11, 16, 3, 'path');
  paintGrid(grid, 15, 2, 2, 21, 'path');
  paintGrid(grid, 5, 6, 2, 6, 'path');
  paintGrid(grid, 3, 2, 6, 4, 'building');
  const arrival = { x: 6, y: 7 };
  return { id, name: 'Personal Garden', kind: 'home', columns, rows, start: arrival, terrain: grid, objects: [],
    landmarks: [{ x: 6, y: 6, name: 'Garden Cottage', description: 'Your personal home and garden. Build paths, plant crops, and create a place to welcome visitors.', symbol: '⌂', color: '#c29883' }],
    portals: [portal(1, 12, 'Return to the Commons', 'commons'), portal(6, 6, 'Enter Garden Cottage', `house:${id.slice(5)}`)] };
}

function makeHouse(id) {
  const base = makeInterior('hall');
  return { ...base, id, name: 'Garden Cottage', kind: 'interior',
    objects: [{ type: 'bed', x: 4, y: 4 }, { type: 'bookshelf', x: 4, y: 2 }, { type: 'table', x: 12, y: 5 }, { type: 'bench', x: 11, y: 6 }, { type: 'bench', x: 13, y: 6 }, { type: 'flowers', x: 15, y: 3 }, { type: 'lamp', x: 3, y: 9 }, { type: 'lamp', x: 16, y: 9 }, { type: 'kitchen', x: 15, y: 2 }],
    landmarks: [{ x: 10, y: 5, name: 'Garden Cottage', description: 'A private home with a bed, library, kitchen, and room to welcome visitors.', color: '#c8a594', symbol: '⌂' }],
    portals: [portal(10, 11, 'Return to your Garden', `home:${id.slice(6)}`)] };
}

/** Pass either a stable world ID or its API descriptor. Unknown IDs are rejected. */
export function getWorldDefinition(world = 'commons') {
  const descriptor = typeof world === 'object' && world !== null ? world : undefined;
  const id = typeof world === 'string' ? world : descriptor?.id || descriptor?.worldId || 'commons';
  let definition = definitions.get(id);
  if (!definition) {
    if (id === 'commons') definition = makeCommons();
    else if (['hall', 'pavilion', 'gallery', 'meditation'].includes(id)) definition = makeInterior(id);
    else if (id.startsWith('home:')) definition = makeHome(id);
    else if (id.startsWith('house:')) definition = makeHouse(id);
    else throw new RangeError(`Unknown world: ${id}`);
    if (definitions.size >= 36) {
      const oldestHome = [...definitions.keys()].find((key) => key.startsWith('home:') || key.startsWith('house:'));
      if (oldestHome) definitions.delete(oldestHome);
    }
    definitions.set(id, definition);
  }
  return descriptor ? { ...definition, ...descriptor, terrain: descriptor.terrain || definition.terrain, landmarks: descriptor.landmarks || definition.landmarks, portals: descriptor.portals || definition.portals, objects: descriptor.objects || definition.objects } : definition;
}

export function cameraFor(position, world = 'commons') {
  const definition = getWorldDefinition(world);
  return { x: Math.max(0, Math.min(definition.columns - COLS, Math.floor((position?.x ?? definition.start.x) - COLS / 2))), y: Math.max(0, Math.min(definition.rows - ROWS, Math.floor((position?.y ?? definition.start.y) - ROWS / 2))) };
}

// All art is drawn locally, with pixel rectangles and no image dependencies.
export function draw(canvas, position, visitorsOrOptions = [], legacySelf = {}) {
  const options = Array.isArray(visitorsOrOptions) ? { visitors: visitorsOrOptions, self: legacySelf } : visitorsOrOptions || {};
  const world = options.world ? getWorldDefinition(options.world) : { id: 'legacy', kind: 'outdoors', columns: COLS, rows: ROWS, start, terrain, landmarks, portals: [], objects: [] };
  const visitors = options.visitors || [];
  const self = options.self;
  const chosenCamera = options.camera || cameraFor(position, world.id === 'legacy' ? { id: 'commons', columns: COLS, rows: ROWS } : world);
  const camera = { x: Math.max(0, Math.min(world.columns - COLS, Math.floor(chosenCamera.x || 0))), y: Math.max(0, Math.min(world.rows - ROWS, Math.floor(chosenCamera.y || 0))) };
  const tiles = world.terrain;
  const theme = world.id === 'pavilion' ? { floor: '#d0c8b5', rug: '#a0b2b6', seam: '#82999e', border: '#dedcc8' } : world.id === 'gallery' ? { floor: '#d8c5aa', rug: '#b6ad90', seam: '#999174', border: '#eee1ba' } : world.id.startsWith('house:') ? { floor: '#dcc7a6', rug: '#a7b9ad', seam: '#8b9e92', border: '#e9dec3' } : { floor: '#d7c6ae', rug: '#baa4ae', seam: '#a58d99', border: '#eee0c0' };
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.scale(canvas.width / (COLS * TILE), canvas.height / (ROWS * TILE));
  ctx.translate(-camera.x * TILE, -camera.y * TILE);
  const rect = (x, y, width, height, color) => {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), Math.round(y), Math.round(width), Math.round(height));
  };
  const pixelText = (text, x, y, color, size = 10) => {
    ctx.font = `600 ${size}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  };
  const blossom = (x, y, color) => {
    rect(x + 2, y + 3, 2, 6, '#4b8b67');
    rect(x, y, 6, 3, color);
    rect(x + 2, y - 2, 2, 7, color);
    rect(x + 2, y + 1, 2, 2, '#fff2bb');
  };
  const tree = (x, y, flowering = false) => {
    rect(x - 12, y + 11, 33, 8, '#426f5433');
    rect(x - 7, y + 15, 29, 5, '#426f5422');
    rect(x - 4, y - 6, 8, 24, '#795744');
    rect(x + 1, y - 5, 3, 22, '#a97b4f');
    rect(x - 17, y - 24, 34, 20, '#2e674d');
    rect(x - 12, y - 31, 25, 29, flowering ? '#ac7198' : '#3e825e');
    rect(x - 6, y - 37, 15, 27, flowering ? '#cf99b7' : '#65a36e');
    rect(x - 15, y - 21, 12, 7, flowering ? '#dea9c0' : '#5c9a6b');
    rect(x + 6, y - 17, 7, 6, flowering ? '#d7a0c1' : '#4c9161');
    if (flowering) {
      rect(x - 7, y - 25, 3, 3, '#ffe3dd');
      rect(x + 7, y - 10, 3, 3, '#ffe3dd');
    }
  };
  const window = (x, y) => {
    rect(x, y, 15, 18, '#4a5065');
    rect(x + 2, y + 2, 11, 13, '#7aadb7');
    rect(x + 3, y + 3, 4, 5, '#abd4d3');
    rect(x + 9, y + 10, 3, 4, '#aedbd7');
    rect(x + 7, y + 2, 2, 13, '#e4e0c7');
    rect(x + 2, y + 8, 11, 2, '#e4e0c7');
    rect(x - 2, y + 17, 19, 3, '#b48765');
  };
  const bench = (x, y) => {
    rect(x, y + 9, 24, 6, '#54765333');
    rect(x + 2, y, 3, 14, '#6e5b52');
    rect(x + 19, y, 3, 14, '#6e5b52');
    rect(x, y, 24, 4, '#bc916a');
    rect(x, y + 6, 24, 4, '#d2a87a');
  };
  const lamp = (x, y) => {
    rect(x - 11, y - 28, 22, 22, '#f7e4a810');
    rect(x - 2, y - 18, 4, 28, '#576557');
    rect(x - 6, y - 24, 12, 12, '#5b6859');
    rect(x - 3, y - 22, 6, 7, '#f7e4a8');
    rect(x - 5, y + 9, 10, 3, '#697566');
  };

  // Ground textures stay stable between frames so movement is easy to follow.
  for (let y = camera.y; y < Math.min(world.rows, camera.y + ROWS); y++) {
    for (let x = camera.x; x < Math.min(world.columns, camera.x + COLS); x++) {
      const px = x * TILE;
      const py = y * TILE;
      const n = (x * 47 + y * 91 + x * y * 13) % 19;
      const type = tiles[y][x];
      rect(px, py, TILE, TILE, world.id === 'meditation' && type === 'garden' ? ['#9db09d', '#a3b6a1', '#a7bba5'][n % 3] : ['#8fb78b', '#98c193', '#a0c798'][n % 3]);
      if (type === 'water') {
        rect(px, py, TILE, TILE, n % 2 ? '#6baab1' : '#71b4bc');
        rect(px + 5 + n % 8, py + 11, 12, 2, '#a6d0ca');
        rect(px + 16, py + 29, 14, 2, '#4e95a2');
        rect(px + 11, py + 14, 8, 1, '#bedbd2');
        if (n === 6 || n === 12) {
          rect(px + 22, py + 21, 10, 5, '#698e61');
          rect(px + 25, py + 20, 5, 2, '#a5bd76');
          if (n === 12) blossom(px + 25, py + 19, '#ebc3c6');
        }
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const adjacent = tiles[y + dy]?.[x + dx];
          if (adjacent && adjacent !== 'water' && adjacent !== 'bridge') {
            if (dx) {
              rect(px + (dx > 0 ? 32 : 0), py, 8, TILE, '#5c97a177');
              rect(px + (dx > 0 ? 36 : 0), py, 4, TILE, '#b2c995');
            } else {
              rect(px, py + (dy > 0 ? 32 : 0), TILE, 8, '#5c97a177');
              rect(px, py + (dy > 0 ? 36 : 0), TILE, 4, '#b2c995');
            }
          }
        }
      } else if (type === 'wall') {
        rect(px, py, TILE, TILE, '#727a89');
        rect(px + 1, py + 3, TILE - 2, 17, '#9299a5');
        rect(px + 1, py + 23, TILE - 2, 15, '#89919e');
        rect(px + 19, py + 4, 2, 15, '#abb0b7');
      } else if (type === 'floor' || type === 'rug') {
        rect(px, py, TILE, TILE, type === 'rug' ? theme.rug : theme.floor);
        if (type === 'rug') {
          if (n % 4 === 0) { rect(px + 17, py + 17, 6, 6, theme.border + '55'); rect(px + 19, py + 15, 2, 10, theme.border + '55'); }
          for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) if (tiles[y + dy]?.[x + dx] !== 'rug') {
            if (dx) { rect(px + (dx > 0 ? 32 : 0), py, 8, TILE, theme.border); rect(px + (dx > 0 ? 30 : 8), py, 2, TILE, theme.seam); }
            else { rect(px, py + (dy > 0 ? 32 : 0), TILE, 8, theme.border); rect(px, py + (dy > 0 ? 30 : 8), TILE, 2, theme.seam); }
          }
        } else {
          rect(px + 1, py + 19, TILE - 2, 1, '#bda98e');
          rect(px + 19, py + 1, 1, 18, '#bda98e');
          if (tiles[y - 1]?.[x] === 'wall') rect(px, py, TILE, 5, '#56615a20');
          if (tiles[y]?.[x - 1] === 'wall') rect(px, py, 5, TILE, '#56615a20');
        }
      } else if (type === 'path' || type === 'plaza') {
        rect(px, py, TILE, TILE, type === 'plaza' ? '#ddceb0' : '#d3c49c');
        rect(px + 2, py + 2, 35, 2, '#e7d9ba');
        rect(px + 2, py + 22, 35, 1, '#c0af91');
        rect(px + (y % 2 ? 11 : 26), py + 3, 1, 19, '#c5b594');
        rect(px + (y % 2 ? 26 : 11), py + 23, 1, 16, '#c5b594');
      } else if (type === 'bridge') {
        rect(px, py, TILE, TILE, '#ad8560');
        for (let plank = 0; plank < 5; plank++) rect(px + 2, py + plank * 8, TILE - 4, 2, '#d6b18a');
        rect(px, py, 3, TILE, '#7c654f');
        rect(px + 37, py, 3, TILE, '#7c654f');
      } else if (type !== 'building') {
        rect(px + 5 + n % 10, py + 9, 2, 4, '#729d76');
        rect(px + 26, py + 28, 2, 4, '#7da67c');
        rect(px + 28, py + 26, 2, 3, '#7da67c');
        if (n === 8 && type === 'meadow' && !world.id.startsWith('home:')) {
          rect(px + 13, py + 21, 9, 4, '#879983'); rect(px + 15, py + 19, 5, 2, '#c0c5a6');
        }
        if (n === 2 || n === 15 || (type === 'garden' && world.id !== 'meditation')) blossom(px + 11, py + 24, type === 'garden' ? '#e1b5a6' : '#f6e6b0');
        if (type === 'garden' && world.id !== 'meditation') blossom(px + 27, py + 11, '#f2d69b');
        if (type === 'garden' && world.id === 'meditation') {
          if (n === 6 || n === 10) { rect(px + 14, py + 24, 11, 5, '#8b9988'); rect(px + 16, py + 21, 7, 4, '#c6cbb0'); }
          for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) if (tiles[y + dy]?.[x + dx] !== 'garden') {
            if (dx) rect(px + (dx > 0 ? 36 : 0), py, 4, TILE, '#c4c8ab');
            else rect(px, py + (dy > 0 ? 36 : 0), TILE, 4, '#c4c8ab');
          }
        }
      }
    }
  }

  if (world.id === 'commons' || world.id === 'legacy') {
  // Peace pavilion: open columns, purple roof, and a calm meeting terrace.
  rect(557, 107, 132, 19, '#556c6330');
  rect(566, 72, 108, 47, '#e8dfc6');
  rect(562, 112, 117, 9, '#a6a29c');
  rect(557, 120, 126, 7, '#c5c4b4');
  for (const x of [568, 596, 638, 663]) {
    rect(x, 75, 8, 37, '#cac3b8');
    rect(x + 1, 75, 3, 35, '#f4ead5');
  }
  rect(550, 65, 140, 11, '#65678c');
  rect(557, 55, 126, 12, '#8382ad');
  rect(568, 46, 104, 11, '#9994bc');
  rect(586, 37, 68, 11, '#b0a7cd');
  rect(612, 31, 16, 8, '#c2b5d7');
  pixelText('☮', 620, 59, '#f5e6cb', 16);

  // Contribution gallery and help cottage both have visible doors to the path.
  rect(359, 382, 125, 18, '#4a685e33');
  rect(365, 338, 110, 54, '#e8d4ae');
  rect(365, 378, 110, 13, '#bd9b78');
  rect(356, 330, 128, 12, '#507b84');
  rect(365, 318, 110, 13, '#67929a');
  rect(379, 308, 82, 11, '#84aeb3');
  rect(391, 302, 58, 8, '#a3c9cb');
  window(377, 350); window(448, 350);
  rect(409, 356, 23, 35, '#87674f');
  rect(413, 360, 15, 27, '#a37e58');
  rect(424, 372, 3, 3, '#e6d197');
  rect(399, 392, 42, 5, '#e4d6b4');
  pixelText('☆', 420, 335, '#fff0bf', 17);
  rect(639, 382, 85, 16, '#4a685e33');
  rect(645, 344, 69, 49, '#e9c3ac');
  rect(643, 382, 74, 10, '#b9967d');
  rect(636, 337, 90, 10, '#975e70');
  rect(644, 327, 74, 11, '#b7808f');
  rect(654, 317, 54, 12, '#ce9bab');
  rect(665, 309, 31, 10, '#e3b6be');
  window(653, 354);
  rect(684, 359, 19, 33, '#82614f');
  rect(688, 363, 11, 25, '#b98970');
  pixelText('?', 681, 333, '#fff0d4', 16);

  // Welcome fountain, mission board, seating, and small garden details.
  rect(362, 228, 37, 9, '#787e7633');
  rect(361, 210, 38, 21, '#a1a4a1');
  rect(364, 212, 32, 14, '#78b9c2');
  rect(359, 207, 42, 5, '#c8c7b9');
  rect(375, 192, 10, 22, '#dbd4b9');
  rect(369, 190, 22, 5, '#f0e4c5');
  rect(374, 185, 12, 6, '#a4d1d2');
  rect(378, 178, 4, 7, '#d6eeee');
  rect(440, 241, 3, 22, '#8d6b4f');
  rect(476, 241, 3, 22, '#8d6b4f');
  rect(436, 225, 47, 25, '#936b4c');
  rect(439, 229, 41, 17, '#d7c7a0');
  rect(446, 232, 8, 11, '#fff0cf');
  rect(459, 233, 14, 2, '#a78d73');
  rect(459, 238, 11, 2, '#a78d73');
  rect(433, 221, 53, 5, '#54745c');
  bench(328, 294); bench(487, 294); bench(583, 165); bench(177, 174);
  for (const [x, y] of [[328, 198], [514, 199], [324, 303], [515, 303], [140, 118], [660, 179], [381, 437], [722, 423]]) lamp(x, y);
  // Grove planters, a crop patch, and quiet wildflower beds.
  for (const [x, y] of [[125, 95], [245, 95], [125, 177], [245, 177]]) {
    rect(x, y, 17, 10, '#a38c63');
    rect(x - 2, y, 21, 4, '#c7aa7b');
    blossom(x + 3, y - 3, '#e4c4ad');
    blossom(x + 10, y - 6, '#eee3a1');
  }
  rect(204, 338, 34, 42, '#937f58');
  for (let row = 0; row < 4; row++) for (let col = 0; col < 3; col++) {
    rect(208 + col * 10, 342 + row * 9, 6, 5, '#4e8756');
    rect(210 + col * 10, 341 + row * 9, 2, 3, '#a3bc64');
  }
  for (const [x, y] of [[552, 440], [586, 440], [544, 461], [578, 471], [729, 279], [743, 293]]) blossom(x, y, '#d9bac6');
  }
  for (let y = camera.y; y < Math.min(world.rows, camera.y + ROWS + 1); y++) for (let x = camera.x; x < Math.min(world.columns, camera.x + COLS + 1); x++) {
    if (tiles[y][x] === 'tree') tree((x + 0.5) * TILE, (y + 0.5) * TILE + 6, (x + y) % 4 === 0);
  }
  const drawObject = (object) => {
    if (object.x < camera.x - 2 || object.x > camera.x + COLS + 2 || object.y < camera.y - 2 || object.y > camera.y + ROWS + 2) return;
    const x = (object.x + 0.5) * TILE;
    const y = (object.y + 0.5) * TILE;
    switch (object.type) {
      case 'tree': tree(x, y + 7, true); break;
      case 'flowers':
        rect(x - 15, y - 10, 30, 28, '#6b966c');
        for (const [dx, dy] of [[-9, -4], [2, -8], [8, 3], [-5, 8]]) blossom(x + dx, y + dy, (dx + dy) % 2 ? '#e8c197' : '#e8b7c5');
        break;
      case 'bench': bench(x - 12, y); break;
      case 'lamp': lamp(x, y + 10); break;
      case 'farm':
        rect(x - 17, y - 17, 34, 34, '#967a53');
        for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
          rect(x - 13 + col * 10, y - 12 + row * 10, 6, 6, '#548858');
          rect(x - 11 + col * 10, y - 15 + row * 10, 2, 6, '#b3c67a');
        }
        break;
      case 'pond':
        rect(x - 17, y - 12, 34, 25, '#b1ba9b');
        rect(x - 14, y - 9, 28, 19, '#77b5bd');
        rect(x - 7, y - 4, 11, 2, '#c6ded5');
        rect(x + 5, y + 2, 6, 4, '#689461');
        break;
      case 'path':
        rect(x - 20, y - 20, 40, 40, '#d8c59e');
        rect(x - 17, y - 16, 34, 2, '#eee0be');
        rect(x - 17, y + 2, 34, 1, '#c1ac87');
        break;
      case 'fountain':
        rect(x - 15, y + 7, 32, 9, '#73858155');
        rect(x - 17, y - 1, 34, 13, '#adafa6');
        rect(x - 13, y + 1, 26, 7, '#8bc6cd');
        rect(x - 4, y - 17, 8, 20, '#e4d8bc');
        rect(x - 9, y - 19, 18, 4, '#efe3c8');
        rect(x - 2, y - 27, 4, 8, '#b7dddb');
        break;
      case 'cottage':
        rect(x - 22, y - 5, 44, 27, '#e4c6a3');
        rect(x - 26, y - 10, 52, 7, '#927785');
        rect(x - 20, y - 18, 40, 9, '#ae8f9e');
        rect(x - 12, y - 24, 24, 7, '#ccb0b9');
        rect(x + 4, y + 5, 11, 17, '#987457');
        window(x - 15, y + 1);
        break;
      case 'bed':
        rect(x - 18, y - 17, 36, 45, '#957457');
        rect(x - 16, y - 15, 32, 40, '#d8bdc8');
        rect(x - 14, y - 13, 28, 11, '#f4e5ce');
        rect(x - 16, y + 2, 32, 23, '#a9a8c2');
        rect(x - 16, y + 9, 32, 3, '#c7c0d4');
        break;
      case 'bookshelf':
        rect(x - 24, y - 22, 48, 39, '#a68864');
        rect(x - 21, y - 19, 42, 31, '#756249');
        for (let row = 0; row < 2; row++) for (let col = 0; col < 7; col++) rect(x - 19 + col * 6, y - 17 + row * 15, 4, 11, ['#99b5b0', '#c8a0ac', '#d6bd89'][col % 3]);
        rect(x - 24, y - 3, 48, 3, '#b49a78');
        break;
      case 'kitchen':
        rect(x - 28, y - 18, 56, 34, '#ae987a');
        rect(x - 30, y - 20, 60, 7, '#e1dac5');
        rect(x - 23, y - 11, 21, 22, '#cbb99b');
        rect(x + 2, y - 11, 21, 22, '#cbb99b');
        rect(x - 18, y - 3, 10, 2, '#8d7b60');
        rect(x + 6, y - 3, 10, 2, '#8d7b60');
        rect(x + 4, y - 19, 16, 4, '#8c9ea3');
        break;
      case 'table':
        rect(x - 13, y + 5, 4, 12, '#876c51');
        rect(x + 9, y + 5, 4, 12, '#876c51');
        rect(x - 17, y - 6, 34, 15, '#cbaa7d');
        rect(x - 14, y - 4, 28, 2, '#e2c9a1');
        break;
      case 'display':
        rect(x - 12, y - 23, 24, 33, '#998273');
        rect(x - 9, y - 20, 18, 25, '#e8dcc3');
        rect(x - 6, y - 15, 12, 8, '#83a8a2');
        rect(x - 6, y - 2, 12, 2, '#b5a78c');
        rect(x - 15, y + 10, 30, 5, '#c7b093');
        break;
      case 'cushion':
        rect(x - 13, y + 10, 28, 6, '#47645633');
        rect(x - 12, y + 4, 24, 10, '#9b849f');
        rect(x - 9, y + 1, 18, 11, '#c3a9c5');
        rect(x - 6, y + 4, 12, 2, '#e0c9d8');
        rect(x - 4, y + 7, 8, 3, '#b598ba');
        break;
    }
  };
  if (world.kind === 'interior' || world.id.startsWith('house:')) {
    for (const col of [3, 7, 12, 16]) window(col * TILE + 12, 10);
    const title = String(world.name).slice(0, 38);
    ctx.font = '600 11px ui-monospace, monospace';
    const titleWidth = Math.max(174, ctx.measureText(title).width + 24);
    rect(400 - titleWidth / 2 + 2, 44, titleWidth, 28, '#344e4533');
    rect(400 - titleWidth / 2, 42, titleWidth, 28, '#9a8170');
    rect(403 - titleWidth / 2, 45, titleWidth - 6, 22, '#e1d5bb');
    pixelText(title, 400, 57, '#52645d', 11);
    for (const [col, row] of [[2, 3], [17, 3], [2, 8], [17, 8]]) {
      rect(col * TILE + 10, row * TILE + 10, 18, 15, '#b28c73');
      blossom(col * TILE + 14, row * TILE + 4, '#e8c5b2');
      blossom(col * TILE + 20, row * TILE, '#dbb6c4');
    }
  }
  // Homes have a permanent cottage plus the inhabitant's own garden objects.
  if (world.id.startsWith('home:')) {
    rect(120, 127, 239, 111, '#e7d4b2');
    rect(120, 221, 239, 19, '#b59a79');
    rect(107, 119, 264, 13, '#926f7e');
    rect(121, 103, 237, 18, '#b28b9b');
    rect(141, 88, 196, 16, '#c29eac');
    rect(164, 76, 150, 13, '#d5b4be');
    for (const x of [147, 207, 317]) window(x, 166);
    rect(244, 174, 39, 66, '#85694f');
    rect(250, 181, 27, 51, '#ae865f');
    rect(271, 211, 4, 4, '#ecd2a4');
    rect(237, 240, 53, 7, '#e2cfad');
    rect(241, 247, 45, 3, '#baa488');
    rect(296, 100, 13, 25, '#b08b80');
    rect(293, 96, 19, 6, '#dbc2aa');
    for (const x of [142, 205, 315]) {
      rect(x - 2, 187, 26, 9, '#997554');
      rect(x - 4, 186, 30, 4, '#c89d70');
      blossom(x + 3, 181, '#e4b5bf'); blossom(x + 12, 182, '#f0d6a7');
    }
  }
  for (const object of world.objects || []) drawObject(object);
  for (const object of options.objects || []) drawObject(object);
  for (const gate of options.portals || world.portals || []) {
    if (gate.x < camera.x || gate.x >= camera.x + COLS || gate.y < camera.y || gate.y >= camera.y + ROWS) continue;
    const x = (gate.x + 0.5) * TILE;
    const y = (gate.y + 0.5) * TILE;
    rect(x - 14, y - 12, 28, 25, '#d4c9ec66');
    rect(x - 14, y + 12, 28, 3, '#a396ca');
    rect(x - 14, y - 12, 3, 25, '#c6bde6');
    rect(x + 11, y - 12, 3, 25, '#c6bde6');
    pixelText('↟', x, y, '#64577c', 19);
    if (world.id !== 'commons' && world.id !== 'legacy' && !(world.landmarks || []).some((place) => place.x === gate.x && place.y === gate.y)) {
      const text = gate.name || 'Portal';
      ctx.font = '600 9px ui-monospace, monospace';
      const width = ctx.measureText(text).width + 12;
      const labelX = Math.max(camera.x * TILE + width / 2 + 4, Math.min((camera.x + COLS) * TILE - width / 2 - 4, x));
      rect(labelX - width / 2, y + 20, width, 16, '#eee3cded');
      pixelText(text, labelX, y + 28, '#374f50', 9);
    }
  }

  // Corner boundaries frame the world without adding invisible collision.
  rect(0, 0, world.columns * TILE, 3, '#648369');
  rect(0, world.rows * TILE - 3, world.columns * TILE, 3, '#648369');

  const visible = visitors.filter((avatar) => avatar.x >= camera.x - 1 && avatar.x < camera.x + COLS + 1 && avatar.y >= camera.y - 1 && avatar.y < camera.y + ROWS + 1);
  const crowd = new Map();
  const avatars = [];
  for (const avatar of visible) {
    const key = `${avatar.x},${avatar.y}`;
    const count = crowd.get(key) || 0;
    crowd.set(key, count + 1);
    if (count < 3) avatars.push(avatar);
  }
  if ((self?.id || self?.name) && position) avatars.push({ ...self, x: position.x, y: position.y, isSelf: true });
  avatars.sort((a, b) => a.y - b.y || a.x - b.x);
  const labelBoxes = [];
  const avatarBoxes = avatars.flatMap((avatar) => {
    const x = (avatar.x + 0.5) * TILE; const y = (avatar.y + 0.5) * TILE;
    ctx.font = '600 9px ui-monospace, monospace';
    const width = ctx.measureText(String(avatar.name || 'Agent').slice(0, 18)).width + 12;
    return [{ x: x - width / 2, y: y - 40, width, height: 18 }, { x: x - 15, y: y - 21, width: 30, height: 39 }];
  });
  const overlaps = (a, b) => a.x < b.x + b.width + 3 && a.x + a.width + 3 > b.x && a.y < b.y + b.height + 3 && a.y + a.height + 3 > b.y;
  const landmarkLabel = (text, x, y, preferredY) => {
    ctx.font = '600 10px ui-monospace, monospace';
    const width = ctx.measureText(text).width + 14;
    const candidates = [[x, preferredY], [x, y - 47], [x, y + 31], [x - width / 2 - 22, y], [x + width / 2 + 22, y], [x, y + 51]];
    for (const [candidateX, candidateY] of candidates) {
      const labelX = Math.max(camera.x * TILE + width / 2 + 4, Math.min((camera.x + COLS) * TILE - width / 2 - 4, candidateX));
      const labelY = Math.max(camera.y * TILE + 12, Math.min((camera.y + ROWS) * TILE - 12, candidateY));
      const box = { x: labelX - width / 2, y: labelY - 9, width, height: 18 };
      if (avatarBoxes.some((other) => overlaps(box, other)) || labelBoxes.some((other) => overlaps(box, other))) continue;
      labelBoxes.push(box);
      rect(box.x + 1, box.y + 2, width, 18, '#203d3633');
      rect(box.x, box.y, width, 18, '#294b43ed');
      rect(box.x, box.y, 2, 18, '#d6c69a');
      pixelText(text, labelX, labelY + 1, '#f7ecd1');
      return;
    }
    // Busy locations remain available in the accompanying accessible place list.
  };

  for (const place of world.landmarks || []) {
    if (place.x < camera.x - 2 || place.x > camera.x + COLS + 2 || place.y < camera.y - 2 || place.y > camera.y + ROWS + 2) continue;
    const x = (place.x + 0.5) * TILE;
    const y = (place.y + 0.5) * TILE;
    const active = position?.x === place.x && position?.y === place.y && Boolean(self?.name || self?.id);
    rect(x - 14, y - 12, 28, 27, active ? '#fff0c377' : '#ffffff24');
    if (active) {
      rect(x - 14, y + 14, 28, 2, '#fff3c5');
      rect(x - 14, y - 12, 28, 2, '#fff3c5');
    }
    const indoorTitle = world.kind === 'interior' || world.id.startsWith('house:');
    if (!indoorTitle) {
      const labelY = place.name === 'Welcome Plaza' ? y + 42 : place.name === 'Mission Board' || (world.id.startsWith('home:') && place.name === 'Garden Cottage') ? y - 47 : y + 28;
      landmarkLabel(place.name, x, y, labelY);
    }
  }

  const occupancy = new Map();
  const nameBoxes = [];
  if ((self?.name || self?.id) && position) {
    ctx.font = '600 9px ui-monospace, monospace';
    const width = ctx.measureText(String(self.name || 'Agent').slice(0, 18)).width + 8;
    const x = Math.min((camera.x + COLS) * TILE - width / 2 - 3, Math.max(camera.x * TILE + width / 2 + 3, (position.x + 0.5) * TILE));
    const y = Math.max(camera.y * TILE + 9, (position.y + 0.5) * TILE - 30);
    nameBoxes.push({ x: x - width / 2, y: y - 7, width, height: 14, reservedSelf: true });
  }
  for (const avatar of avatars) {
    if (!Number.isFinite(avatar.x) || !Number.isFinite(avatar.y)) continue;
    const cell = `${avatar.x},${avatar.y}`;
    const stack = occupancy.get(cell) || 0;
    occupancy.set(cell, stack + 1);
    const offset = stack ? (stack % 2 ? 1 : -1) * Math.min(12, Math.ceil(stack / 2) * 6) : 0;
    const x = (avatar.x + 0.5) * TILE + offset;
    const resting = /sit|rest|meditat/.test(avatar.activity || avatar.posture || '');
    const y = (avatar.y + 0.5) * TILE + (resting ? 5 : 0);
    const color = /^#[0-9a-f]{6}$/i.test(avatar.color || '') ? avatar.color : '#3d5875';
    ctx.globalAlpha = ['offline', 'paused', 'suspended'].includes(avatar.status) ? 0.58 : 1;
    rect(x - 11, y + 12, 23, 5, '#32544f44');
    if (avatar.isSelf) {
      rect(x - 13, y + 12, 27, 2, '#ffefb6');
      rect(x - 13, y + 14, 3, 3, '#ffefb6');
      rect(x + 11, y + 14, 3, 3, '#ffefb6');
    }
    // Friendly agent sprite, customizable clothes and chest emblem.
    rect(x - 8, y - 2, 16, 14, color);
    rect(x - 11, y, 3, 10, color);
    rect(x + 8, y, 3, 10, color);
    rect(x - (resting ? 10 : 7), y + 12, resting ? 8 : 5, 4, '#3d4857');
    rect(x + 2, y + 12, resting ? 8 : 5, 4, '#3d4857');
    rect(x - 8, y - 17, 16, 14, '#ecd1a6');
    rect(x - 9, y - 20, 18, 6, '#404e56');
    rect(x - 9, y - 16, 3, 5, '#404e56');
    rect(x + 6, y - 16, 3, 5, '#404e56');
    rect(x - 5, y - 12, 2, 2, '#374952');
    rect(x + 3, y - 12, 2, 2, '#374952');
    rect(x - 2, y - 7, 4, 1, '#ba8d72');
    pixelText(avatar.symbol || '✦', x, y + 5, '#fff0d4', 9);
    if (avatar.status === 'active' || avatar.status === 'online') rect(x + 9, y - 21, 4, 4, '#a6dda3');
    const name = String(avatar.name || 'Agent').slice(0, 18);
    ctx.font = '600 9px ui-monospace, monospace';
    const width = ctx.measureText(name).width + 8;
    const labelX = Math.min((camera.x + COLS) * TILE - width / 2 - 3, Math.max(camera.x * TILE + width / 2 + 3, x));
    const defaultLabelY = Math.max(camera.y * TILE + 9, y - 30 - (avatar.isSelf ? 0 : stack * 12));
    let nameBox;
    for (const candidateY of [defaultLabelY, defaultLabelY - 16, defaultLabelY - 32, y + 29]) {
      const labelY = Math.max(camera.y * TILE + 9, Math.min((camera.y + ROWS) * TILE - 9, candidateY));
      const box = { x: labelX - width / 2, y: labelY - 7, width, height: 14 };
      if (nameBoxes.some((other) => !(avatar.isSelf && other.reservedSelf) && overlaps(box, other)) || labelBoxes.some((other) => overlaps(box, other))) continue;
      nameBox = box; nameBoxes.push(box); break;
    }
    if (nameBox) {
      rect(nameBox.x, nameBox.y, width, 14, avatar.isSelf ? '#354f67ed' : '#28493feb');
      pixelText(name, labelX, nameBox.y + 7, '#fff4d8', 9);
    }
    ctx.globalAlpha = 1;
  }
  for (const [key, count] of crowd) {
    if (count <= 3) continue;
    const [col, row] = key.split(',').map(Number);
    const x = (col + 0.5) * TILE; const y = (row + 0.5) * TILE + 24;
    const label = `+${count - 3}`;
    ctx.font = '600 9px ui-monospace, monospace';
    const width = ctx.measureText(label).width + 8;
    rect(x - width / 2, y - 7, width, 14, '#28493fe8');
    pixelText(label, x, y, '#fff2cf', 9);
  }
  ctx.restore();
}

const miniMapCache = new WeakMap();

/** A terrain overview; the outline is the viewport and the cream dot is the character. */
export function drawMiniMap(canvas, world = 'commons', options = {}) {
  const definition = getWorldDefinition(world);
  const ctx = canvas.getContext('2d');
  if (!ctx || !canvas.width || !canvas.height) return;
  const scale = Math.min(canvas.width / definition.columns, canvas.height / definition.rows);
  const offsetX = (canvas.width - definition.columns * scale) / 2;
  const offsetY = (canvas.height - definition.rows * scale) / 2;
  const palette = { meadow: '#98b886', garden: '#b8bf83', tree: '#527857', water: '#729fab', path: '#dbbd8c', plaza: '#e5ca9e', bridge: '#b58a62', building: '#a28586', fountain: '#adc9c9', floor: '#d7c3a3', rug: '#a79ba8', wall: '#747c88' };
  const background = (target) => {
    target.fillStyle = '#273e35';
    target.fillRect(0, 0, canvas.width, canvas.height);
    for (let y = 0; y < definition.rows; y++) for (let x = 0; x < definition.columns; x++) {
      target.fillStyle = palette[definition.terrain[y][x]] || palette.meadow;
      const left = Math.round(offsetX + x * scale); const top = Math.round(offsetY + y * scale);
      target.fillRect(left, top, Math.ceil(scale), Math.ceil(scale));
    }
  };
  let cached = miniMapCache.get(canvas);
  if (!cached || cached.terrain !== definition.terrain || cached.width !== canvas.width || cached.height !== canvas.height) {
    const layer = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(canvas.width, canvas.height) : canvas.ownerDocument?.createElement('canvas');
    if (layer) {
      layer.width = canvas.width; layer.height = canvas.height;
      background(layer.getContext('2d'));
      cached = { terrain: definition.terrain, width: canvas.width, height: canvas.height, layer };
      miniMapCache.set(canvas, cached);
    } else cached = null;
  }
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  if (cached) ctx.drawImage(cached.layer, 0, 0);
  else background(ctx);
  const marker = (x, y, color, size) => {
    ctx.fillStyle = '#2c403a';
    ctx.fillRect(offsetX + (x + 0.5) * scale - size / 2 - 1, offsetY + (y + 0.5) * scale - size / 2 - 1, size + 2, size + 2);
    ctx.fillStyle = color;
    ctx.fillRect(offsetX + (x + 0.5) * scale - size / 2, offsetY + (y + 0.5) * scale - size / 2, size, size);
  };
  for (const object of options.objects || []) marker(object.x, object.y, palette[object.type] || '#b69376', Math.max(2, scale * 0.65));
  for (const place of definition.landmarks || []) marker(place.x, place.y, '#eee4c0', Math.max(3, scale));
  for (const gate of options.portals || definition.portals || []) marker(gate.x, gate.y, '#d3b6d2', Math.max(3, scale));
  if (options.camera) {
    const camera = options.camera;
    const x = offsetX + camera.x * scale; const y = offsetY + camera.y * scale;
    const width = Math.min(COLS, definition.columns - camera.x) * scale;
    const height = Math.min(ROWS, definition.rows - camera.y) * scale;
    ctx.lineWidth = 3; ctx.strokeStyle = '#314439'; ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
    ctx.lineWidth = 1; ctx.strokeStyle = '#fff0b4'; ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
  }
  if (Number.isFinite(options.position?.x) && Number.isFinite(options.position?.y)) marker(options.position.x, options.position.y, '#fff7d3', Math.max(5, scale * 0.7));
  ctx.restore();
}
