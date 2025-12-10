const MAP_SOURCES = [
  { file: 'parsed_maps/area18.json', areaId: 18, displayName: 'The Grand City of Aylor' },
  { file: 'parsed_maps/area258.json', areaId: 258, displayName: 'Aylorian Academy' },
];

const LINK_TYPES = {
  LINK_ONEWAY: 0,
  LINK_TWOWAY: 1,
  LINK_DISCONNECTED: 2,
  LINK_TO_ANOTHER_AREA: 3,
};

const ORIGIN_REFERENCE = {
  areaId: 18,
  roomId: 2,
  coordinates: { x: 11, y: 12, z: 0 },
};

function computeAreaOffset(anchorCoordinates) {
  return {
    // Align axes so north/south map to ±X, east/west to ±Y, up/down to ±Z.
    x: -(anchorCoordinates?.y ?? 0),
    y: -(anchorCoordinates?.x ?? 0),
    z: -(anchorCoordinates?.z ?? 0),
  };
}

const AREA_OFFSETS = {
  [ORIGIN_REFERENCE.areaId]: computeAreaOffset(ORIGIN_REFERENCE.coordinates),
};

const ROOM_RADIUS = 0.6;
const WORLD_SCALE = 1.25;

function hashColor(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) {
    h = (h << 5) - h + seed.charCodeAt(i);
    h |= 0;
  }
  const hue = Math.abs(h) % 360;
  return new THREE.Color(`hsl(${hue}, 60%, 60%)`);
}

