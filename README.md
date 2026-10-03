# Car Crash Look Redux v1.0

Original mod: Junior_Djjr (2019)  
CLEO Redux port/remaster: Flaqko  
Target: GTA San Andreas Classic PC 1.0 + CLEO Redux

## What it does
When a nearby vehicle has a significant crash, eligible pedestrians within 20 meters look at the crashed vehicle for about 2 seconds.

## Remaster changes
- Preserves the original collision-intensity behavior.
- Adds speed/vehicle-health fallbacks so crash detection does not depend on catching a one-frame collision pulse.
- Correct GTA SA vehicle/ped pool handle construction.
- Merges both sides of the same two-car collision into one pedestrian reaction.

## Optimization
- No per-frame loop.
- Nearby vehicle discovery every 500 ms.
- Only tracked nearby vehicles sampled every 100 ms.
- Pedestrian pool scanned only after a detected crash.
- 1.4-second per-vehicle cooldown prevents repeat work from one impact.
- 500 ms / 14 m same-crash merge prevents both vehicles from triggering duplicate reactions.
- Debug logging is OFF in the release build.

## Installation
Copy `CLEO/CarCrashLookRedux[mem]` into your GTA San Andreas `CLEO` folder.

The `[mem]` permission tag is required because the mod reads GTA SA pool and vehicle memory.
