/// <reference path="../.config/sa.d.ts" />

// Car Crash Look Redux v1.0
// Original mod: Junior_Djjr (2019)
// CLEO Redux port/remaster for GTA San Andreas Classic 1.0 US
//
// Optimization design:
// - NO per-frame loop.
// - Nearby vehicle list refreshed only every 500 ms.
// - Only tracked nearby vehicles are sampled every 100 ms.
// - Ped pool is scanned ONLY after a crash is detected.
// - Crash detection uses Junior's original CVehicle+0xD8 intensity when caught,
//   plus persistent speed/health deltas so a short collision pulse is not required.

const VEHICLE_POOL_PTR_ADDR = 0x00B74494; // CPools::ms_pVehiclePool
const PED_POOL_PTR_ADDR = 0x00B74490;     // CPools::ms_pPedPool
const COLLISION_INTENSITY_OFFSET = 0xD8;

const TRACK_RADIUS = 110.0;
const PED_LOOK_RADIUS = 20.0;
const LOOK_TIME_MS = 2000;
const TASK_LOOK_AT_VEHICLE = 1472;

const SAMPLE_INTERVAL_MS = 100;
const DISCOVERY_INTERVAL_MS = 500;
const VEHICLE_REACTION_COOLDOWN_MS = 1400;

// Merge the two vehicle reports produced by one physical collision.
// A real two-car impact commonly appears on both vehicles in the same sample.
const GLOBAL_CRASH_MERGE_WINDOW_MS = 500;
const GLOBAL_CRASH_MERGE_RADIUS = 14.0;

// Junior's original trigger.
const CRASH_INTENSITY_THRESHOLD = 20.0;

// Persistent fallbacks used when the transient +0xD8 pulse is missed.
// These deliberately require vehicle motion so bullets on a parked car do not count.
const HEALTH_DROP_THRESHOLD = 8.0;
const MIN_MOVING_SPEED = 2.0;
const HARD_SPEED_DROP_THRESHOLD = 6.0;
const HARD_SPEED_MIN_BEFORE = 12.0;
const MIN_DAMAGE_WITH_HARD_SPEED_DROP = 1.0;

const MAX_REASONABLE_POOL_SIZE = 4096;
const DEBUG = false;

let trackedVehicles = new Map();
let discoveryAccumulator = DISCOVERY_INTERVAL_MS; // populate immediately
let trackingProofLogged = false;
let recentCrashEvents = [];

function debugLog(message) {
    if (DEBUG) log("[CarCrashLookRedux] " + message);
}

function u32(value) {
    return value >>> 0;
}

function readPool(poolPtrAddress) {
    const pool = u32(Memory.ReadU32(poolPtrAddress, false));
    if (pool === 0) return null;

    const objects = u32(Memory.ReadU32(pool + 0x0, false));
    const byteMap = u32(Memory.ReadU32(pool + 0x4, false));
    const size = Memory.ReadI32(pool + 0x8, false);

    if (objects === 0 || byteMap === 0) return null;
    if (size <= 0 || size > MAX_REASONABLE_POOL_SIZE) return null;

    return { objects, byteMap, size };
}

function getPoolHandle(slot, poolByte) {
    // GTA SA SCM pool reference = (slot index << 8) + generation byte.
    // This matches CPool::GetRef / GetAtRef in the game.
    const generation = poolByte & 0x7F;
    return (slot << 8) + generation;
}

function distanceSquared(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return dx * dx + dy * dy + dz * dz;
}

function readCollisionIntensity(car) {
    try {
        const ptr = u32(Memory.GetVehiclePointer(car));
        if (ptr === 0) return 0.0;
        const value = Memory.ReadFloat(ptr + COLLISION_INTENSITY_OFFSET, false);
        return Number.isFinite(value) ? value : 0.0;
    } catch (_) {
        return 0.0;
    }
}

function getVehicleSample(car) {
    const speed = car.getSpeed();
    const health = car.getHealth();
    return {
        speed: Number.isFinite(speed) ? speed : 0.0,
        health: Number.isFinite(health) ? health : 0.0
    };
}

function refreshNearbyVehicles() {
    const vehiclePool = readPool(VEHICLE_POOL_PTR_ADDR);
    if (!vehiclePool) return;

    let cameraPos;
    try {
        cameraPos = Camera.GetActiveCoordinates();
    } catch (_) {
        return;
    }

    const maxDistSq = TRACK_RADIUS * TRACK_RADIUS;
    const seen = new Set();

    for (let slot = 0; slot < vehiclePool.size; slot++) {
        const poolByte = Memory.ReadU8(vehiclePool.byteMap + slot, false);
        if ((poolByte & 0x80) !== 0) continue;

        const handle = getPoolHandle(slot, poolByte);
        const car = new Car(handle);

        try {
            if (Car.IsDead(car)) continue;

            const pos = car.getCoordinates();
            if (distanceSquared(pos, cameraPos) > maxDistSq) continue;

            seen.add(handle);

            if (!trackedVehicles.has(handle)) {
                const sample = getVehicleSample(car);
                trackedVehicles.set(handle, {
                    speed: sample.speed,
                    health: sample.health,
                    lastReactionAt: 0
                });
            }
        } catch (_) {
            // Vehicle may despawn/recycle during the discovery pass.
        }
    }

    // Drop vehicles that are gone or no longer near the active camera.
    for (const handle of trackedVehicles.keys()) {
        if (!seen.has(handle)) trackedVehicles.delete(handle);
    }

    // One-time proof that the optimized pool discovery is actually producing valid handles.
    if (DEBUG && !trackingProofLogged && trackedVehicles.size > 0) {
        trackingProofLogged = true;
        debugLog("Vehicle tracking active | nearby=" + trackedVehicles.size);
    }
}