function deriveAreaIdFromFile(fileName) {
  const match = fileName.match(/area(\d+)/);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function buildRoomLookup(rooms) {
  const byId = new Map();
  const byIndex = new Map();
  rooms.forEach((room) => {
    byId.set(room.id, room);
    byIndex.set(room.index, room);
  });
  return { byId, byIndex };
}

function normalizeRoomPosition(room, areaOffset) {
  return new THREE.Vector3(
    // X axis = north/south (positive north). Map Y becomes world X.
    (room.y + (areaOffset?.x ?? 0)) * WORLD_SCALE,
    // Y axis = east/west (positive east). Map X becomes world Y.
    (room.x + (areaOffset?.y ?? 0)) * WORLD_SCALE,
    // Z axis = up/down. Reserved for future vertical offsets.
    ((room.z ?? 0) + (areaOffset?.z ?? 0)) * WORLD_SCALE,
  );
}

function buildWorldRooms(areaData, areaId, areaName) {
  const areaOffset = AREA_OFFSETS[areaId] ?? { x: 0, y: 0, z: 0 };
  const areaColor = hashColor(String(areaId));
  const rooms = areaData.rooms.map((room) => ({
    ...room,
    areaId,
    areaName,
    position: normalizeRoomPosition(room, areaOffset),
    color: room.isEntrance ? new THREE.Color('#22d3ee') : areaColor,
    pkColor: room.pk ? new THREE.Color('#a855f7') : null,
    connections: [],
  }));

  const lookups = buildRoomLookup(rooms);

  Object.entries(areaData.roomConnections ?? {}).forEach(([roomIndex, connectionList]) => {
    const fromRoom = lookups.byIndex.get(Number(roomIndex));
    if (!fromRoom) return;

    connectionList.forEach((connection) => {
      const targetRoom = connection.to == null ? null : lookups.byIndex.get(Number(connection.to));
      fromRoom.connections.push({
        direction: connection.direction,
        to: targetRoom
          ? { areaId, roomId: targetRoom.id, name: targetRoom.name, index: targetRoom.index }
          : null,
        areaExit: connection.areaExit ?? null,
        exitType: connection.exitType,
        linkType: connection.linkType,
        door: connection.door,
        exitAction: connection.exitAction,
      });
    });
  });

  return { rooms, lookups };
}

function buildWorldLinks(areaData, lookups, areaId) {
  const links = [];
  const seenPairs = new Set();
  const entries = Object.entries(areaData.roomConnections ?? {});

  entries.forEach(([roomIndex, connectionList]) => {
    const fromRoom = lookups.byIndex.get(Number(roomIndex));
    if (!fromRoom) return;

    connectionList.forEach((connection) => {
      if (connection.to == null) return;
      const toRoom = lookups.byIndex.get(Number(connection.to));
      if (!toRoom) return;

      const key = [
        `${areaId}:${fromRoom.id}`,
        `${areaId}:${toRoom.id}`,
      ]
        .sort()
        .join('->');

      if (seenPairs.has(key)) return;
      seenPairs.add(key);

      links.push({
        from: fromRoom,
        to: toRoom,
        linkType: connection.linkType,
        exitType: connection.exitType,
        areaId,
      });
    });
  });

  return links;
}

async function loadArea(source) {
  const response = await fetch(source.file);
  if (!response.ok) {
    throw new Error(`Failed to load ${source.file}: ${response.status}`);
  }
  const parsed = await response.json();
  const areaId = source.areaId ?? deriveAreaIdFromFile(source.file);
  const areaName = source.displayName ?? parsed.metadata?.area_name ?? `Area ${areaId}`;
  const { rooms, lookups } = buildWorldRooms(parsed, areaId, areaName);
  const links = buildWorldLinks(parsed, lookups, areaId);

  return { rooms, links, areaId, areaName };
}

async function loadWorld() {
  const results = await Promise.all(MAP_SOURCES.map((source) => loadArea(source)));
  const world = { rooms: [], links: [] };
  results.forEach((result) => {
    world.rooms.push(...result.rooms);
    world.links.push(...result.links);
  });
  return world;
}

function createRoomMesh(room) {
  const material = new THREE.MeshStandardMaterial({
    color: room.pkColor ?? room.color,
    emissive: room.pkColor ? room.pkColor.clone().multiplyScalar(0.35) : undefined,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(ROOM_RADIUS, 18, 14), material);
  mesh.position.copy(room.position);
  mesh.userData = { room };
  return mesh;
}

function createLink(from, to, linkType) {
  const points = [from.position, to.position];
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({
    color: linkType === LINK_TYPES.LINK_TWOWAY ? '#f97316' : '#f43f5e',
    linewidth: 1,
  });
  return new THREE.Line(geometry, material);
}

function formatRoom(room) {
  return `(${room.areaId}) ${room.name} [id=${room.id}, idx=${room.index}]`;
}

function renderConnections(room) {
  if (!room.connections?.length) return '<em>No exits found for this room.</em>';

  const entries = room.connections.map((conn) => {
    const direction = conn.direction ?? 'unknown';
    const exitType = conn.exitType ?? 'unknown';
    const linkType = conn.linkType ?? 'unknown';

    if (conn.areaExit) {
      const exitName = conn.areaExit.raw ?? 'Other area';
      return `<li><strong>${direction}</strong> → <span title="${exitName}">External area</span> (link ${linkType}, exit ${exitType})</li>`;
    }

    if (!conn.to) {
      return `<li><strong>${direction}</strong> → <em>disconnected</em> (link ${linkType}, exit ${exitType})</li>`;
    }

    return `<li><strong>${direction}</strong> → ${conn.to.name} [id=${conn.to.roomId}, idx=${conn.to.index}] (link ${linkType}, exit ${exitType})</li>`;
  });

  return `<ul>${entries.join('')}</ul>`;
}

function updateSelection(element, room) {
  if (!room) {
    element.innerHTML = 'Select a room to see details.';
    return;
  }
  element.innerHTML = `
    <div><strong>${room.name}</strong></div>
    <div>Area: ${room.areaName} (id: ${room.areaId})</div>
    <div>Room id: ${room.id} · Index: ${room.index}</div>
    <div>Position: (${room.position.x.toFixed(2)}, ${room.position.y.toFixed(2)}, ${room.position.z.toFixed(2)})</div>
    <div>Entrance: ${room.isEntrance ? 'yes' : 'no'} · PK: ${room.pk ? 'yes' : 'no'}</div>
    <div style="margin-top:8px;"><strong>Exits</strong></div>
    ${renderConnections(room)}
  `;
}

function initScene(world) {
  const canvas = document.getElementById('world');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#0b1224');

  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);
  camera.position.set(25, 35, 45);

  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0, 0);

  scene.add(new THREE.HemisphereLight('#dbeafe', '#0f172a', 0.9));
  const keyLight = new THREE.DirectionalLight('#ffffff', 0.65);
  keyLight.position.set(30, 60, 40);
  scene.add(keyLight);

  const grid = new THREE.GridHelper(200, 50, '#1f2937', '#111827');
  grid.material.opacity = 0.5;
  grid.material.transparent = true;
  scene.add(grid);

  const roomGroup = new THREE.Group();
  const linkGroup = new THREE.Group();
  scene.add(linkGroup);
  scene.add(roomGroup);

  world.rooms.forEach((room) => roomGroup.add(createRoomMesh(room)));
  world.links.forEach((link) => linkGroup.add(createLink(link.from, link.to, link.linkType)));

  const selectionElement = document.getElementById('selection');
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let highlighted = null;

  function onPointerMove(event) {
    pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(roomGroup.children);
    const hit = hits[0]?.object ?? null;
    if (hit === highlighted) return;
    highlighted?.material.emissive?.set('#000000');
    highlighted = hit;
    if (highlighted?.material?.emissive) {
      highlighted.material.emissive.set('#fcd34d');
    }
    updateSelection(selectionElement, highlighted?.userData?.room);
  }

  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('resize', onResize);

  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }

  animate();
}

(async function main() {
  try {
    const world = await loadWorld();
    initScene(world);
  } catch (error) {
    console.error('Failed to initialize world renderer', error);
    const ui = document.getElementById('selection');
    ui.innerHTML = `Error loading world data: ${error.message}`;
  }
})();
