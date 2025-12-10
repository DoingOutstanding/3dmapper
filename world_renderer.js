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
  coordinates: { x: 0, y: 0, z: 0 },
};

const CROSS_AREA_ANCHORS = [
  {
    areaId: 258,
    roomId: 136,
    direction: 'down',
    targetAreaId: 18,
    targetRoomId: 2,
  },
];

function computeAreaOffset(anchorCoordinates) {
  return {
    x: -(anchorCoordinates?.x ?? 0),
    y: -(anchorCoordinates?.y ?? 0),
    z: -(anchorCoordinates?.z ?? 0),
  };
}

const AREA_OFFSETS = {
  [ORIGIN_REFERENCE.areaId]: computeAreaOffset(ORIGIN_REFERENCE.coordinates),
};

const ROOM_SIZE = 1;
const WORLD_SCALE = 2;
const MIN_MAP_VERTICAL_GAP = 1;

const DIRECTION_OFFSETS = {
  north: { x: 1, y: 0, z: 0 },
  south: { x: -1, y: 0, z: 0 },
  east: { x: 0, y: 1, z: 0 },
  west: { x: 0, y: -1, z: 0 },
  up: { x: 0, y: 0, z: 1 },
  down: { x: 0, y: 0, z: -1 },
};

function normalizeManualCoordinates(manualCoords = {}) {
  const normalized = {};
  Object.entries(manualCoords).forEach(([roomIndex, coords]) => {
    if (!coords) return;
    normalized[Number(roomIndex)] = {
      x: Number(coords.x ?? 0),
      y: Number(coords.y ?? 0),
      z: Number(coords.z ?? 0),
    };
  });
  return normalized;
}

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

function normalizeRoomPosition(room, areaOffset, solvedCoords) {
  const coordinates = solvedCoords?.[room.index] ?? { x: room.x, y: room.y, z: room.z ?? 0 };
  return new THREE.Vector3(
    // X axis = north/south (positive north).
    (coordinates.x + (areaOffset?.x ?? 0)) * WORLD_SCALE,
    // Y axis = east/west (positive east).
    (coordinates.y + (areaOffset?.y ?? 0)) * WORLD_SCALE,
    // Z axis = up/down. Stack up/down rooms along Z.
    ((coordinates.z ?? 0) + (areaOffset?.z ?? 0)) * WORLD_SCALE,
  );
}

function computeBoundsFromCoords(solvedCoords) {
  const values = Object.values(solvedCoords ?? {});
  if (!values.length) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
  }

  return values.reduce(
    (acc, coord) => ({
      minX: Math.min(acc.minX, coord.x),
      maxX: Math.max(acc.maxX, coord.x),
      minY: Math.min(acc.minY, coord.y),
      maxY: Math.max(acc.maxY, coord.y),
      minZ: Math.min(acc.minZ, coord.z ?? 0),
      maxZ: Math.max(acc.maxZ, coord.z ?? 0),
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
      minZ: Number.POSITIVE_INFINITY,
      maxZ: Number.NEGATIVE_INFINITY,
    },
  );
}

