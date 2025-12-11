const AREA_FILTER = new Set(['aylor', 'academy']);
const DIR_OFFSETS = {
  n: [0, 1, 0], s: [0, -1, 0], e: [1, 0, 0], w: [-1, 0, 0],
  ne: [1, 1, 0], nw: [-1, 1, 0], se: [1, -1, 0], sw: [-1, -1, 0],
  u: [0, 0, 1], d: [0, 0, -1]
};
const SCALE = 6;

const errorBanner = document.getElementById('error');
const legend = document.getElementById('legend');
const sceneHost = document.getElementById('scene');

function showError(message) {
  errorBanner.textContent = message;
  errorBanner.style.display = 'block';
}

async function loadJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Failed to load ${path}: ${response.status}`);
  return response.json();
}

function pickColors(areas) {
  const palette = ['#4cc3ff', '#f472b6', '#a3e635', '#f97316', '#c084fc', '#38bdf8'];
  const colorMap = new Map();
  areas.forEach((area, i) => {
    colorMap.set(area.uid, palette[i % palette.length]);
  });
  return colorMap;
}

function mergeKnownPositions(rooms) {
  const positions = new Map();
  rooms.forEach(room => {
    if (room.x !== null && room.y !== null && room.z !== null) {
      positions.set(room.uid, [room.x, room.y, room.z]);
    }
  });
  return positions;
}

function normalizeDir(dir) {
  return (dir || '').toLowerCase();
}

function propagatePositions(rooms, exits) {
  const positions = mergeKnownPositions(rooms);
  const queue = [...positions.keys()];

  while (queue.length) {
    const fromId = queue.shift();
    const fromPos = positions.get(fromId);
    if (!fromPos) continue;

    exits.forEach(exit => {
      if (exit.fromuid !== fromId) return;
      const targetId = exit.touid;
      const dir = normalizeDir(exit.dir);
      const delta = DIR_OFFSETS[dir];
      if (!delta) return;
      const candidate = [fromPos[0] + delta[0], fromPos[1] + delta[1], fromPos[2] + delta[2]];

      const known = positions.get(targetId);
      if (!known) {
        positions.set(targetId, candidate);
        queue.push(targetId);
      } else if (!known.every((v, i) => v === candidate[i])) {
        console.warn(`Position mismatch for ${targetId}:`, known, candidate);
      }
    });
  }

  // Assign remaining rooms to the origin cluster to keep them visible.
  rooms.forEach(room => {
    if (!positions.has(room.uid)) {
      positions.set(room.uid, [0, 0, 0]);
    }
  });

  return positions;
}

function buildLegend(areaColors, areas) {
  legend.innerHTML = '';
  areas.forEach(area => {
    const entry = document.createElement('div');
    entry.className = 'legend-entry';
    const swatch = document.createElement('div');
    swatch.className = 'legend-swatch';
    swatch.style.background = areaColors.get(area.uid);
    const label = document.createElement('span');
    label.textContent = area.name;
    entry.appendChild(swatch);
    entry.appendChild(label);
    legend.appendChild(entry);
  });
}

function createLabel(text, color) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const fontSize = 64;
  ctx.font = `${fontSize}px Arial`;
  const textMetrics = ctx.measureText(text);
  canvas.width = textMetrics.width + 32;
  canvas.height = fontSize + 24;
  ctx.font = `${fontSize}px Arial`;
  ctx.fillStyle = 'rgba(13,17,23,0.65)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = color;
  ctx.fillText(text, 16, fontSize);
  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(canvas.width / 32, canvas.height / 32, 1);
  return sprite;
}

function centerCamera(camera, controls, bounds) {
  const center = new THREE.Vector3(
    (bounds.min.x + bounds.max.x) / 2,
    (bounds.min.y + bounds.max.y) / 2,
    (bounds.min.z + bounds.max.z) / 2
  );
  controls.target.copy(center);
  const span = Math.max(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, 40);
  camera.position.set(center.x + span, center.y + span, center.z + span);
}

function buildScene(rooms, exits, positions, areaColors, areas) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#0b1220');

  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 5000);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  sceneHost.innerHTML = '';
  sceneHost.appendChild(renderer.domElement);

  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  const ambient = new THREE.AmbientLight('#ffffff', 0.6);
  scene.add(ambient);
  const directional = new THREE.DirectionalLight('#ffffff', 0.7);
  directional.position.set(30, 40, 50);
  scene.add(directional);

  const roomGeometry = new THREE.BoxGeometry(1.6, 1.6, 1.6);
  const bounds = { min: new THREE.Vector3(Infinity, Infinity, Infinity), max: new THREE.Vector3(-Infinity, -Infinity, -Infinity) };

  rooms.forEach(room => {
    const position = positions.get(room.uid);
    const [x, y, z] = position.map(v => v * SCALE);
    const color = areaColors.get(room.area);
    const material = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.1 });
    const cube = new THREE.Mesh(roomGeometry, material);
    cube.position.set(x, y, z);
    cube.userData = room;
    scene.add(cube);

    const label = createLabel(room.name, color);
    label.position.set(x, y + 1.8, z);
    scene.add(label);

    bounds.min.min(cube.position);
    bounds.max.max(cube.position);
  });

  const exitMaterial = new THREE.LineBasicMaterial({ color: '#94a3b8', transparent: true, opacity: 0.5 });
  exits.forEach(exit => {
    const start = positions.get(exit.fromuid);
    const end = positions.get(exit.touid);
    if (!start || !end) return;
    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(...start.map(v => v * SCALE)),
      new THREE.Vector3(...end.map(v => v * SCALE)),
    ]);
    const line = new THREE.Line(geometry, exitMaterial);
    scene.add(line);
  });

  centerCamera(camera, controls, bounds);

  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

async function bootstrap() {
  try {
    const [areas, rooms, exits] = await Promise.all([
      loadJson('Database/areas.json'),
      loadJson('Database/rooms.json'),
      loadJson('Database/exits.json'),
    ]);

    const selectedAreas = areas.filter(a => AREA_FILTER.has(a.uid));
    const areaColors = pickColors(selectedAreas);
    buildLegend(areaColors, selectedAreas);

    const areaRoomSet = new Set(selectedAreas.map(a => a.uid));
    const filteredRooms = rooms.filter(r => areaRoomSet.has(r.area));
    const roomById = new Map(filteredRooms.map(r => [r.uid, r]));
    const filteredExits = exits.filter(exit => {
      const fromRoom = roomById.get(exit.fromuid);
      const toRoom = roomById.get(exit.touid);
      return Boolean(fromRoom && toRoom);
    });

    const positions = propagatePositions(filteredRooms, filteredExits);
    buildScene(filteredRooms, filteredExits, positions, areaColors, selectedAreas);
  } catch (error) {
    console.error(error);
    showError(error.message);
  }
}

bootstrap();
