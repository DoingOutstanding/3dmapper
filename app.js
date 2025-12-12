const AREA_FILTER = null;
const DIR_OFFSETS = {
  n: [0, 1, 0], s: [0, -1, 0], e: [1, 0, 0], w: [-1, 0, 0],
  ne: [1, 1, 0], nw: [-1, 1, 0], se: [1, -1, 0], sw: [-1, -1, 0],
  u: [0, 0, 1], d: [0, 0, -1]
};
const DIR_LABELS = {
  n: 'North',
  s: 'South',
  e: 'East',
  w: 'West',
  ne: 'Northeast',
  nw: 'Northwest',
  se: 'Southeast',
  sw: 'Southwest',
  u: 'Up',
  d: 'Down'
};
const SCALE = 6;
const AREA_GRID_SPACING = 40;

const areaOffsets = new Map();
const roomPositionsByArea = new Map();
const areaGroups = new Map();

let draggedAreaId = null;
let dragPlane = null;
let dragOffset = null;

const errorBanner = document.getElementById('error');
const sceneHost = document.getElementById('scene');
const saveButton = document.getElementById('saveLayout');
const progressBar = document.getElementById('progressBar');
const progressLabel = document.getElementById('progressLabel');

function setProgress(percent, label) {
  const clamped = Math.max(0, Math.min(1, percent));
  progressBar.style.width = `${Math.round(clamped * 100)}%`;
  progressLabel.textContent = label;
}

function showError(message) {
  errorBanner.textContent = message;
  errorBanner.style.display = 'block';
}