function solveRoomCoordinates(areaData, areaId) {
  const coordinates = {};
  const inboundCounts = new Map();

  Object.entries(areaData.roomConnections ?? {}).forEach(([roomIndex, connectionList]) => {
    const fromIndex = Number(roomIndex);
    connectionList?.forEach((conn) => {
      if (conn.to == null) return;
      const targetIndex = Number(conn.to);
      inboundCounts.set(targetIndex, (inboundCounts.get(targetIndex) ?? 0) + 1);
    });
  });

  const queue = [];

  const originRoom =
    areaId === ORIGIN_REFERENCE.areaId
      ? areaData.rooms.find((room) => room.id === ORIGIN_REFERENCE.roomId)
      : null;

  if (originRoom) {
    coordinates[originRoom.index] = { ...ORIGIN_REFERENCE.coordinates };
    queue.push(originRoom.index);
  }

  if (!queue.length && areaData.rooms.length) {
    coordinates[areaData.rooms[0].index] = { x: 0, y: 0, z: 0 };
    queue.push(areaData.rooms[0].index);
  }

  const connections = areaData.roomConnections ?? {};

  const propagateQueue = () => {
    let progressed = true;

    while (progressed) {
      progressed = false;

      // Forward propagation (known → unknown targets).
      queue.splice(0).forEach((current) => {
        const currentCoords = coordinates[current];
        const exits = connections[current] ?? [];

        exits.forEach((conn) => {
          if (conn.to == null) return;
          const direction = conn.direction?.toLowerCase();
          const delta = DIRECTION_OFFSETS[direction];
          if (!delta) return;

          const targetIndex = Number(conn.to);
          if (coordinates[targetIndex] != null) return;

          coordinates[targetIndex] = {
            x: currentCoords.x + delta.x,
            y: currentCoords.y + delta.y,
            z: currentCoords.z + delta.z,
          };
          queue.push(targetIndex);
          progressed = true;
        });
      });

      // Reverse propagation (known target → unknown source).
      Object.entries(connections).forEach(([roomIndex, connectionList]) => {
        const fromIndex = Number(roomIndex);
        const exits = connectionList ?? [];
        exits.forEach((conn) => {
          if (conn.to == null) return;
          const direction = conn.direction?.toLowerCase();
          const delta = DIRECTION_OFFSETS[direction];
          if (!delta) return;

          const targetIndex = Number(conn.to);
          const targetCoords = coordinates[targetIndex];
          if (!targetCoords || coordinates[fromIndex] != null) return;

          coordinates[fromIndex] = {
            x: targetCoords.x - delta.x,
            y: targetCoords.y - delta.y,
            z: (targetCoords.z ?? 0) - delta.z,
          };
          queue.push(fromIndex);
          progressed = true;
        });
      });
    }
  };

  propagateQueue();

  const usedCoords = [];
  const MIN_SEPARATION = 0.65;
  const ensureUnique = (coord) => {
    let attempt = 0;
    let candidate = { ...coord };
    const radialStep = 0.25;

    const isColliding = (test) =>
      usedCoords.some((placed) => {
        const dx = placed.x - test.x;
        const dy = placed.y - test.y;
        const dz = (placed.z ?? 0) - (test.z ?? 0);
        return Math.sqrt(dx * dx + dy * dy + dz * dz) < MIN_SEPARATION;
      });

    while (isColliding(candidate)) {
      const ring = Math.floor(attempt / 6) + 1;
      const angle = (attempt % 6) * (Math.PI / 3);
      const radius = ring * radialStep;
      candidate = {
        x: coord.x + Math.cos(angle) * radius,
        y: coord.y + Math.sin(angle) * radius,
        z: coord.z + (attempt % 2 === 0 ? 0 : radialStep * 0.5),
      };
      attempt += 1;
    }

    usedCoords.push(candidate);
    return candidate;
  };

  let fallbackCount = 0;
  const unplacedFallback = () => {
    const shift = fallbackCount * 3;
    fallbackCount += 1;
    return { x: shift, y: shift, z: 0 };
  };

  // Apply diagonal offsets for rooms that can only be exited from (no inbound links).
  const diagonalOffsets = new Map();
  Object.entries(connections).forEach(([roomIndex, connectionList]) => {
    const fromIndex = Number(roomIndex);
    const hasInbound = (inboundCounts.get(fromIndex) ?? 0) > 0;
    const exits = connectionList ?? [];
    if (hasInbound || !exits.length) return;

    const firstExit = exits.find((conn) => conn.to != null && DIRECTION_OFFSETS[conn.direction?.toLowerCase?.() ?? '']);
    if (!firstExit) return;

    const targetIndex = Number(firstExit.to);
    const targetCoords = coordinates[targetIndex];
    const delta = DIRECTION_OFFSETS[firstExit.direction?.toLowerCase?.() ?? ''];
    if (!targetCoords || !delta) return;

    const lean = 0.2;
    diagonalOffsets.set(fromIndex, {
      x: targetCoords.x - delta.x + (delta.x === 0 ? lean : delta.x * 0.25),
      y: targetCoords.y - delta.y + (delta.y === 0 ? lean : delta.y * 0.25),
      z: (targetCoords.z ?? 0) - delta.z + (delta.z === 0 ? lean : delta.z * 0.25),
    });
  });

  // Seed any disconnected components so they get relative coordinates before we
  // start applying diagonals and uniqueness bumps.
  const unresolved = new Set(
    areaData.rooms.filter((room) => coordinates[room.index] == null).map((room) => room.index),
  );

  while (unresolved.size) {
    const nextIndex = unresolved.values().next().value;
    unresolved.delete(nextIndex);
    coordinates[nextIndex] = unplacedFallback();
    queue.push(nextIndex);
    propagateQueue();
    Array.from(unresolved).forEach((roomIndex) => {
      if (coordinates[roomIndex] != null) {
        unresolved.delete(roomIndex);
      }
    });
  }

  areaData.rooms.forEach((room) => {
    const diagonal = diagonalOffsets.get(room.index);
    const existing = coordinates[room.index];
    const coord = diagonal ?? existing ?? unplacedFallback();
    coordinates[room.index] = ensureUnique(coord);
  });

  return coordinates;
}

