/* ================================================================
   route-dispatcher.js — route-based multi-passenger insertion.

   Problem: a driver already has a partial route
       [currentLocation, p1, d1, p2, d2, ...]
   (pickups and dropoffs of currently-accepted rides). A new ride with
   a pickup P and a dropoff D arrives. We want to insert P and D into
   the driver's route at the positions that minimize the added travel
   distance ("detour"), while preserving the constraint that P must
   come before D.

   Distance is computed purely from coordinates via the Haversine
   formula. No external routing service is used.

   Exposed on window.routeDispatcher:
       haversineKm(lat1, lng1, lat2, lng2)              -> number
       computeRouteDistance(route)                       -> number
       buildDriverRoute(driver, allRides)                -> Point[]
       insertRideIntoRoute(route, newRide, opts?)        -> Result
       findBestDriver(drivers, ride, allRides, opts?)    -> Ranked[]

   Result shape (insertRideIntoRoute):
       {
           feasible: boolean,
           reason?:  'empty-route' | 'invalid-coords' | 'detour-exceeded'
                   | 'seats' | 'rejected' | 'not-approved' | 'cannot-receive'
                   | 'stops-cap',
           oldDistance, newDistance, detour,
           pickupIndex, dropoffIndex,   // in the original route index space
           newRoute,                    // the optimal inserted route
       }
   ================================================================ */