function pruneRecentCrashEvents(now) {
    const cutoff = now - GLOBAL_CRASH_MERGE_WINDOW_MS;
    recentCrashEvents = recentCrashEvents.filter(event => event.time >= cutoff);
}

function isDuplicateCrashEvent(now, carPos) {
    pruneRecentCrashEvents(now);
    const mergeDistSq = GLOBAL_CRASH_MERGE_RADIUS * GLOBAL_CRASH_MERGE_RADIUS;
    for (const event of recentCrashEvents) {
        if (distanceSquared(event.pos, carPos) <= mergeDistSq) return true;
    }
    return false;
}

function rememberCrashEvent(now, carPos) {
    recentCrashEvents.push({
        time: now,
        pos: { x: carPos.x, y: carPos.y, z: carPos.z }
    });
}

function makeNearbyPedsLookAtVehicle(car, carPos) {
    const pedPool = readPool(PED_POOL_PTR_ADDR);
    if (!pedPool) return 0;

    let playerPtr = 0;
    try {
        const playerChar = new Player(0).getChar();
        playerPtr = u32(Memory.GetPedPointer(playerChar));
    } catch (_) {
        return 0;
    }

    const maxDistSq = PED_LOOK_RADIUS * PED_LOOK_RADIUS;
    let reacted = 0;

    // This is intentionally event-only: the ped pool is NOT scanned continuously.
    for (let slot = 0; slot < pedPool.size; slot++) {
        const poolByte = Memory.ReadU8(pedPool.byteMap + slot, false);
        if ((poolByte & 0x80) !== 0) continue;

        const ped = new Char(getPoolHandle(slot, poolByte));

        try {
            if (Char.IsDead(ped)) continue;

            const pedPtr = u32(Memory.GetPedPointer(ped));
            if (pedPtr === 0 || pedPtr === playerPtr) continue;

            const pedPos = ped.getCoordinates();
            if (distanceSquared(pedPos, carPos) > maxDistSq) continue;

            // 7 = this task is not currently assigned, matching Junior's guard.
            if (ped.getScriptTaskStatus(TASK_LOOK_AT_VEHICLE) === 7) {
                Task.LookAtVehicle(ped, car, LOOK_TIME_MS);
                reacted++;
            }
        } catch (_) {
            // Ped may despawn/recycle during the reaction pass.
        }
    }

    return reacted;
}

function sampleTrackedVehicles() {
    const now = Date.now();

    for (const [handle, state] of trackedVehicles) {
        const car = new Car(handle);

        try {
            if (Car.IsDead(car)) {
                trackedVehicles.delete(handle);
                continue;
            }

            const sample = getVehicleSample(car);
            const intensity = readCollisionIntensity(car);

            const healthDrop = state.health - sample.health;
            const speedDrop = state.speed - sample.speed;
            const wasMoving = state.speed >= MIN_MOVING_SPEED || sample.speed >= MIN_MOVING_SPEED;

            const originalIntensityHit = intensity > CRASH_INTENSITY_THRESHOLD;
            const damageHit = healthDrop >= HEALTH_DROP_THRESHOLD && wasMoving;
            const hardDecelHit =
                state.speed >= HARD_SPEED_MIN_BEFORE &&
                speedDrop >= HARD_SPEED_DROP_THRESHOLD &&
                healthDrop >= MIN_DAMAGE_WITH_HARD_SPEED_DROP;

            const crashDetected = originalIntensityHit || damageHit || hardDecelHit;
            const cooldownReady = (now - state.lastReactionAt) >= VEHICLE_REACTION_COOLDOWN_MS;

            // Always update the baseline before running reaction work.
            state.speed = sample.speed;
            state.health = sample.health;

            if (!crashDetected || !cooldownReady) continue;

            const carPos = car.getCoordinates();

            // Consume the event for this vehicle even when it is the second half
            // of the same physical two-car crash. This prevents a duplicate on
            // the next 100 ms sample while preserving later independent crashes.
            state.lastReactionAt = now;

            if (isDuplicateCrashEvent(now, carPos)) {
                debugLog(
                    "Merged duplicate crash | vehicle=" + handle +
                    " intensity=" + intensity.toFixed(2)
                );
                continue;
            }

            rememberCrashEvent(now, carPos);
            const reacted = makeNearbyPedsLookAtVehicle(car, carPos);

            debugLog(
                "Crash detected | vehicle=" + handle +
                " intensity=" + intensity.toFixed(2) +
                " healthDrop=" + healthDrop.toFixed(1) +
                " speedDrop=" + speedDrop.toFixed(2) +
                " | peds reacted=" + reacted
            );
        } catch (_) {
            trackedVehicles.delete(handle);
        }
    }
}

log(
    "[CarCrashLookRedux] v1.0 loaded - optimized crash reactions; NO per-frame loop; " +
    "vehicle discovery=500ms, tracked sampling=100ms, ped scan=crash-only; duplicate crash merge=ON; DEBUG=OFF"
);

while (true) {
    wait(SAMPLE_INTERVAL_MS);

    discoveryAccumulator += SAMPLE_INTERVAL_MS;
    if (discoveryAccumulator >= DISCOVERY_INTERVAL_MS) {
        discoveryAccumulator = 0;
        refreshNearbyVehicles();
    }

    sampleTrackedVehicles();
}