function buildWorldRooms(areaData, areaId, areaName, areaOffset, solvedCoords) {
  const areaColor = hashColor(String(areaId));
  const rooms = areaData.rooms.map((room) => ({
    ...room,
    areaId,
    areaName,
    position: normalizeRoomPosition(room, areaOffset, solvedCoords),
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

function buildWorldLinks(areaData, lookups, areaId, seenPairs = new Set()) {
  const links = [];
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

function computeAreaOffsets(layouts) {
  const offsets = { ...AREA_OFFSETS };
  const layoutsByArea = new Map(layouts.map((layout) => [layout.areaId, layout]));

  function resolveAnchorOffsets() {
    let placed = false;

    CROSS_AREA_ANCHORS.forEach((anchor) => {
      if (offsets[anchor.areaId]) return;
      const targetOffset = offsets[anchor.targetAreaId];
      if (!targetOffset) return;

      const layout = layoutsByArea.get(anchor.areaId);
      const targetLayout = layoutsByArea.get(anchor.targetAreaId);
      if (!layout || !targetLayout) return;

      const sourceIndex = layout.roomIndexById.get(anchor.roomId);
      const targetIndex = targetLayout.roomIndexById.get(anchor.targetRoomId);
      if (sourceIndex == null || targetIndex == null) return;

      const sourceCoords = layout.solvedCoords[sourceIndex];
      const targetCoords = targetLayout.solvedCoords[targetIndex];
      if (!sourceCoords || !targetCoords) return;

      const delta = DIRECTION_OFFSETS[anchor.direction?.toLowerCase?.() ?? ''] ?? { x: 0, y: 0, z: 0 };

      offsets[anchor.areaId] = {
        x: targetCoords.x + (targetOffset?.x ?? 0) - delta.x - sourceCoords.x,
        y: targetCoords.y + (targetOffset?.y ?? 0) - delta.y - sourceCoords.y,
        z: (targetCoords.z ?? 0) + (targetOffset?.z ?? 0) - delta.z - (sourceCoords.z ?? 0),
      };

      placed = true;
    });

    return placed;
  }

  while (resolveAnchorOffsets()) {
    // Keep resolving anchors until no new offsets can be derived.
  }

  function ensureAnchorSeparation() {
    let adjusted = false;

    CROSS_AREA_ANCHORS.forEach((anchor) => {
      const sourceOffset = offsets[anchor.areaId];
      const targetOffset = offsets[anchor.targetAreaId];
      if (!sourceOffset || !targetOffset) return;

      const sourceLayout = layoutsByArea.get(anchor.areaId);
      const targetLayout = layoutsByArea.get(anchor.targetAreaId);
      if (!sourceLayout || !targetLayout) return;

      const delta = DIRECTION_OFFSETS[anchor.direction?.toLowerCase?.() ?? ''];
      const axis = delta?.x ? 'x' : delta?.y ? 'y' : delta?.z ? 'z' : null;
      const sign = axis ? Math.sign(delta[axis] ?? 0) : 0;
      if (!axis || !sign) return;

      const axisKey = axis.toUpperCase();
      const sourceMin = sourceLayout.bounds[`min${axisKey}`] + (sourceOffset?.[axis] ?? 0);
      const sourceMax = sourceLayout.bounds[`max${axisKey}`] + (sourceOffset?.[axis] ?? 0);
      const targetMin = targetLayout.bounds[`min${axisKey}`] + (targetOffset?.[axis] ?? 0);
      const targetMax = targetLayout.bounds[`max${axisKey}`] + (targetOffset?.[axis] ?? 0);

      if (sign > 0) {
        const desiredMax = targetMin - MIN_MAP_VERTICAL_GAP;
        if (sourceMax > desiredMax) {
          const shift = desiredMax - sourceMax;
          offsets[anchor.areaId] = { ...sourceOffset, [axis]: (sourceOffset?.[axis] ?? 0) + shift };
          adjusted = true;
        }
      } else {
        const desiredMin = targetMax + MIN_MAP_VERTICAL_GAP;
        if (sourceMin < desiredMin) {
          const shift = desiredMin - sourceMin;
          offsets[anchor.areaId] = { ...sourceOffset, [axis]: (sourceOffset?.[axis] ?? 0) + shift };
          adjusted = true;
        }
      }
    });

    return adjusted;
  }

  while (ensureAnchorSeparation()) {
    // Keep lifting anchored areas along their connection axis until gaps are satisfied.
  }

  let highestPlacedZ = Number.NEGATIVE_INFINITY;

  layouts.forEach((layout) => {
    const existingOffset = offsets[layout.areaId];
    if (!existingOffset) return;
    highestPlacedZ = Math.max(highestPlacedZ, layout.bounds.maxZ + (existingOffset.z ?? 0));
  });

  layouts.forEach((layout) => {
    if (offsets[layout.areaId]) return;
    const baseZ = highestPlacedZ === Number.NEGATIVE_INFINITY ? 0 : highestPlacedZ + MIN_MAP_VERTICAL_GAP;
    const offsetZ = baseZ - layout.bounds.minZ;
    offsets[layout.areaId] = { x: 0, y: 0, z: offsetZ };
    highestPlacedZ = Math.max(highestPlacedZ, layout.bounds.maxZ + offsetZ);
  });

  return offsets;
}

function buildWorldFromLayouts(layouts, areaOffsetsOverride = null) {
  const areaOffsets = areaOffsetsOverride ?? computeAreaOffsets(layouts);
  const world = { rooms: [], links: [] };
  const lookupsByArea = new Map();
  const linkPairs = new Set();

  layouts.forEach((layout) => {
    const offset = areaOffsets[layout.areaId] ?? { x: 0, y: 0, z: 0 };
    const { rooms, lookups } = buildWorldRooms(
      layout.parsed,
      layout.areaId,
      layout.areaName,
      offset,
      layout.solvedCoords,
    );
    const links = buildWorldLinks(layout.parsed, lookups, layout.areaId, linkPairs);

    world.rooms.push(...rooms);
    world.links.push(...links);
    lookupsByArea.set(layout.areaId, lookups);
  });

  world.links.push(...buildCrossAreaLinks(layouts, lookupsByArea, linkPairs));
  return { world, lookupsByArea, areaOffsets };
}

function parseAreaIdFromExit(areaExit) {
  const raw = areaExit?.raw;
  if (!raw) return null;
  const match = raw.match(/RoomAreaExitInfo\((\d+)/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function findAreaEntrance(lookup) {
  if (!lookup) return null;
  const rooms = Array.from(lookup.byIndex.values());
  return rooms.find((room) => room.isEntrance) ?? rooms[0] ?? null;
}

function buildCrossAreaLinks(layouts, lookupsByArea, linkPairs) {
  const links = [];

  layouts.forEach((layout) => {
    const fromLookup = lookupsByArea.get(layout.areaId);
    if (!fromLookup) return;

    Object.entries(layout.parsed.roomConnections ?? {}).forEach(([roomIndex, connectionList]) => {
      const fromRoom = fromLookup.byIndex.get(Number(roomIndex));
      if (!fromRoom) return;

      connectionList.forEach((connection) => {
        const targetAreaId = parseAreaIdFromExit(connection.areaExit);
        if (!targetAreaId) return;
        const targetLookup = lookupsByArea.get(targetAreaId);
        const toRoom = findAreaEntrance(targetLookup);
        if (!toRoom) return;

        const key = [
          `${fromRoom.areaId}:${fromRoom.id}`,
          `${toRoom.areaId}:${toRoom.id}`,
        ]
          .sort()
          .join('->');
        if (linkPairs.has(key)) return;
        linkPairs.add(key);

        links.push({
          from: fromRoom,
          to: toRoom,
          linkType: connection.linkType ?? LINK_TYPES.LINK_TO_ANOTHER_AREA,
          exitType: connection.exitType,
          areaId: fromRoom.areaId,
          crossArea: true,
        });
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
  const manualCoords = normalizeManualCoordinates(parsed.manualCoords);
  const solvedCoords = { ...solveRoomCoordinates(parsed, areaId), ...manualCoords };
  const bounds = computeBoundsFromCoords(solvedCoords);
  const roomIndexById = new Map(parsed.rooms.map((room) => [room.id, room.index]));

  return { areaId, areaName, parsed: { ...parsed, manualCoords }, solvedCoords, manualCoords, bounds, roomIndexById };
}

async function loadWorld() {
  const layouts = await Promise.all(MAP_SOURCES.map((source) => loadArea(source)));
  return { layouts, ...buildWorldFromLayouts(layouts) };
}

function createRoomMesh(room) {
  const material = new THREE.MeshStandardMaterial({
    color: room.pkColor ?? room.color,
    emissive: room.pkColor ? room.pkColor.clone().multiplyScalar(0.35) : undefined,
  });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(ROOM_SIZE, ROOM_SIZE, ROOM_SIZE), material);
  mesh.position.copy(room.position);
  mesh.userData = { room };
  return mesh;
}

function createLink(from, to, linkType, { crossArea = false } = {}) {
  const startToEnd = new THREE.Vector3().subVectors(to.position, from.position);
  const length = startToEnd.length();
  const radius = crossArea ? 0.12 : 0.07;
  const geometry = new THREE.CylinderGeometry(radius, radius, length, 10);
  const material = new THREE.MeshStandardMaterial({
    color: linkType === LINK_TYPES.LINK_TWOWAY ? '#f97316' : '#f43f5e',
    emissive: crossArea ? new THREE.Color('#f43f5e').multiplyScalar(0.25) : undefined,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(from.position).addScaledVector(startToEnd, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), startToEnd.clone().normalize());
  mesh.userData = { from, to, linkType, crossArea };
  return mesh;
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

function initScene(world, { onRoomSelected } = {}) {
  const canvas = document.getElementById('world');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#0b1224');

  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);
  camera.up.set(0, 0, 1);
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
  grid.rotation.x = Math.PI / 2;
  grid.material.opacity = 0.5;
  grid.material.transparent = true;
  scene.add(grid);

  const roomGroup = new THREE.Group();
  const linkGroup = new THREE.Group();
  scene.add(linkGroup);
  scene.add(roomGroup);

  const selectionElement = document.getElementById('selection');
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let highlighted = null;
  let selected = null;

  function clearGroup(group) {
    while (group.children.length) {
      const child = group.children.pop();
      group.remove(child);
    }
  }

  function applyWorld(newWorld) {
    clearGroup(roomGroup);
    clearGroup(linkGroup);

    newWorld.rooms.forEach((room) => roomGroup.add(createRoomMesh(room)));
    newWorld.links.forEach((link) =>
      linkGroup.add(createLink(link.from, link.to, link.linkType, { crossArea: link.crossArea })),
    );
  }

  applyWorld(world);

  function setSelection(mesh) {
    highlighted?.material.emissive?.set('#000000');
    highlighted = mesh;
    selected = mesh?.userData?.room ?? null;
    if (highlighted?.material?.emissive) {
      highlighted.material.emissive.set('#fcd34d');
    }
    updateSelection(selectionElement, selected);
    onRoomSelected?.(selected);
  }

  function onPointerMove(event) {
    pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(roomGroup.children);
    const hit = hits[0]?.object ?? null;
    if (hit === highlighted) return;
    setSelection(hit);
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

  function selectRoom(predicate) {
    const mesh = roomGroup.children.find((child) => predicate(child.userData?.room ?? {}));
    setSelection(mesh ?? null);
  }

  return {
    updateWorld(newWorld) {
      applyWorld(newWorld);
      setSelection(null);
    },
    selectRoom,
  };
}

const editorState = {
  layouts: [],
  world: null,
  areaOffsets: null,
  scene: null,
  selectedRoomKey: null,
};

function getLayout(areaId) {
  return editorState.layouts.find((layout) => layout.areaId === areaId) ?? null;
}

function getLogicalCoordinates(room) {
  const layout = getLayout(room?.areaId);
  return layout?.solvedCoords?.[room.index] ?? null;
}

function updateEditorForm(room) {
  const xInput = document.getElementById('coord-x');
  const yInput = document.getElementById('coord-y');
  const zInput = document.getElementById('coord-z');
  const applyButton = document.getElementById('apply-coordinates');
  const saveButton = document.getElementById('save-area');
  const status = document.getElementById('editor-status');

  status.textContent = '';

  if (!room) {
    xInput.value = '';
    yInput.value = '';
    zInput.value = '';
    applyButton.disabled = true;
    saveButton.disabled = true;
    return;
  }

  const logical = getLogicalCoordinates(room) ?? { x: 0, y: 0, z: 0 };
  xInput.value = logical.x;
  yInput.value = logical.y;
  zInput.value = logical.z ?? 0;
  applyButton.disabled = false;
  saveButton.disabled = false;
}

function rebuildWorldWithLayouts() {
  editorState.layouts.forEach((layout) => {
    layout.bounds = computeBoundsFromCoords(layout.solvedCoords);
  });
  const { world, areaOffsets } = buildWorldFromLayouts(editorState.layouts);
  editorState.world = world;
  editorState.areaOffsets = areaOffsets;
  editorState.scene.updateWorld(world);
}

function applyManualCoordinates(coords) {
  const selection = editorState.selectedRoomKey;
  if (!selection) return;

  const layout = getLayout(selection.areaId);
  if (!layout) return;

  const roomIndex = layout.roomIndexById.get(selection.roomId);
  if (roomIndex == null) return;

  layout.manualCoords = layout.manualCoords ?? {};
  layout.parsed.manualCoords = layout.manualCoords;
  layout.manualCoords[roomIndex] = { ...coords };
  layout.solvedCoords[roomIndex] = { ...coords };

  rebuildWorldWithLayouts();

  editorState.scene.selectRoom((room) => room.areaId === selection.areaId && room.id === selection.roomId);

  const status = document.getElementById('editor-status');
  status.textContent = 'Coordinates applied';
  setTimeout(() => {
    if (status.textContent === 'Coordinates applied') {
      status.textContent = '';
    }
  }, 1500);
}

function saveCurrentAreaFile() {
  const selection = editorState.selectedRoomKey;
  if (!selection) return;

  const layout = getLayout(selection.areaId);
  if (!layout) return;

  const status = document.getElementById('editor-status');
  const fileName = layout.parsed.sourceFile ?? `area${layout.areaId}.json`;
  const payload = { ...layout.parsed, manualCoords: layout.manualCoords ?? {} };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(link.href);

  status.textContent = `Saved ${fileName}`;
  setTimeout(() => {
    if (status.textContent === `Saved ${fileName}`) {
      status.textContent = '';
    }
  }, 2000);
}

function setupEditorControls() {
  const xInput = document.getElementById('coord-x');
  const yInput = document.getElementById('coord-y');
  const zInput = document.getElementById('coord-z');
  const applyButton = document.getElementById('apply-coordinates');
  const saveButton = document.getElementById('save-area');

  applyButton.addEventListener('click', (event) => {
    event.preventDefault();
    if (!editorState.selectedRoomKey) return;

    const coords = {
      x: Number(xInput.value),
      y: Number(yInput.value),
      z: Number(zInput.value ?? 0),
    };

    if (Number.isNaN(coords.x) || Number.isNaN(coords.y) || Number.isNaN(coords.z)) {
      const status = document.getElementById('editor-status');
      status.textContent = 'Enter valid numbers for X/Y/Z';
      return;
    }

    applyManualCoordinates(coords);
  });

  saveButton.addEventListener('click', (event) => {
    event.preventDefault();
    saveCurrentAreaFile();
  });
}

(async function main() {
  try {
    const { world, layouts, areaOffsets } = await loadWorld();
    editorState.layouts = layouts;
    editorState.world = world;
    editorState.areaOffsets = areaOffsets;

    editorState.scene = initScene(world, {
      onRoomSelected(room) {
        editorState.selectedRoomKey = room ? { areaId: room.areaId, roomId: room.id } : null;
        updateEditorForm(room);
      },
    });

    setupEditorControls();
  } catch (error) {
    console.error('Failed to initialize world renderer', error);
    const ui = document.getElementById('selection');
    ui.innerHTML = `Error loading world data: ${error.message}`;
  }
})();