(function () {
    'use strict';

    const DEFAULTS = Object.freeze({
        maxStops:       10,   // hard cap on number of stops in the final route
        detourAbsKm:    1.0,  // detour must be <= max(detourAbsKm, detourRel * oldDistance)
        detourRel:      0.20, // 20% of oldDistance
        minSeats:       1,    // seats required by the new ride
        idleMaxPickupKm: 15,  // for drivers with no active route, max km from
                              // their current location to the pickup point.
                              // The ride itself (P->D) is unavoidable, so we
                              // don't charge it against the detour.
    });

    // --- coordinates helpers -----------------------------------------

    function toNum(v) {
        if (v == null || v === '') return null;
        const raw = typeof v === 'string' ? v.trim().replace(',', '.') : v;
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
    }

    function haversineKm(lat1, lon1, lat2, lon2) {
        const R = 6371;
        const toRad = (d) => (d * Math.PI) / 180;
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a = Math.sin(dLat / 2) ** 2
                + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2))
                * Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function pointsValid(p) {
        return p && Number.isFinite(p.lat) && Number.isFinite(p.lng);
    }

    function computeRouteDistance(route) {
        if (!Array.isArray(route) || route.length < 2) return 0;
        let total = 0;
        for (let i = 0; i < route.length - 1; i++) {
            const a = route[i], b = route[i + 1];
            if (!pointsValid(a) || !pointsValid(b)) continue;
            total += haversineKm(a.lat, a.lng, b.lat, b.lng);
        }
        return total;
    }

    // --- driver + ride adapters --------------------------------------

    function extractDriverLocation(driver) {
        const lat = toNum(
            driver?.locationLat
            ?? driver?.startLocation?.lat
            ?? driver?.startLocation?.latitude
            ?? driver?.latitude
            ?? driver?.currentLat
            ?? driver?.lat
        );
        const lng = toNum(
            driver?.locationLng
            ?? driver?.startLocation?.lng
            ?? driver?.startLocation?.longitude
            ?? driver?.longitude
            ?? driver?.currentLng
            ?? driver?.lng
            ?? driver?.lon
        );
        if (lat == null || lng == null) return null;
        return { lat, lng, kind: 'current', driverId: driver.id };
    }

    function parseTimeToMin(t) {
        if (!t) return null;
        const m = String(t).match(/(\d{1,2})\s*[:hH]\s*(\d{1,2})/);
        if (!m) return null;
        const h = Number(m[1]), mm = Number(m[2]);
        return Number.isFinite(h) && Number.isFinite(mm) ? h * 60 + mm : null;
    }

    function rideIsActiveForDriver(ride, driverId) {
        const assigned = String(ride?.driverId || ride?.assignedDriverId || '').trim();
        if (!assigned || assigned !== String(driverId)) return false;
        const status = String(ride?.status || '').toLowerCase();
        if (status === 'completed' || status === 'cancelled') return false;
        return true;
    }

    /**
     * Build the driver's working route:
     *   [currentLocation, pickup1, dropoff1, pickup2, dropoff2, ...]
     * Rides are ordered by scheduled time ascending; rides missing
     * coordinates are skipped.
     */
    function buildDriverRoute(driver, allRides) {
        if (!driver) return [];
        const current = extractDriverLocation(driver);
        const route = current ? [current] : [];

        const assigned = (allRides || [])
            .filter(r => rideIsActiveForDriver(r, driver.id))
            .map(r => ({
                ride: r,
                sortKey: parseTimeToMin(r.time) ?? Number.MAX_SAFE_INTEGER,
            }))
            .sort((a, b) => a.sortKey - b.sortKey);

        for (const { ride } of assigned) {
            const p = {
                lat: toNum(ride.pickupLat),
                lng: toNum(ride.pickupLng),
                kind: 'pickup',
                rideId: ride.id,
            };
            const d = {
                lat: toNum(ride.dropoffLat ?? ride.dropOffLat),
                lng: toNum(ride.dropoffLng ?? ride.dropOffLng),
                kind: 'dropoff',
                rideId: ride.id,
            };
            if (pointsValid(p)) route.push(p);
            if (pointsValid(d)) route.push(d);
        }
        return route;
    }

    // --- core insertion algorithm ------------------------------------

    /**
     * Try every feasible (pickup-before-dropoff) pair of insertion
     * positions and return the one with minimum detour.
     *
     * Complexity: O(n^2) time, O(n) extra space.
     * All segment and "P/D -> route[k]" distances are computed once
     * and reused via additive deltas, so each (i, j) candidate is O(1).
     */
    function insertRideIntoRoute(route, newRide, opts) {
        const options = { ...DEFAULTS, ...(opts || {}) };
        if (!Array.isArray(route) || route.length < 1) {
            return { feasible: false, reason: 'empty-route' };
        }

        const NP = {
            lat: toNum(newRide?.pickupLat),
            lng: toNum(newRide?.pickupLng),
        };
        const ND = {
            lat: toNum(newRide?.dropoffLat ?? newRide?.dropOffLat),
            lng: toNum(newRide?.dropoffLng ?? newRide?.dropOffLng),
        };
        if (!pointsValid(NP) || !pointsValid(ND)) {
            return { feasible: false, reason: 'invalid-coords' };
        }

        const n = route.length;

        // Cache existing edges and P/D distances so each candidate is O(1).
        const edges = new Array(Math.max(0, n - 1));
        let oldDistance = 0;
        for (let k = 0; k < n - 1; k++) {
            const a = route[k], b = route[k + 1];
            edges[k] = haversineKm(a.lat, a.lng, b.lat, b.lng);
            oldDistance += edges[k];
        }
        const dP = new Array(n);
        const dD = new Array(n);
        for (let k = 0; k < n; k++) {
            dP[k] = haversineKm(NP.lat, NP.lng, route[k].lat, route[k].lng);
            dD[k] = haversineKm(ND.lat, ND.lng, route[k].lat, route[k].lng);
        }
        const dPD = haversineKm(NP.lat, NP.lng, ND.lat, ND.lng);

        // Idle driver shortcut: no active rides means oldDistance = 0.
        // In that case the classic "detour <= 20% of old" rule is
        // meaningless, so we score against the pickup-approach distance
        // alone (the P->D leg is unavoidable and would unfairly penalize
        // any driver equally).
        if (n === 1) {
            const approach = dP[0];
            const budgetIdle = options.idleMaxPickupKm;
            const newDistance = approach + dPD;
            const feasible = approach <= budgetIdle + 1e-9;
            return {
                feasible,
                reason: feasible ? undefined : 'detour-exceeded',
                oldDistance: 0,
                newDistance,
                detour: approach,
                budget: budgetIdle,
                pickupIndex: 1,
                dropoffIndex: 1,
                idle: true,
                get newRoute() {
                    return [
                        route[0],
                        { ...NP, kind: 'pickup',  rideId: newRide?.id },
                        { ...ND, kind: 'dropoff', rideId: newRide?.id },
                    ];
                },
            };
        }

        // Detour budget: insertion is only considered if it fits.
        const budget = Math.max(options.detourAbsKm, options.detourRel * oldDistance);

        // Stops-cap ("optional: limit number of active stops"). The new
        // route gains 2 stops (pickup + dropoff). We reject insertions
        // that would push the route past the cap.
        if (n + 2 > options.maxStops) {
            return {
                feasible: false, reason: 'stops-cap',
                oldDistance, newDistance: oldDistance, detour: Infinity,
            };
        }

        // Enumerate (i, j):
        //   i = position to insert pickup in the ORIGINAL route, 1..n
        //       (i == n means "append at the end").
        //   j = position to insert dropoff in the ORIGINAL route, i..n
        //       (j == i means "dropoff immediately follows pickup").
        //
        // i starts at 1 because position 0 is the driver's current location:
        // we never push the driver back before they move.
        let best = null;

        for (let i = 1; i <= n; i++) {
            for (let j = i; j <= n; j++) {
                let delta;

                if (j === i) {
                    // Pickup and dropoff are adjacent in the inserted pair.
                    if (i < n) {
                        // Replace edge (i-1, i) with (i-1, P) + (P, D) + (D, i)
                        delta = -edges[i - 1] + dP[i - 1] + dPD + dD[i];
                    } else {
                        // Append both at the tail.
                        delta = dP[n - 1] + dPD;
                    }
                } else {
                    // j > i : stops sit between pickup and dropoff.
                    // Insert pickup between i-1 and i (i < n guaranteed
                    // because j > i and j <= n imply i < n).
                    delta = -edges[i - 1] + dP[i - 1] + dP[i];
                    if (j < n) {
                        // Insert dropoff between j-1 and j.
                        delta += -edges[j - 1] + dD[j - 1] + dD[j];
                    } else {
                        // Append dropoff at the tail.
                        delta += dD[n - 1];
                    }
                }

                if (best === null || delta < best.detour) {
                    best = { pickupIndex: i, dropoffIndex: j, detour: delta };
                }
            }
        }

        if (!best) {
            return { feasible: false, reason: 'no-insertion', oldDistance, newDistance: oldDistance, detour: Infinity };
        }

        const newDistance = oldDistance + best.detour;
        const feasible = best.detour <= budget + 1e-9;

        // Build the new route lazily — callers that only need the score
        // don't pay the O(n) array copy.
        const buildNewRoute = () => {
            const NPstop = { ...NP, kind: 'pickup',  rideId: newRide?.id };
            const NDstop = { ...ND, kind: 'dropoff', rideId: newRide?.id };
            if (best.pickupIndex === best.dropoffIndex) {
                return [
                    ...route.slice(0, best.pickupIndex),
                    NPstop, NDstop,
                    ...route.slice(best.pickupIndex),
                ];
            }
            return [
                ...route.slice(0, best.pickupIndex),
                NPstop,
                ...route.slice(best.pickupIndex, best.dropoffIndex),
                NDstop,
                ...route.slice(best.dropoffIndex),
            ];
        };

        return {
            feasible,
            reason: feasible ? undefined : 'detour-exceeded',
            oldDistance,
            newDistance,
            detour: best.detour,
            budget,
            pickupIndex: best.pickupIndex,
            dropoffIndex: best.dropoffIndex,
            get newRoute() { return buildNewRoute(); },
        };
    }

    // --- driver ranking ----------------------------------------------

    /**
     * Hard filters applied before the route calculation so we spend
     * O(n^2) only on drivers that could possibly take the ride.
     */
    function passesHardFilters(driver, newRide, opts) {
        if (!driver) return 'not-approved';
        if (driver.isApproved !== true) return 'not-approved';
        if (String(driver.status || '').toLowerCase() === 'rejected') return 'rejected';
        if (driver.canReceiveTrips === false) return 'cannot-receive';
        const required = Number(newRide?.seatsRequired || opts.minSeats || 1);
        const seats = Number(driver.availableSeats);
        if (Number.isFinite(seats) && seats < required) return 'seats';
        return null;
    }

    /**
     * Route-based driver scoring.
     *
     * We prefer drivers where the new ride is naturally on the way
     * (small detour). When detours tie, drivers with shorter existing
     * routes win — they are simply closer.
     */
    function findBestDriver(drivers, newRide, allRides, opts) {
        const options = { ...DEFAULTS, ...(opts || {}) };
        const ranked = [];

        for (const driver of drivers || []) {
            const reason = passesHardFilters(driver, newRide, options);
            if (reason) {
                ranked.push({ driver, feasible: false, reason });
                continue;
            }

            const route = buildDriverRoute(driver, allRides);
            if (route.length < 1) {
                ranked.push({ driver, feasible: false, reason: 'no-location' });
                continue;
            }

            const result = insertRideIntoRoute(route, newRide, options);

            // Score: 1 at zero detour, 0 at the full budget, clamped.
            // Lower detour -> higher score, so sorting by score desc and
            // by detour asc are equivalent; we keep score for UI display.
            let score = 0;
            if (Number.isFinite(result.detour) && result.budget > 0) {
                score = 1 - Math.min(1, Math.max(0, result.detour / result.budget));
            } else if (result.detour === 0) {
                score = 1;
            }

            ranked.push({
                driver,
                feasible: result.feasible,
                reason: result.reason,
                route,
                oldDistance: result.oldDistance,
                newDistance: result.newDistance,
                detour: result.detour,
                budget: result.budget,
                pickupIndex: result.pickupIndex,
                dropoffIndex: result.dropoffIndex,
                score,
            });
        }

        // Sort: feasible first, then by detour ascending, then by
        // existing route length (shorter = less loaded).
        ranked.sort((a, b) => {
            if (a.feasible !== b.feasible) return a.feasible ? -1 : 1;
            const da = Number.isFinite(a.detour) ? a.detour : Infinity;
            const db = Number.isFinite(b.detour) ? b.detour : Infinity;
            if (da !== db) return da - db;
            const la = a.route ? a.route.length : 0;
            const lb = b.route ? b.route.length : 0;
            return la - lb;
        });

        return ranked;
    }

    window.routeDispatcher = {
        DEFAULTS,
        haversineKm,
        computeRouteDistance,
        buildDriverRoute,
        insertRideIntoRoute,
        findBestDriver,
    };
})();
