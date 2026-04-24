/* ================================================================
   dispatcher.js — route-based multi-passenger dispatch algorithm.

   Single source of truth for driver ranking. Pure Haversine math,
   no external routing service. Exposed on window.dispatcher:

       // public scoring API (consumed by script.js / UI)
       scoreCandidates(drivers, ride, rides, weights?)   -> Candidate[]
       explainRow(candidate)                             -> string[]
       getWeights() / saveWeights(w)                     -> localStorage

       // public geometry + routing primitives (also consumed by UI
       // and by the node sanity tests)
       haversineKm(lat1, lng1, lat2, lng2)               -> number
       extractDriverLocation(driver)                     -> { lat, lng, updatedAt }
       buildDriverRoute(driver, rides)                   -> Stop[]
       computeRouteDistance(route)                       -> number
       generateInsertions(route, newRide)                -> Insertion[]
       findBestInsertion(route, newRide)                 -> { newRoute, detour, newDistance, ... }

   Hard filters applied inside scoreCandidates (driver removed from
   the list entirely):
     - !driver.isApproved
     - driver.status === 'rejected'
     - driver.canReceiveTrips === false
     - availableSeats < seatsRequired
     - day-of-week time conflict with another assigned ride
     - detour > max(1 km, 20% * oldDistance)            (active route)
       or approach-to-pickup > idleMaxApproachKm        (idle driver)
     - stops cap exceeded (default 10 stops in final route)

   Weighted score (0..1 per component, normalized weights):
     distance    = exp(-detour / DETOUR_SCALE_KM)       (0 detour = 1)
     locality    = 1 same baladia, 0.5 same wilaya, 0 otherwise
     rating      = completedTrips / (completedTrips + cancelledTrips)
     freshness   = locationUpdatedAt age (1 at 0 min -> 0 at 60 min)
     workload    = fewer assigned-today rides = higher score
   ================================================================ */
