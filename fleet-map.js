/* ================================================================
   fleet-map.js — Leaflet integration for:
     1. Dashboard live fleet map
     2. Assign-driver modal preview map (pickup + candidates)

   Exposes window.fleetMap with:
     - initFleetMap()
     - updateFleetMap(drivers)
     - initAssignMap(ride, candidates)  returns map instance
     - destroyAssignMap()
     - iconForDriver(state)
     - iconForPickup() / iconForDropoff()
   ================================================================ */
(function () {
    'use strict';

    const DEFAULT_CENTER = [34.7103729, 5.2781229]; // Biskra fallback
    const DEFAULT_ZOOM = 11;
    const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
    const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

    let fleetMap = null;
    let fleetLayer = null;
    let assignMap = null;

    function divIcon(className, iconHtml) {
        if (!window.L) return null;
        return L.divIcon({
            html: `<div class="pin ${className}"><i class="fas ${iconHtml || ''}"></i></div>`,
            iconSize: [28, 28],
            iconAnchor: [14, 26],
            popupAnchor: [0, -22],
            className: 'pin-wrapper',
        });
    }

    function driverState(driver) {
        if (!driver) return 'offline';
        if (driver.isOnline && driver.canReceiveTrips !== false) return 'online';
        if (driver.isOnline) return 'idle';
        return 'offline';
    }

    function iconForDriver(state) {
        return divIcon(`pin-driver-${state}`, 'fa-car');
    }

    function iconForPickup() { return divIcon('pin-pickup', 'fa-child'); }
    function iconForDropoff() { return divIcon('pin-dropoff', 'fa-flag'); }

    function ensureLeaflet() {
        return typeof L !== 'undefined' && typeof L.map === 'function';
    }

    function driverCoords(driver) {
        if (!window.dispatcher) return null;
        const loc = window.dispatcher.extractDriverLocation(driver);
        if (loc.lat == null || loc.lng == null) return null;
        return [loc.lat, loc.lng];
    }

    function initFleetMap() {
        if (!ensureLeaflet()) return;
        const el = document.getElementById('fleetMap');
        if (!el) return;
        if (fleetMap) return;

        fleetMap = L.map(el, {
            center: DEFAULT_CENTER,
            zoom: DEFAULT_ZOOM,
            zoomControl: true,
            attributionControl: true,
            scrollWheelZoom: false,
        });
        fleetMap.on('focus', () => fleetMap.scrollWheelZoom.enable());
        fleetMap.on('blur',  () => fleetMap.scrollWheelZoom.disable());

        L.tileLayer(TILE_URL, { attribution: TILE_ATTR, maxZoom: 19 }).addTo(fleetMap);
        fleetLayer = L.layerGroup().addTo(fleetMap);
    }

    function updateFleetMap(drivers) {
        if (!fleetMap) initFleetMap();
        if (!fleetMap || !fleetLayer) return;
        fleetLayer.clearLayers();

        const bounds = [];
        let online = 0;
        let idle = 0;
        let offline = 0;

        (drivers || []).forEach((driver) => {
            const coords = driverCoords(driver);
            const state = driverState(driver);
            if (state === 'online') online++;
            else if (state === 'idle') idle++;
            else offline++;

            if (!coords) return;
            const icon = iconForDriver(state);
            if (!icon) return;
            const marker = L.marker(coords, { icon });
            const name = driver.name || 'Driver';
            const phone = driver.phone || '';
            const vehicle = [driver.vehicleMake, driver.vehicleModel].filter(Boolean).join(' ') || '—';
            marker.bindPopup(`
                <strong>${escape(name)}</strong><br>
                <span>${escape(vehicle)}</span><br>
                <span>${escape(phone)}</span>
            `);
            marker.addTo(fleetLayer);
            bounds.push(coords);
        });

        const summary = document.getElementById('fleetMapSummary');
        if (summary && window.i18n) {
            summary.textContent = `${online} ${window.i18n.t('map.online')} · ${idle} ${window.i18n.t('map.idle')} · ${offline} ${window.i18n.t('map.offline')}`;
        }

        if (bounds.length > 1) {
            try { fleetMap.fitBounds(bounds, { padding: [40, 40], maxZoom: 13 }); } catch { /* ignore */ }
        } else if (bounds.length === 1) {
            fleetMap.setView(bounds[0], 13);
        }
        // keep the map responsive when containers change size
        setTimeout(() => fleetMap.invalidateSize(), 0);
    }

    function initAssignMap(ride, candidates) {
        if (!ensureLeaflet()) return null;
        destroyAssignMap();
        const el = document.getElementById('assignMap');
        if (!el) return null;

        const pickupLat = Number(ride?.pickupLat);
        const pickupLng = Number(ride?.pickupLng);
        const hasPickup = Number.isFinite(pickupLat) && Number.isFinite(pickupLng);
        const startCenter = hasPickup ? [pickupLat, pickupLng] : DEFAULT_CENTER;

        assignMap = L.map(el, {
            center: startCenter,
            zoom: hasPickup ? 13 : DEFAULT_ZOOM,
            zoomControl: true,
            attributionControl: true,
        });
        L.tileLayer(TILE_URL, { attribution: TILE_ATTR, maxZoom: 19 }).addTo(assignMap);

        const bounds = [];
        if (hasPickup) {
            const pickupMarker = L.marker([pickupLat, pickupLng], { icon: iconForPickup() });
            pickupMarker.bindPopup(`<strong>${escape(ride?.childName || 'Pickup')}</strong><br>${escape(ride?.pickup || '')}`);
            pickupMarker.addTo(assignMap);
            bounds.push([pickupLat, pickupLng]);
        }
        if (Number.isFinite(Number(ride?.dropoffLocationFull?.lat)) && Number.isFinite(Number(ride?.dropoffLocationFull?.lng))) {
            const dLat = Number(ride.dropoffLocationFull.lat);
            const dLng = Number(ride.dropoffLocationFull.lng);
            const dropMarker = L.marker([dLat, dLng], { icon: iconForDropoff() });
            dropMarker.bindPopup(`<strong>Dropoff</strong><br>${escape(ride?.dropoff || '')}`);
            dropMarker.addTo(assignMap);
            bounds.push([dLat, dLng]);
            if (hasPickup) {
                L.polyline([[pickupLat, pickupLng], [dLat, dLng]], {
                    color: 'var(--primary)',
                    opacity: 0.3,
                    weight: 3,
                    dashArray: '6 6',
                }).addTo(assignMap);
            }
        }

        (candidates || []).slice(0, 10).forEach((c, idx) => {
            const coords = driverCoords(c.driver);
            if (!coords) return;
            const state = idx === 0 ? 'online' : driverState(c.driver);
            const marker = L.marker(coords, { icon: iconForDriver(state) });
            const distTxt = c.distKm != null ? ` · ${c.distKm.toFixed(1)} km` : '';
            marker.bindPopup(`<strong>#${idx + 1} ${escape(c.driver.name || 'Driver')}</strong>${distTxt}`);
            marker.addTo(assignMap);
            bounds.push(coords);
            if (hasPickup) {
                L.polyline([[pickupLat, pickupLng], coords], {
                    color: idx === 0 ? '#1D4599' : '#94A3B8',
                    opacity: idx === 0 ? 0.7 : 0.25,
                    weight: idx === 0 ? 3 : 2,
                }).addTo(assignMap);
            }
        });

        if (bounds.length > 1) {
            try { assignMap.fitBounds(bounds, { padding: [30, 30], maxZoom: 14 }); } catch { /* ignore */ }
        }
        setTimeout(() => assignMap.invalidateSize(), 0);
        return assignMap;
    }

    function destroyAssignMap() {
        if (assignMap) {
            try { assignMap.remove(); } catch { /* ignore */ }
            assignMap = null;
        }
    }

    function escape(text) {
        return String(text ?? '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    window.fleetMap = {
        initFleetMap,
        updateFleetMap,
        initAssignMap,
        destroyAssignMap,
        iconForDriver,
        iconForPickup,
        iconForDropoff,
    };
})();