async function loadJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Failed to load ${path}: ${response.status}`);
  return response.json();
}

async function loadOptionalJson(path) {
  try {
    const response = await fetch(path);
    if (!response.ok) return null;
    return response.json();
  } catch (error) {
    console.warn(`Optional load failed for ${path}:`, error);
    return null;
  }
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

function formatExitLabel(exit) {
  const dir = normalizeDir(exit.dir);
  if (DIR_LABELS[dir]) return DIR_LABELS[dir];
  if (exit.command) return exit.command;
  if (exit.dir) return exit.dir;
  return 'Exit';
}

function groupRoomsByArea(rooms) {
  const map = new Map();
  rooms.forEach(room => {
    const list = map.get(room.area) || [];
    list.push(room);
    map.set(room.area, list);
  });
  return map;
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

function computeRoomPositionsByArea(rooms, exits) {
  const byArea = groupRoomsByArea(rooms);
  const result = new Map();

  byArea.forEach((areaRooms, areaId) => {
    const areaRoomIds = new Set(areaRooms.map(r => r.uid));
    const areaExits = exits.filter(exit => areaRoomIds.has(exit.fromuid) && areaRoomIds.has(exit.touid));
    result.set(areaId, propagatePositions(areaRooms, areaExits));
  });

  return result;
}

function centerCamera(camera, controls, bounds) {
  camera.up.set(0, 0, 1);
  const center = new THREE.Vector3(
    (bounds.min.x + bounds.max.x) / 2,
    (bounds.min.y + bounds.max.y) / 2,
    (bounds.min.z + bounds.max.z) / 2
  );
  controls.target.copy(center);
  const span = Math.max(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, 200);
  camera.position.set(center.x, center.y, bounds.max.z + span * 0.6);
  controls.screenSpacePanning = true;
  controls.enableRotate = false;
  camera.lookAt(center);
}

function calculateAreaBounds(areaId, areaRooms) {
  const areaPositions = roomPositionsByArea.get(areaId) || new Map();
  const bounds = { min: new THREE.Vector3(Infinity, Infinity, Infinity), max: new THREE.Vector3(-Infinity, -Infinity, -Infinity) };

  areaRooms.forEach(room => {
    const pos = areaPositions.get(room.uid) || [0, 0, 0];
    bounds.min.min(new THREE.Vector3(...pos));
    bounds.max.max(new THREE.Vector3(...pos));
  });

  if (!isFinite(bounds.min.x)) {
    bounds.min.set(-1, -1, -1);
    bounds.max.set(1, 1, 1);
  }

  return bounds;
}

function computeDefaultAreaOffsets(areas, rooms) {
  const byArea = groupRoomsByArea(rooms);
  const layout = new Map();
  const gridWidth = Math.ceil(Math.sqrt(areas.length));
  let cursorX = 0;
  let cursorY = 0;

  areas.forEach((area, index) => {
    const areaRooms = byArea.get(area.uid) || [];
    const bounds = calculateAreaBounds(area.uid, areaRooms);
    const width = (bounds.max.x - bounds.min.x) + AREA_GRID_SPACING;
    const height = (bounds.max.y - bounds.min.y) + AREA_GRID_SPACING;

    layout.set(area.uid, new THREE.Vector3(cursorX * AREA_GRID_SPACING, cursorY * AREA_GRID_SPACING, 0));

    cursorX += Math.max(1, Math.ceil(width / AREA_GRID_SPACING));
    if (cursorX >= gridWidth) {
      cursorX = 0;
      cursorY += Math.max(1, Math.ceil(height / AREA_GRID_SPACING));
    }
  });

  return layout;
}

function applySavedOffsets(savedOffsets, defaultOffsets) {
  const merged = new Map(defaultOffsets);
  if (savedOffsets) {
    Object.entries(savedOffsets).forEach(([areaId, value]) => {
      merged.set(areaId, new THREE.Vector3(value.x, value.y, value.z));
    });
  }
  return merged;
}

function saveMegaCoordinates(areas) {
  const payload = {};
  areas.forEach(area => {
    const vector = areaOffsets.get(area.uid) || new THREE.Vector3();
    payload[area.uid] = { x: vector.x, y: vector.y, z: vector.z };
  });

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'mega-coordinates.json';
  link.click();
  URL.revokeObjectURL(url);
}

function makeAreaLabel(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#e6edf3';
  ctx.font = 'bold 64px Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(40, 10, 1);
  return sprite;
}

function buildScene(rooms, areaColors, areas, areaConnections = []) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#0b1220');

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 50000);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  sceneHost.innerHTML = '';
  sceneHost.appendChild(renderer.domElement);

  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enableRotate = false;

  const ambient = new THREE.AmbientLight('#ffffff', 0.6);
  scene.add(ambient);
  const directional = new THREE.DirectionalLight('#ffffff', 0.7);
  directional.position.set(30, 40, 50);
  scene.add(directional);

  const gridHelper = new THREE.GridHelper(8000, 160, '#334155', '#1e293b');
  gridHelper.rotation.x = Math.PI / 2;
  scene.add(gridHelper);
  const axesHelper = new THREE.AxesHelper(20);
  axesHelper.position.set(-10, -10, 0);
  scene.add(axesHelper);

  const bounds = { min: new THREE.Vector3(Infinity, Infinity, Infinity), max: new THREE.Vector3(-Infinity, -Infinity, -Infinity) };
  const byArea = groupRoomsByArea(rooms);
  const dragHandles = [];
  const areaVisuals = new Map();
  let builtAreaCount = 0;

  byArea.forEach((areaRooms, areaId) => {
    const group = new THREE.Group();
    areaGroups.set(areaId, group);
    const offset = areaOffsets.get(areaId) || new THREE.Vector3();
    group.position.set(offset.x * SCALE, offset.y * SCALE, offset.z * SCALE);

    const positions = roomPositionsByArea.get(areaId) || new Map();
    const color = areaColors.get(areaId) || '#ffffff';
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    areaRooms.forEach(room => {
      const pos = positions.get(room.uid) || [0, 0, 0];
      min.min(new THREE.Vector3(...pos));
      max.max(new THREE.Vector3(...pos));
    });

    if (!isFinite(min.x)) {
      min.set(-2, -2, -0.5);
      max.set(2, 2, 0.5);
    }

    const sizeX = (max.x - min.x) * SCALE + SCALE * 4;
    const sizeY = (max.y - min.y) * SCALE + SCALE * 4;
    const squareSize = Math.max(sizeX, sizeY, SCALE * 10);
    const height = SCALE * 4;

    const center = new THREE.Vector3(
      ((min.x + max.x) / 2) * SCALE,
      ((min.y + max.y) / 2) * SCALE,
      ((min.z + max.z) / 2) * SCALE
    );

    const material = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.05, transparent: false });
    const boxGeom = new THREE.BoxGeometry(squareSize, squareSize, height);
    const areaMesh = new THREE.Mesh(boxGeom, material);
    areaMesh.position.copy(center);
    areaMesh.userData.areaId = areaId;
    areaMesh.name = `area-${areaId}`;
    group.add(areaMesh);
    dragHandles.push(areaMesh);

    const areaMeta = areas.find(a => a.uid === areaId);
    const label = makeAreaLabel(areaMeta?.name || areaRooms[0]?.area_name || areaRooms[0]?.name || 'Area');
    label.position.set(center.x, center.y, center.z + height / 2 + 6);
    group.add(label);

    areaVisuals.set(areaId, { group, center, height });

    const halfSize = new THREE.Vector3(squareSize / 2, squareSize / 2, height / 2);
    const worldCenter = center.clone().add(group.position);
    bounds.min.min(worldCenter.clone().sub(halfSize));
    bounds.max.max(worldCenter.clone().add(halfSize));

    scene.add(group);
    builtAreaCount += 1;
  });

  if (!isFinite(bounds.min.x)) {
    bounds.min.set(-SCALE * 10, -SCALE * 10, -SCALE * 2);
    bounds.max.set(SCALE * 10, SCALE * 10, SCALE * 2);
  }

  centerCamera(camera, controls, bounds);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  function updatePointer(event) {
    pointer.x = (event.clientX / renderer.domElement.clientWidth) * 2 - 1;
    pointer.y = -(event.clientY / renderer.domElement.clientHeight) * 2 + 1;
  }

  function onPointerDown(event) {
    updatePointer(event);
    raycaster.setFromCamera(pointer, camera);
    const intersects = raycaster.intersectObjects(dragHandles, false);
    if (intersects.length === 0) return;
    const hit = intersects[0];
    draggedAreaId = hit.object.userData.areaId;
    const normal = camera.getWorldDirection(new THREE.Vector3()).negate();
    dragPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, hit.point);
    const areaGroup = areaGroups.get(draggedAreaId);
    dragOffset = hit.point.clone().sub(areaGroup.position);
    controls.enabled = false;
  }

  function onPointerMove(event) {
    if (!draggedAreaId || !dragPlane) return;
    updatePointer(event);
    raycaster.setFromCamera(pointer, camera);
    const target = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(dragPlane, target)) {
      const areaGroup = areaGroups.get(draggedAreaId);
      const nextPosition = target.clone().sub(dragOffset);
      areaGroup.position.copy(nextPosition);
      const offset = nextPosition.clone().divideScalar(SCALE);
      areaOffsets.set(draggedAreaId, offset);
    }
  }

  function onPointerUp() {
    draggedAreaId = null;
    dragPlane = null;
    dragOffset = null;
    controls.enabled = true;
  }

  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerup', onPointerUp);

  const connectionVisuals = [];

  function areaAnchor(areaId) {
    const visual = areaVisuals.get(areaId);
    if (!visual) return null;
    const worldCenter = visual.center.clone().add(visual.group.position);
    worldCenter.z = worldCenter.z + visual.height / 2 + 2;
    return worldCenter;
  }

  const labelMaterialOptions = { depthTest: false, depthWrite: false };

  function makeLineLabel(text) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 32px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    const material = new THREE.SpriteMaterial({ map: texture, ...labelMaterialOptions });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(24, 8, 1);
    return sprite;
  }

  areaConnections.forEach(connection => {
    const start = areaAnchor(connection.fromArea);
    const end = areaAnchor(connection.toArea);
    if (!start || !end) return;

    const positions = new Float32Array(6);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({ color: '#facc15', linewidth: 2 });
    const line = new THREE.Line(geometry, material);
    scene.add(line);

    const label = makeLineLabel(connection.label);
    scene.add(label);

    connectionVisuals.push({ connection, line, label });
  });

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  function updatePointer(event) {
    pointer.x = (event.clientX / renderer.domElement.clientWidth) * 2 - 1;
    pointer.y = -(event.clientY / renderer.domElement.clientHeight) * 2 + 1;
  }

  function onPointerDown(event) {
    updatePointer(event);
    raycaster.setFromCamera(pointer, camera);
    const intersects = raycaster.intersectObjects(dragHandles, false);
    if (intersects.length === 0) return;
    const hit = intersects[0];
    draggedAreaId = hit.object.userData.areaId;
    const normal = camera.getWorldDirection(new THREE.Vector3()).negate();
    dragPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, hit.point);
    const areaGroup = areaGroups.get(draggedAreaId);
    dragOffset = hit.point.clone().sub(areaGroup.position);
    controls.enabled = false;
  }

  function onPointerMove(event) {
    if (!draggedAreaId || !dragPlane) return;
    updatePointer(event);
    raycaster.setFromCamera(pointer, camera);
    const target = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(dragPlane, target)) {
      const areaGroup = areaGroups.get(draggedAreaId);
      const nextPosition = target.clone().sub(dragOffset);
      areaGroup.position.copy(nextPosition);
      const offset = nextPosition.clone().divideScalar(SCALE);
      areaOffsets.set(draggedAreaId, offset);
    }
  }

  function onPointerUp() {
    draggedAreaId = null;
    dragPlane = null;
    dragOffset = null;
    controls.enabled = true;
  }

  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerup', onPointerUp);

  function animate() {
    requestAnimationFrame(animate);
    connectionVisuals.forEach(item => {
      const start = areaAnchor(item.connection.fromArea);
      const end = areaAnchor(item.connection.toArea);
      if (!start || !end) return;
      const positionAttr = item.line.geometry.getAttribute('position');
      positionAttr.setXYZ(0, start.x, start.y, start.z);
      positionAttr.setXYZ(1, end.x, end.y, end.z);
      positionAttr.needsUpdate = true;

      const mid = start.clone().add(end).multiplyScalar(0.5);
      item.label.position.copy(mid.add(new THREE.Vector3(0, 0, 2)));
    });
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  if (builtAreaCount === 0) {
    showError('No areas could be rendered. Please verify Database/areas.json and Database/rooms.json contain matching area IDs.');
  }

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

async function bootstrap() {
  try {
    setProgress(0.05, 'Loading areas...');
    const areas = await loadJson('Database/areas.json');
    setProgress(0.2, 'Loading rooms...');
    const rooms = await loadJson('Database/rooms.json');
    setProgress(0.35, 'Loading exits...');
    const exits = await loadJson('Database/exits.json');
    setProgress(0.45, 'Loading saved layout...');
    const savedOffsets = await loadOptionalJson('Database/mega-coordinates.json');

    const selectedAreas = AREA_FILTER ? areas.filter(a => AREA_FILTER.has(a.uid)) : areas;
    const areaColors = pickColors(selectedAreas);

    const areaRoomSet = new Set(selectedAreas.map(a => a.uid));
    const filteredRooms = rooms.filter(r => areaRoomSet.has(r.area));
    const roomById = new Map(filteredRooms.map(r => [r.uid, r]));
    const filteredExits = exits.filter(exit => roomById.has(exit.fromuid) && roomById.has(exit.touid));

    const connectionSet = new Set();
    const areaConnections = [];
    filteredExits.forEach(exit => {
      const fromRoom = roomById.get(exit.fromuid);
      const toRoom = roomById.get(exit.touid);
      if (!fromRoom || !toRoom) return;
      if (fromRoom.area === toRoom.area) return;
      const key = `${fromRoom.area}->${toRoom.area}->${normalizeDir(exit.dir)}-${exit.command || ''}`;
      if (connectionSet.has(key)) return;
      connectionSet.add(key);
      areaConnections.push({ fromArea: fromRoom.area, toArea: toRoom.area, label: formatExitLabel(exit) });
    });

    setProgress(0.55, 'Computing room layout...');

    const computedPositions = computeRoomPositionsByArea(filteredRooms, filteredExits);
    roomPositionsByArea.clear();
    computedPositions.forEach((value, key) => roomPositionsByArea.set(key, value));

    const defaults = computeDefaultAreaOffsets(selectedAreas, filteredRooms);
    const mergedOffsets = applySavedOffsets(savedOffsets, defaults);
    areaOffsets.clear();
    mergedOffsets.forEach((value, key) => areaOffsets.set(key, value));

    setProgress(0.7, 'Building scene...');

    areaGroups.clear();

    buildScene(filteredRooms, areaColors, selectedAreas, areaConnections);

    setProgress(1, 'Ready');

    saveButton.addEventListener('click', () => saveMegaCoordinates(selectedAreas));
  } catch (error) {
    console.error(error);
    showError(error.message);
  }
}

bootstrap();