(function () {
    'use strict';

    // ---------- configuration ----------------------------------------

    const STORAGE_KEY = 'tk.dispatch.weights';
    const DEFAULT_WEIGHTS = Object.freeze({
        distance:  0.40,
        locality:  0.20,
        rating:    0.15,
        freshness: 0.10,
        workload:  0.15,
    });

    const ROUTE_DEFAULTS = Object.freeze({
        maxStops:            10,    // hard cap on stops in the FINAL route (includes start).
        detourAbsKm:         1.0,   // floor of the detour budget for active drivers.
        detourRel:           0.20,  // 20% of oldDistance is the ceiling for active drivers.
        idleMaxApproachKm:   15.0,  // max km from idle driver to the pickup point.
    });

    // Controls how sharply the distance score decays with detour km.
    // exp(-detour / DETOUR_SCALE_KM):
    //   detour = 0 km  -> 1.00
    //   detour = 1 km  -> 0.61
    //   detour = 2 km  -> 0.37   <- "half-interesting" point
    //   detour = 5 km  -> 0.08
    const DETOUR_SCALE_KM         = 2.0;

    const FRESHNESS_FULL_MIN      = 5;   // < 5 min -> score 1
    const FRESHNESS_ZERO_MIN      = 60;  // > 60 min -> score 0
    const TIME_CONFLICT_BUFFER_MIN = 30; // another ride within this window on the same day blocks the driver
    const WORKLOAD_SOFT_CAP       = 6;   // 6+ rides today -> workload score 0

    // ---------- tiny helpers -----------------------------------------

    function toNum(v) {
        if (v == null || v === '') return null;
        const raw = typeof v === 'string' ? v.trim().replace(',', '.') : v;
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
    }

    function toRad(d) { return (d * Math.PI) / 180; }

    /** Great-circle distance in km between two (lat, lng) pairs. */
    function haversineKm(lat1, lon1, lat2, lon2) {
        const R = 6371;
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a = Math.sin(dLat / 2) ** 2
                + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2))
                * Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function pointValid(p) {
        return p && Number.isFinite(p.lat) && Number.isFinite(p.lng);
    }

    function parseTimeToMin(t) {
        if (!t) return null;
        const m = String(t).match(/(\d{1,2})\s*[:hH]\s*(\d{1,2})/);
        if (!m) return null;
        const h = Number(m[1]), mm = Number(m[2]);
        return Number.isFinite(h) && Number.isFinite(mm) ? h * 60 + mm : null;
    }

    // ---------- driver / ride adapters -------------------------------

    /**
     * Read the driver's live location from whichever field the record
     * actually has. Returns { lat, lng, updatedAt } with nulls if the
     * data is missing — every consumer handles nulls gracefully.
     */
    function extractDriverLocation(driver) {
        if (!driver || typeof driver !== 'object') {
            return { lat: null, lng: null, updatedAt: null };
        }
        const lat = toNum(
            driver.locationLat
            ?? driver.startLocation?.lat
            ?? driver.startLocation?.latitude
            ?? driver.latitude
            ?? driver.currentLat
            ?? driver.currentLatitude
            ?? driver.lat
        );
        const lng = toNum(
            driver.locationLng
            ?? driver.startLocation?.lng
            ?? driver.startLocation?.longitude
            ?? driver.startLocation?.lon
            ?? driver.startLocation?.long
            ?? driver.longitude
            ?? driver.currentLng
            ?? driver.currentLongitude
            ?? driver.lng
            ?? driver.long
            ?? driver.lon
        );
        const updatedAt = driver.locationUpdatedAt
            || driver.startLocationUpdatedAt
            || driver.updatedAt
            || null;
        return { lat, lng, updatedAt };
    }

    function ridePickup(ride) {
        return { lat: toNum(ride?.pickupLat), lng: toNum(ride?.pickupLng) };
    }
    function rideDropoff(ride) {
        return { lat: toNum(ride?.dropoffLat ?? ride?.dropOffLat),
                 lng: toNum(ride?.dropoffLng ?? ride?.dropOffLng) };
    }

    /** A ride counts toward the driver's current route iff it's assigned
     *  to them AND hasn't finished yet. */
    function rideIsActiveForDriver(ride, driverId) {
        const assigned = String(ride?.driverId || ride?.assignedDriverId || '').trim();
        if (!assigned || assigned !== String(driverId)) return false;
        const status = String(ride?.status || '').toLowerCase();
        if (status === 'completed' || status === 'cancelled') return false;
        return true;
    }

    function normWilaya(driver) {
        return String(driver?.wilayaCode || driver?.wilaya || '').trim().toLowerCase();
    }
    function normBaladia(driver) {
        const b = driver?.baladia;
        if (b && typeof b === 'object') {
            return String(b.id || b.code || b.name || '').trim().toLowerCase();
        }
        return String(b || '').trim().toLowerCase();
    }

    // ---------- route construction -----------------------------------

    /**
     * Build the driver's virtual route:
     *   [ { type: 'start',   lat, lng },
     *     { type: 'pickup',  lat, lng, rideId },
     *     { type: 'dropoff', lat, lng, rideId },
     *     ...                                           ]
     *
     * Rides are ordered by scheduled time ascending. Rides with missing
     * coordinates are silently skipped (they can't contribute to the
     * geometry). If the driver has no location, we still return an
     * empty array — the caller must treat that as "no-location".
     */
    function buildDriverRoute(driver, rides) {
        if (!driver) return [];
        const loc = extractDriverLocation(driver);
        const out = [];
        if (loc.lat != null && loc.lng != null) {
            out.push({ type: 'start', lat: loc.lat, lng: loc.lng, driverId: driver.id });
        }

        const active = (rides || [])
            .filter(r => rideIsActiveForDriver(r, driver.id))
            .map(r => ({ ride: r, t: parseTimeToMin(r.time) ?? Number.MAX_SAFE_INTEGER }))
            .sort((a, b) => a.t - b.t);

        for (const { ride } of active) {
            const p = ridePickup(ride);
            const d = rideDropoff(ride);
            if (pointValid(p)) out.push({ type: 'pickup',  lat: p.lat, lng: p.lng, rideId: ride.id });
            if (pointValid(d)) out.push({ type: 'dropoff', lat: d.lat, lng: d.lng, rideId: ride.id });
        }
        return out;
    }

    /** Sum of Haversine distances between consecutive stops. */
    function computeRouteDistance(route) {
        if (!Array.isArray(route) || route.length < 2) return 0;
        let total = 0;
        for (let i = 0; i < route.length - 1; i++) {
            const a = route[i], b = route[i + 1];
            if (!pointValid(a) || !pointValid(b)) continue;
            total += haversineKm(a.lat, a.lng, b.lat, b.lng);
        }
        return total;
    }

    // ---------- insertion search -------------------------------------
    //
    // Given a route of length n and a new ride (P, D), the set of legal
    // insertions is every (i, j) with 1 <= i <= j <= n:
    //   i  = index where P is inserted  (>=1, can't slide before "start")
    //   j  = index where D is inserted  (>=i, pickup must precede dropoff)
    //
    // That's O(n^2) candidates. Each candidate's delta vs the old
    // distance is computed in O(1) by reusing pre-computed edge /
    // P-to-stop / D-to-stop distances. That keeps scoreCandidates
    // sub-millisecond even with maxStops = 10 across many drivers.

    function _precompute(route, newRide) {
        const n = route.length;
        const edges = new Array(Math.max(0, n - 1));
        let oldDistance = 0;
        for (let k = 0; k < n - 1; k++) {
            edges[k] = haversineKm(route[k].lat, route[k].lng,
                                   route[k + 1].lat, route[k + 1].lng);
            oldDistance += edges[k];
        }
        const P = ridePickup(newRide);
        const D = rideDropoff(newRide);
        const dP = new Array(n);
        const dD = new Array(n);
        for (let k = 0; k < n; k++) {
            dP[k] = haversineKm(P.lat, P.lng, route[k].lat, route[k].lng);
            dD[k] = haversineKm(D.lat, D.lng, route[k].lat, route[k].lng);
        }
        const dPD = haversineKm(P.lat, P.lng, D.lat, D.lng);
        return { n, edges, oldDistance, P, D, dP, dD, dPD };
    }

    function _buildInsertedRoute(route, newRide, i, j) {
        const Pstop = { type: 'pickup',  lat: toNum(newRide?.pickupLat), lng: toNum(newRide?.pickupLng), rideId: newRide?.id };
        const Dstop = { type: 'dropoff', lat: toNum(newRide?.dropoffLat ?? newRide?.dropOffLat), lng: toNum(newRide?.dropoffLng ?? newRide?.dropOffLng), rideId: newRide?.id };
        if (i === j) {
            return [
                ...route.slice(0, i),
                Pstop, Dstop,
                ...route.slice(i),
            ];
        }
        return [
            ...route.slice(0, i),
            Pstop,
            ...route.slice(i, j),
            Dstop,
            ...route.slice(j),
        ];
    }

    /**
     * Enumerate all legal insertions of (P, D) into `route`, each with
     * its resulting detour and full newRoute. O(n^2) candidates. The
     * route coordinates must be validated by the caller.
     *
     * Returns [] if the route is empty or the new ride is missing
     * coordinates — that signals "no valid insertion" to the caller.
     */
    function generateInsertions(route, newRide) {
        if (!Array.isArray(route) || route.length < 1) return [];
        const P = ridePickup(newRide);
        const D = rideDropoff(newRide);
        if (!pointValid(P) || !pointValid(D)) return [];

        const { n, edges, oldDistance, dP, dD, dPD } = _precompute(route, newRide);

        // Idle driver: route = [start] (n === 1). The only legal
        // insertion is "append pickup then dropoff"; treat the ride as
        // [start -> P -> D] per the spec. The P->D leg is unavoidable
        // and is NOT charged against the detour (otherwise every idle
        // driver gets penalized identically for the same unavoidable
        // distance). The approach leg (start -> P) IS the detour.
        if (n === 1) {
            const approach = dP[0];
            return [{
                pickupIndex: 1,
                dropoffIndex: 1,
                idle: true,
                oldDistance: 0,
                newDistance: approach + dPD,
                detour: approach,
                newRoute: _buildInsertedRoute(route, newRide, 1, 1),
            }];
        }

        const out = [];
        for (let i = 1; i <= n; i++) {
            for (let j = i; j <= n; j++) {
                // Compute the delta in O(1) by summing only the edges
                // that change under insertion.
                let delta;
                if (j === i) {
                    // P and D inserted as an adjacent pair.
                    if (i < n) {
                        // Replace edge (i-1, i) with (i-1, P) + (P, D) + (D, i).
                        delta = -edges[i - 1] + dP[i - 1] + dPD + dD[i];
                    } else {
                        // Append both at the tail.
                        delta = dP[n - 1] + dPD;
                    }
                } else {
                    // j > i : existing stops sit between P and D.
                    // (i < n is guaranteed because j > i and j <= n.)
                    delta = -edges[i - 1] + dP[i - 1] + dP[i];
                    if (j < n) {
                        delta += -edges[j - 1] + dD[j - 1] + dD[j];
                    } else {
                        delta += dD[n - 1];
                    }
                }

                out.push({
                    pickupIndex: i,
                    dropoffIndex: j,
                    idle: false,
                    oldDistance,
                    newDistance: oldDistance + delta,
                    detour: delta,
                    // Materialize lazily — callers that only need the
                    // best candidate avoid the O(n) slice.
                    get newRoute() { return _buildInsertedRoute(route, newRide, i, j); },
                });
            }
        }
        return out;
    }

    /**
     * Find the insertion with the smallest detour. Returns a
     * result object with the new route and totals, plus feasibility
     * against the max(1 km, 20% * oldDistance) rule (or idle rule).
     *
     * Handles missing coordinates safely: returns
     *   { feasible: false, reason: 'invalid-coords' | 'empty-route' | 'no-insertion' }
     */
    function findBestInsertion(route, newRide, opts) {
        const options = { ...ROUTE_DEFAULTS, ...(opts || {}) };

        if (!Array.isArray(route) || route.length < 1) {
            return { feasible: false, reason: 'empty-route' };
        }
        const P = ridePickup(newRide);
        const D = rideDropoff(newRide);
        if (!pointValid(P) || !pointValid(D)) {
            return { feasible: false, reason: 'invalid-coords' };
        }

        const insertions = generateInsertions(route, newRide);
        if (insertions.length === 0) {
            return { feasible: false, reason: 'no-insertion' };
        }

        let best = insertions[0];
        for (let k = 1; k < insertions.length; k++) {
            if (insertions[k].detour < best.detour) best = insertions[k];
        }

        const isIdle = best.idle === true;
        const oldDistance = best.oldDistance;
        const budget = isIdle
            ? options.idleMaxApproachKm
            : Math.max(options.detourAbsKm, options.detourRel * oldDistance);

        // Stops cap uses the final route length (n + 2 new stops for
        // active drivers; n + 2 for idle drivers too since idle n=1
        // already includes the start).
        const finalLen = route.length + 2;
        const stopsOk = finalLen <= options.maxStops;

        const budgetOk = best.detour <= budget + 1e-9;
        const feasible = stopsOk && budgetOk;
        const reason = !stopsOk ? 'stops-cap'
                     : !budgetOk ? 'detour-exceeded'
                     : undefined;

        return {
            feasible,
            reason,
            idle: isIdle,
            pickupIndex: best.pickupIndex,
            dropoffIndex: best.dropoffIndex,
            oldDistance,
            newDistance: best.newDistance,
            detour: best.detour,
            budget,
            newRoute: best.newRoute,
        };
    }

    // ---------- scoring ----------------------------------------------

    /** exp(-detour / DETOUR_SCALE_KM), clamped. */
    function detourScore(detourKm) {
        if (!Number.isFinite(detourKm) || detourKm < 0) return 0;
        return Math.exp(-detourKm / DETOUR_SCALE_KM);
    }

    function localityScore(driver, ride) {
        const dWilaya  = normWilaya(driver);
        const dBaladia = normBaladia(driver);
        const rBaladia = String(ride?.pickupBaladia || ride?.baladia || '').trim().toLowerCase();
        const rWilaya  = String(ride?.pickupWilaya  || ride?.wilaya  || '').trim().toLowerCase();
        if (dBaladia && rBaladia && dBaladia === rBaladia) return 1;
        if (dWilaya  && rWilaya  && dWilaya  === rWilaya)  return 0.5;
        return 0;
    }

    function ratingFromDriver(driver) {
        const completed = toNum(driver?.completedTrips) ?? toNum(driver?.stats?.completed);
        const cancelled = toNum(driver?.cancelledTrips) ?? toNum(driver?.stats?.cancelled);
        if (completed != null && cancelled != null && completed + cancelled > 0) {
            return completed / (completed + cancelled);
        }
        if (toNum(driver?.rating) != null) {
            const r = Math.max(0, Math.min(5, Number(driver.rating)));
            return r / 5;
        }
        return 0.8; // neutral default so new drivers aren't punished.
    }

    function freshnessScore(updatedAt) {
        if (!updatedAt) return 0;
        const ts = typeof updatedAt === 'number' ? updatedAt : Date.parse(updatedAt);
        if (!Number.isFinite(ts)) return 0;
        const ageMin = (Date.now() - ts) / 60000;
        if (ageMin <= FRESHNESS_FULL_MIN) return 1;
        if (ageMin >= FRESHNESS_ZERO_MIN) return 0;
        return 1 - (ageMin - FRESHNESS_FULL_MIN) / (FRESHNESS_ZERO_MIN - FRESHNESS_FULL_MIN);
    }

    function workloadScore(workload) {
        if (workload <= 0) return 1;
        if (workload >= WORKLOAD_SOFT_CAP) return 0;
        return 1 - workload / WORKLOAD_SOFT_CAP;
    }

    // ---------- hard filters -----------------------------------------

    function hasTimeConflict(driverId, ride, allRides) {
        const targetMin = parseTimeToMin(ride?.time);
        if (targetMin == null) return false;
        const day = String(ride?.day || '').toLowerCase();
        const rideId = String(ride?.id || '');
        for (const r of allRides || []) {
            if (!r || String(r.id || '') === rideId) continue;
            if (String(r.day || '').toLowerCase() !== day) continue;
            const assigned = String(r.driverId || r.assignedDriverId || '').trim();
            if (!assigned || assigned !== String(driverId)) continue;
            const m = parseTimeToMin(r.time);
            if (m == null) continue;
            if (Math.abs(m - targetMin) <= TIME_CONFLICT_BUFFER_MIN) return true;
        }
        return false;
    }

    function countWorkloadToday(driverId, allRides) {
        if (!Array.isArray(allRides)) return 0;
        let n = 0;
        for (const r of allRides) {
            const assigned = String(r?.driverId || r?.assignedDriverId || '').trim();
            if (assigned && assigned === String(driverId)) n++;
        }
        return n;
    }

    // ---------- weights (localStorage) -------------------------------

    function getWeights() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return { ...DEFAULT_WEIGHTS };
            const parsed = JSON.parse(raw);
            const out = {};
            for (const k of Object.keys(DEFAULT_WEIGHTS)) {
                out[k] = Number.isFinite(parsed?.[k]) ? parsed[k] : DEFAULT_WEIGHTS[k];
            }
            return out;
        } catch {
            return { ...DEFAULT_WEIGHTS };
        }
    }

    function saveWeights(weights) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(weights)); } catch { /* ignore */ }
    }

    function normalizeWeights(weights) {
        const keys = Object.keys(DEFAULT_WEIGHTS);
        const total = keys.reduce((s, k) => s + (Number(weights?.[k]) || 0), 0);
        if (total <= 0) return { ...DEFAULT_WEIGHTS };
        const out = {};
        for (const k of keys) out[k] = (Number(weights?.[k]) || 0) / total;
        return out;
    }

    // ---------- main entry point -------------------------------------

    /**
     * Rank candidate drivers for a new ride.
     *
     * The "distance" score component is derived from the route-based
     * detour — drivers for whom the new ride is naturally on the way
     * score ~1.0, drivers for whom it's a big detour score ~0.
     *
     * Drivers who fail a hard filter (approval, seats, time conflict,
     * detour > budget, stops cap) are NOT returned — downstream code
     * doesn't need to know they existed.
     */
    function scoreCandidates(drivers, ride, allRides, userWeights) {
        const weights = normalizeWeights(userWeights || getWeights());
        const P = ridePickup(ride);
        const hasPickup = pointValid(P);
        const seatsRequired = Number(ride?.seatsRequired || 1);

        const out = [];

        for (const driver of drivers || []) {
            // --- hard filters -----------------------------------------
            if (!driver || driver.isApproved !== true) continue;
            if (String(driver.status || '').toLowerCase() === 'rejected') continue;
            if (driver.canReceiveTrips === false) continue;

            const seats = Number(driver.availableSeats);
            if (Number.isFinite(seats) && seats < seatsRequired) continue;

            if (hasTimeConflict(driver.id, ride, allRides)) continue;

            // --- geometry + routing -----------------------------------
            const loc = extractDriverLocation(driver);
            const distKm = (hasPickup && loc.lat != null && loc.lng != null)
                ? haversineKm(P.lat, P.lng, loc.lat, loc.lng)
                : null;

            let routeInfo = null;
            if (hasPickup) {
                const route = buildDriverRoute(driver, allRides);
                if (route.length >= 1) {
                    routeInfo = findBestInsertion(route, ride);
                    routeInfo.route = route;
                }
            }

            // Detour hard filter: reject drivers where the ride simply
            // isn't on their way (or pushes them past the stops cap).
            if (routeInfo && routeInfo.feasible === false
                && (routeInfo.reason === 'detour-exceeded'
                 || routeInfo.reason === 'stops-cap')) {
                continue;
            }

            // --- scoring ----------------------------------------------
            const workload = countWorkloadToday(driver.id, allRides);

            // distance = routing-aware detour score. When we have no
            // pickup coordinate (or no driver location), we fall back
            // to 0 — the driver can still be ranked by the other
            // factors.
            const distComp = (routeInfo && Number.isFinite(routeInfo.detour))
                ? detourScore(routeInfo.detour)
                : 0;

            const components = {
                distance:  distComp,
                locality:  localityScore(driver, ride),
                rating:    ratingFromDriver(driver),
                freshness: freshnessScore(loc.updatedAt),
                workload:  workloadScore(workload),
            };

            let total = 0;
            for (const k of Object.keys(weights)) {
                total += (components[k] || 0) * weights[k];
            }

            out.push({
                driver,
                distKm,          // straight-line km (UI display only)
                score: total,    // 0..1 weighted composite
                components,
                weights,
                workload,
                location: loc,
                route: routeInfo,
            });
        }

        out.sort((a, b) => {
            if (a.score !== b.score) return b.score - a.score;
            if (a.distKm != null && b.distKm != null) return a.distKm - b.distKm;
            return String(a.driver.name || '').localeCompare(
                String(b.driver.name || ''), undefined, { sensitivity: 'base' });
        });

        return out;
    }

    /** Build the chip list shown under each candidate in the UI. */
    function explainRow(candidate) {
        const chips = [];
        if (candidate.distKm != null) chips.push(`${candidate.distKm.toFixed(1)} km`);
        else chips.push('no gps');

        if (candidate.route && Number.isFinite(candidate.route.detour)) {
            chips.push(`+${candidate.route.detour.toFixed(1)} km detour`);
        }

        const locPct = Math.round((candidate.components?.locality || 0) * 100);
        if (locPct >= 100) chips.push('same baladia');
        else if (locPct >= 50) chips.push('same wilaya');

        chips.push(`rating ${Math.round((candidate.components?.rating || 0) * 100)}%`);

        const seats = Number(candidate.driver.availableSeats);
        if (Number.isFinite(seats)) chips.push(`${seats} seats`);

        chips.push(`workload ${candidate.workload}`);
        return chips;
    }

    // ---------- export -----------------------------------------------

    const api = {
        // scoring
        scoreCandidates,
        explainRow,
        getWeights,
        saveWeights,
        DEFAULT_WEIGHTS,

        // geometry + routing primitives
        haversineKm,
        extractDriverLocation,
        buildDriverRoute,
        computeRouteDistance,
        generateInsertions,
        findBestInsertion,

        // constants (tunable by callers / tests)
        ROUTE_DEFAULTS,
        DETOUR_SCALE_KM,
    };

    if (typeof window !== 'undefined') {
        window.dispatcher = api;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})();
