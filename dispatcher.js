/* ================================================================
   dispatcher.js — weighted scoring algorithm for driver assignment.

   Exposes window.dispatcher with:
     - haversineKm(a, b, c, d)                         // km
     - extractDriverLocation(driver)                   // { lat, lng, updatedAt }
     - scoreCandidates(drivers, ride, rides, weights?) // ranked list
     - getWeights() / setWeights(w) / saveWeights(w)   // localStorage

   Hard filters (eliminate):
     - !driver.isApproved
     - driver.status === 'rejected'
     - driver.canReceiveTrips === false
     - seats insufficient (availableSeats < seatsRequired, default 1)
     - time conflict on same day (+/- buffer)

   Scoring (0..1 per component, weighted sum):
     distance    — closer is better (exp decay over 25 km)
     locality    — +1 same baladia, +0.5 same wilaya, else 0
     rating      — completed / (completed + cancelled), 0.8 default
     freshness   — locationUpdatedAt within last 5 min = 1, decays to 0 at 60 min
     workload    — fewer assigned-today trips is better
   ================================================================ */
(function () {
    'use strict';

    const STORAGE_KEY = 'tk.dispatch.weights';
    const DEFAULT_WEIGHTS = Object.freeze({
        distance: 0.40,
        locality: 0.20,
        rating: 0.15,
        freshness: 0.10,
        workload: 0.15,
    });

    const DISTANCE_HALF_LIFE_KM = 8;   // score drops to 0.5 at ~8 km
    const FRESHNESS_FULL_MIN    = 5;   // < 5 min = 1.0
    const FRESHNESS_ZERO_MIN    = 60;  // > 60 min = 0
    const TIME_CONFLICT_BUFFER_MIN = 30;
    const WORKLOAD_SOFT_CAP     = 6;   // 6+ trips today -> penalty 1

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
        const a =
            Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function extractDriverLocation(driver) {
        if (!driver || typeof driver !== 'object') return { lat: null, lng: null, updatedAt: null };
        const lat = toNum(
            driver.locationLat ??
            driver.startLocation?.lat ??
            driver.startLocation?.latitude ??
            driver.latitude ??
            driver.currentLat ??
            driver.currentLatitude ??
            driver.lat
        );
        const lng = toNum(
            driver.locationLng ??
            driver.startLocation?.lng ??
            driver.startLocation?.longitude ??
            driver.startLocation?.lon ??
            driver.startLocation?.long ??
            driver.longitude ??
            driver.currentLng ??
            driver.currentLongitude ??
            driver.lng ??
            driver.long ??
            driver.lon
        );
        const updatedAt = driver.locationUpdatedAt || driver.startLocationUpdatedAt || driver.updatedAt || null;
        return { lat, lng, updatedAt };
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

    function parseTimeToMin(t) {
        if (!t) return null;
        const match = String(t).match(/(\d{1,2})\s*[:hH]\s*(\d{1,2})/);
        if (!match) return null;
        const h = Number(match[1]);
        const m = Number(match[2]);
        if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
        return h * 60 + m;
    }

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

    function ratingFromDriver(driver) {
        const completed = toNum(driver?.completedTrips) ?? toNum(driver?.stats?.completed);
        const cancelled = toNum(driver?.cancelledTrips) ?? toNum(driver?.stats?.cancelled);
        if (completed != null && cancelled != null && completed + cancelled > 0) {
            return completed / (completed + cancelled);
        }
        if (toNum(driver?.rating) != null) {
            // Normalize 0..5 to 0..1
            const r = Math.max(0, Math.min(5, Number(driver.rating)));
            return r / 5;
        }
        return 0.8; // neutral-ish default so drivers without stats don't get punished
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

    function distanceScore(distKm) {
        if (distKm == null || !Number.isFinite(distKm)) return 0;
        // exponential decay so 0km=1, DISTANCE_HALF_LIFE_KM=0.5, 25km≈0.11
        return Math.exp(-distKm / (DISTANCE_HALF_LIFE_KM / Math.LN2));
    }

    function localityScore(driver, ride) {
        const driverWilaya = normWilaya(driver);
        const driverBaladia = normBaladia(driver);
        const rideBaladia = String(ride?.pickupBaladia || ride?.baladia || '').trim().toLowerCase();
        const rideWilaya  = String(ride?.pickupWilaya || ride?.wilaya || '').trim().toLowerCase();
        if (driverBaladia && rideBaladia && driverBaladia === rideBaladia) return 1;
        if (driverWilaya && rideWilaya && driverWilaya === rideWilaya) return 0.5;
        return 0;
    }

    function workloadScore(workload) {
        // 0 trips -> 1, SOFT_CAP+ -> 0
        if (workload <= 0) return 1;
        if (workload >= WORKLOAD_SOFT_CAP) return 0;
        return 1 - workload / WORKLOAD_SOFT_CAP;
    }

    function getWeights() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return { ...DEFAULT_WEIGHTS };
            const parsed = JSON.parse(raw);
            const merged = { ...DEFAULT_WEIGHTS, ...parsed };
            // Normalize so keys match defaults only
            const out = {};
            for (const k of Object.keys(DEFAULT_WEIGHTS)) {
                out[k] = Number.isFinite(merged[k]) ? merged[k] : DEFAULT_WEIGHTS[k];
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

    function scoreCandidates(drivers, ride, allRides, userWeights) {
        const weights = normalizeWeights(userWeights || getWeights());
        const pickupLat = toNum(ride?.pickupLat);
        const pickupLng = toNum(ride?.pickupLng);
        const hasPickup = pickupLat != null && pickupLng != null;
        const seatsRequired = Number(ride?.seatsRequired || 1);

        // Pre-compute route-based detours for every driver so we can both
        // hard-filter (detour must fit the budget) and feed the "distance"
        // score component with a routing-aware value.
        const routed = (window.routeDispatcher && hasPickup)
            ? window.routeDispatcher.findBestDriver(drivers || [], ride, allRides || [])
            : [];
        const routeByDriverId = new Map();
        for (const r of routed) routeByDriverId.set(String(r.driver.id), r);

        const candidates = [];
        for (const driver of drivers || []) {
            if (!driver || driver.isApproved !== true) continue;
            if (String(driver.status || '').toLowerCase() === 'rejected') continue;
            if (driver.canReceiveTrips === false) continue;

            const seats = Number(driver.availableSeats);
            const seatsOk = !Number.isFinite(seats) || seats >= seatsRequired;
            if (!seatsOk) continue;

            const loc = extractDriverLocation(driver);
            let distKm = null;
            if (hasPickup && loc.lat != null && loc.lng != null) {
                distKm = haversineKm(pickupLat, pickupLng, loc.lat, loc.lng);
            }

            const conflict = hasTimeConflict(driver.id, ride, allRides);
            if (conflict) continue;

            // Reject drivers whose best insertion busts the detour budget —
            // the ride simply isn't on their way.
            const routeInfo = routeByDriverId.get(String(driver.id)) || null;
            if (routeInfo && routeInfo.feasible === false
                && (routeInfo.reason === 'detour-exceeded' || routeInfo.reason === 'stops-cap')) {
                continue;
            }

            const workload = countWorkloadToday(driver.id, allRides);

            // "distance" is now interpreted as routing-aware: we score the
            // detour the new ride would add to the driver's existing route.
            // For idle drivers with no active rides, the route is just
            // [current] and detour collapses to haversine(current, P)+haversine(P, D),
            // so the score stays sensible.
            const distanceComponent = routeInfo && Number.isFinite(routeInfo.detour)
                ? (routeInfo.budget > 0
                    ? Math.max(0, 1 - routeInfo.detour / routeInfo.budget)
                    : 1)
                : distanceScore(distKm);

            const components = {
                distance:  distanceComponent,
                locality:  localityScore(driver, ride),
                rating:    ratingFromDriver(driver),
                freshness: freshnessScore(loc.updatedAt),
                workload:  workloadScore(workload),
            };

            let total = 0;
            for (const k of Object.keys(weights)) {
                total += (components[k] || 0) * weights[k];
            }

            candidates.push({
                driver,
                distKm,
                score: total,
                components,
                workload,
                weights,
                location: loc,
                route: routeInfo,
            });
        }

        candidates.sort((a, b) => {
            if (a.score !== b.score) return b.score - a.score;
            // Tie-break: closer, then alphabetical
            if (a.distKm != null && b.distKm != null) return a.distKm - b.distKm;
            return String(a.driver.name || '').localeCompare(String(b.driver.name || ''), undefined, { sensitivity: 'base' });
        });

        return candidates;
    }

    function explainRow(candidate) {
        const chips = [];
        if (candidate.distKm != null) chips.push(`${candidate.distKm.toFixed(1)} km`);
        else chips.push('no gps');
        if (candidate.route && Number.isFinite(candidate.route.detour)) {
            chips.push(`+${candidate.route.detour.toFixed(1)} km detour`);
        }
        const locPct = Math.round(candidate.components.locality * 100);
        if (locPct >= 100) chips.push('same baladia');
        else if (locPct >= 50) chips.push('same wilaya');
        chips.push(`rating ${Math.round(candidate.components.rating * 100)}%`);
        const seats = Number(candidate.driver.availableSeats);
        if (Number.isFinite(seats)) chips.push(`${seats} seats`);
        chips.push(`workload ${candidate.workload}`);
        return chips;
    }

    window.dispatcher = {
        haversineKm,
        extractDriverLocation,
        scoreCandidates,
        getWeights,
        saveWeights,
        explainRow,
        DEFAULT_WEIGHTS,
    };
})();
