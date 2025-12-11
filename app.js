const AREA_FILTER = null;
const DIR_OFFSETS = {
  n: [0, 1, 0], s: [0, -1, 0], e: [1, 0, 0], w: [-1, 0, 0],
  ne: [1, 1, 0], nw: [-1, 1, 0], se: [1, -1, 0], sw: [-1, -1, 0],
  u: [0, 0, 1], d: [0, 0, -1]
};
const SCALE = 6;
const AREA_GRID_SPACING = 40;

const areaOffsets = new Map();
const roomPositionsByArea = new Map();
const areaGroups = new Map();
const exitLines = [];

let draggedAreaId = null;
let dragPlane = null;
let dragOffset = null;

const errorBanner = document.getElementById('error');
const legend = document.getElementById('legend');
const sceneHost = document.getElementById('scene');
const saveButton = document.getElementById('saveLayout');
const roomList = document.getElementById('roomList');
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

function groupRoomsByArea(rooms) {
  const map = new Map();
  rooms.forEach(room => {
    const list = map.get(room.area) || [];
    list.push(room);
    map.set(room.area, list);
  });
  return map;
}

function renderRoomList(areas, rooms, areaColors) {
  roomList.innerHTML = '';
  const roomsByArea = groupRoomsByArea(rooms);
  const sortedAreas = [...areas].sort((a, b) => a.name.localeCompare(b.name));

  sortedAreas.forEach(area => {
    const section = document.createElement('div');
    section.className = 'room-section';

    const header = document.createElement('div');
    header.className = 'room-section-header';

    const swatch = document.createElement('div');
    swatch.className = 'legend-swatch';
    swatch.style.background = areaColors.get(area.uid);
    header.appendChild(swatch);

    const name = document.createElement('span');
    name.textContent = area.name;
    header.appendChild(name);

    const count = document.createElement('span');
    count.className = 'room-section-count';
    const areaRooms = roomsByArea.get(area.uid) || [];
    count.textContent = `${areaRooms.length} rooms`;
    header.appendChild(count);

    section.appendChild(header);

    const roomItems = document.createElement('div');
    roomItems.className = 'room-items';
    [...areaRooms].sort((a, b) => a.name.localeCompare(b.name)).forEach(room => {
      const item = document.createElement('div');
      item.className = 'room-item';
      item.textContent = room.name;
      roomItems.appendChild(item);
    });

    section.appendChild(roomItems);
    roomList.appendChild(section);
  });
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

function centerCamera(camera, controls, bounds) {
  camera.up.set(0, 0, 1);
  const center = new THREE.Vector3(
    (bounds.min.x + bounds.max.x) / 2,
    (bounds.min.y + bounds.max.y) / 2,
    (bounds.min.z + bounds.max.z) / 2
  );
  controls.target.copy(center);
  const span = Math.max(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, 60);
  camera.position.set(center.x, center.y, bounds.max.z + span);
  controls.minPolarAngle = 0;
  controls.maxPolarAngle = Math.PI / 2;
  controls.screenSpacePanning = true;
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

function getRoomWorldPosition(roomId, roomById) {
  const room = roomById.get(roomId);
  if (!room) return null;
  const areaPosition = roomPositionsByArea.get(room.area) || new Map();
  const local = areaPosition.get(roomId) || [0, 0, 0];
  const offset = areaOffsets.get(room.area) || new THREE.Vector3();
  return new THREE.Vector3(
    (local[0] + offset.x) * SCALE,
    (local[1] + offset.y) * SCALE,
    (local[2] + offset.z) * SCALE
  );
}

function updateExitLines(roomById) {
  exitLines.forEach(line => {
    const { from, to } = line.userData;
    const start = getRoomWorldPosition(from, roomById);
    const end = getRoomWorldPosition(to, roomById);
    if (!start || !end) return;
    line.geometry.setFromPoints([start, end]);
    line.geometry.attributes.position.needsUpdate = true;
  });
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

function buildScene(rooms, exits, areaColors, areas) {
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
  controls.enableRotate = true;

  const ambient = new THREE.AmbientLight('#ffffff', 0.6);
  scene.add(ambient);
  const directional = new THREE.DirectionalLight('#ffffff', 0.7);
  directional.position.set(30, 40, 50);
  scene.add(directional);

  const gridHelper = new THREE.GridHelper(800, 80, '#334155', '#1e293b');
  gridHelper.rotation.x = Math.PI / 2;
  scene.add(gridHelper);
  const axesHelper = new THREE.AxesHelper(20);
  axesHelper.position.set(-10, -10, 0);
  scene.add(axesHelper);

  const roomGeometry = new THREE.BoxGeometry(1.6, 1.6, 1.6);
  const bounds = { min: new THREE.Vector3(Infinity, Infinity, Infinity), max: new THREE.Vector3(-Infinity, -Infinity, -Infinity) };
  const byArea = groupRoomsByArea(rooms);
  const dragHandles = [];
  const roomById = new Map(rooms.map(r => [r.uid, r]));

  byArea.forEach((areaRooms, areaId) => {
    const group = new THREE.Group();
    areaGroups.set(areaId, group);
    const offset = areaOffsets.get(areaId) || new THREE.Vector3();
    group.position.set(offset.x * SCALE, offset.y * SCALE, offset.z * SCALE);

    const positions = roomPositionsByArea.get(areaId) || new Map();
    const color = areaColors.get(areaId) || '#ffffff';
    const material = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.1 });

    areaRooms.forEach(room => {
      const position = positions.get(room.uid) || [0, 0, 0];
      const [x, y, z] = position.map(v => v * SCALE);
      const cube = new THREE.Mesh(roomGeometry, material);
      cube.position.set(x, y, z);
      cube.userData = room;
      group.add(cube);

      const worldPosition = new THREE.Vector3(x, y, z).add(group.position);
      bounds.min.min(worldPosition);
      bounds.max.max(worldPosition);
    });

    const areaBox = new THREE.Box3().setFromObject(group);
    const size = new THREE.Vector3();
    areaBox.getSize(size);
    const center = new THREE.Vector3();
    areaBox.getCenter(center);
    const handleGeom = new THREE.BoxGeometry(size.x + SCALE * 2, size.y + SCALE * 2, size.z + SCALE * 2);
    const handleMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.08, depthWrite: false });
    const handle = new THREE.Mesh(handleGeom, handleMat);
    handle.position.copy(center);
    handle.userData.areaId = areaId;
    handle.name = `area-handle-${areaId}`;
    group.add(handle);
    dragHandles.push(handle);

    scene.add(group);
  });

  const exitMaterial = new THREE.LineBasicMaterial({ color: '#94a3b8', transparent: true, opacity: 0.5 });
  exits.forEach(exit => {
    const start = getRoomWorldPosition(exit.fromuid, roomById);
    const end = getRoomWorldPosition(exit.touid, roomById);
    if (!start || !end) return;
    const geometry = new THREE.BufferGeometry().setFromPoints([start, end]);
    const line = new THREE.Line(geometry, exitMaterial);
    line.userData = { from: exit.fromuid, to: exit.touid };
    scene.add(line);
    exitLines.push(line);
  });

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
      updateExitLines(roomById);
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
    buildLegend(areaColors, selectedAreas);

    const areaRoomSet = new Set(selectedAreas.map(a => a.uid));
    const filteredRooms = rooms.filter(r => areaRoomSet.has(r.area));
    const roomById = new Map(filteredRooms.map(r => [r.uid, r]));
    const filteredExits = exits.filter(exit => roomById.has(exit.fromuid) && roomById.has(exit.touid));

    renderRoomList(selectedAreas, filteredRooms, areaColors);
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
    exitLines.length = 0;

    buildScene(filteredRooms, filteredExits, areaColors, selectedAreas);

    setProgress(1, 'Ready');

    saveButton.addEventListener('click', () => saveMegaCoordinates(selectedAreas));
  } catch (error) {
    console.error(error);
    showError(error.message);
  }
}

bootstrap();
