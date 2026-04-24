/* ================================================================
   Taxi for Kids — Admin Dashboard
   Main application logic (vanilla JS).
   Depends on: i18n.js, dispatcher.js, fleet-map.js, driver-normalize.js
   ================================================================ */

// ---------------- Data state ----------------
let drivers = [];
let rides = [];
let children = [];
let pendingTripHistoryReq = 0; // race-guard for async history fetches

const PAGE_TITLES = Object.freeze({
    dashboard: 'nav.dashboard',
    drivers:   'nav.drivers',
    rides:     'nav.rides',
    dispatch:  'nav.dispatch',
    children:  'nav.children',
    settings:  'nav.settings',
});
const DEFAULT_PAGE = 'dashboard';
const LIVE_DATA_COLLECTIONS = Object.freeze(['drivers', 'trip_requests', 'parents']);

let firestore = null;
let currentUser = null;
let isAdmin = false;
let liveDataUnsubscribers = [];
let liveRefreshTimer = null;
let isFetchingFirestoreData = false;
let hasQueuedFirestoreRefresh = false;

let driverTableFilter = 'all';
let driverSearchQuery = '';
let rideSearchQuery = '';
let rideTableFilter = 'all';

// ---------------- Utility helpers ----------------
function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function escapeAttr(text) {
    return escapeHtml(text).replace(/'/g, '&#39;');
}

function t(key, fallback) {
    return window.i18n ? window.i18n.t(key, fallback) : (fallback ?? key);
}

function initials(name) {
    return String(name || '?')
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map(s => s.charAt(0).toUpperCase())
        .join('') || '?';
}

function formatDate(value) {
    if (!value) return t('common.notAvailable', 'N/A');
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return t('common.notAvailable', 'N/A');
    const lang = window.i18n ? window.i18n.getLang() : 'en';
    try {
        return d.toLocaleDateString(lang === 'ar' ? 'ar-DZ' : 'en-US', {
            year: 'numeric', month: 'short', day: 'numeric',
        });
    } catch {
        return d.toISOString().slice(0, 10);
    }
}

function formatDateTime(value) {
    if (!value) return t('common.notAvailable', 'N/A');
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return t('common.notAvailable', 'N/A');
    const lang = window.i18n ? window.i18n.getLang() : 'en';
    try {
        return d.toLocaleString(lang === 'ar' ? 'ar-DZ' : 'en-US');
    } catch {
        return d.toISOString();
    }
}

function calculateAge(dob) {
    if (!dob) return t('common.notAvailable', 'N/A');
    const d = new Date(dob);
    if (isNaN(d.getTime())) return t('common.notAvailable', 'N/A');
    const now = new Date();
    let age = now.getFullYear() - d.getFullYear();
    const m = now.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
    return age >= 0 ? age : t('common.notAvailable', 'N/A');
}

function numFromCoord(v) {
    if (v == null || v === '') return null;
    const raw = typeof v === 'string' ? v.trim().replace(',', '.') : v;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
}

function normalizePage(page) {
    return PAGE_TITLES[page] ? page : DEFAULT_PAGE;
}

// ---------------- Toasts ----------------
function showToast({ title = '', body = '', variant = 'info', timeout = 4000 } = {}) {
    const stack = document.getElementById('toastStack');
    if (!stack) return;
    const toast = document.createElement('div');
    toast.className = `toast ${variant}`;
    toast.innerHTML = `
        <div style="flex:1; min-width:0;">
            ${title ? `<div class="title">${escapeHtml(title)}</div>` : ''}
            ${body  ? `<div class="body">${escapeHtml(body)}</div>`   : ''}
        </div>
        <button type="button" class="close" aria-label="Close"><i class="fas fa-times"></i></button>
    `;
    stack.appendChild(toast);
    const remove = () => toast.remove();
    toast.querySelector('.close').addEventListener('click', remove);
    if (timeout > 0) setTimeout(remove, timeout);
}

// ---------------- Ride helpers ----------------
function getRideChildName(ride) {
    if (!ride || typeof ride !== 'object') return 'Unknown Child';
    if (ride.childName && ride.childName !== ride.childId && ride.childName !== 'Unknown Child') {
        return ride.childName;
    }
    if (ride.childId) {
        const child = children.find(c => c.id === ride.childId);
        if (child) return child.name;
    }
    return ride.child?.fullName || ride.child?.name || 'Unknown Child';
}

function getRideAssignedDriverId(ride) {
    if (!ride || typeof ride !== 'object') return '';
    return String(ride.driverId || ride.assignedDriverId || '').trim();
}

function getEffectiveRideStatus(ride) {
    const assignedId = getRideAssignedDriverId(ride);
    const raw = String(ride?.status || '').trim().toLowerCase();
    if (assignedId && (!raw || raw === 'pending')) return 'accepted';
    return raw || 'pending';
}

function isRideAssigned(ride) {
    const assignedId = getRideAssignedDriverId(ride);
    if (assignedId) return true;
    const driverName = String(ride?.driverName || '').trim();
    return Boolean(driverName) && !/^pending driver$/i.test(driverName);
}

function getRideParentContact(ride) {
    if (!ride || typeof ride !== 'object') return { name: 'Unknown Parent', phone: 'N/A' };
    if (ride.parentName || ride.parentPhone) {
        return { name: ride.parentName || 'Unknown Parent', phone: ride.parentPhone || 'N/A' };
    }
    if (ride.childId) {
        const child = children.find(c => c.id === ride.childId);
        if (child) return { name: child.parent || 'Unknown Parent', phone: child.parentPhone || 'N/A' };
    }
    return { name: 'Unknown Parent', phone: 'N/A' };
}

function driverStatusClass(status) {
    const s = String(status || 'pending').toLowerCase();
    if (s === 'approved' || s === 'rejected' || s === 'pending') return s;
    return 'pending';
}

function rideStatusClass(status) {
    const s = String(status || 'pending').toLowerCase();
    if (s === 'accepted') return 'approved';
    if (s === 'approved' || s === 'rejected' || s === 'pending' || s === 'scheduled' || s === 'completed') return s;
    return 'pending';
}

// ---------------- Initialization ----------------
document.addEventListener('DOMContentLoaded', async () => {
    initializeNavigation();
    initializeTheme();
    setupEventListeners();
    setupDispatchSettingsUI();

    // i18n is applied by i18n.js

    const loginModal = document.getElementById('loginModal');
    const pageContent = document.getElementById('pageContent');
    if (loginModal) loginModal.classList.add('active');
    if (pageContent) pageContent.style.display = 'none';

    // Initialize map early so it lays out even before data arrives
    if (window.fleetMap) window.fleetMap.initFleetMap();

    await initFirebase();
});

// ---------------- Firebase init ----------------
async function initFirebase() {
    if (typeof firebase === 'undefined' || !firebase || !firebase.app) {
        useSampleData();
        return;
    }
    if (!window.FIREBASE_CONFIG) {
        console.error('FIREBASE_CONFIG missing. Include firebase-config.js before script.js.');
        useSampleData();
        return;
    }
    try {
        if (!firebase.apps || !firebase.apps.length) {
            firebase.initializeApp(window.FIREBASE_CONFIG);
        }
        firestore = firebase.firestore();
        firebase.auth().onAuthStateChanged(async (user) => {
            currentUser = user || null;
            if (user) {
                const tokenResult = await user.getIdTokenResult(true).catch(() => null);
                isAdmin = !!tokenResult?.claims?.admin;
                onLoggedIn(user);
            } else {
                isAdmin = false;
                onLoggedOut();
            }
        });
    } catch (err) {
        console.error('Firebase init failed:', err);
        useSampleData();
    }
}

function onLoggedIn(user) {
    const loginModal = document.getElementById('loginModal');
    const pageContent = document.getElementById('pageContent');
    if (loginModal) loginModal.classList.remove('active');
    if (pageContent) pageContent.style.display = '';

    const nameEl = document.getElementById('sidebarUserName');
    const roleEl = document.getElementById('sidebarUserRole');
    if (nameEl) nameEl.textContent = user.displayName || user.email || 'Admin';
    if (roleEl) roleEl.textContent = isAdmin ? 'Administrator' : 'Signed-in user';

    document.getElementById('signInBtn')?.setAttribute('hidden', '');
    document.getElementById('emailLoginBtn')?.setAttribute('hidden', '');
    document.getElementById('logoutTopBtn')?.removeAttribute('hidden');
    document.getElementById('logoutBtn')?.removeAttribute('hidden');

    refreshDataFromFirestore().then(() => loadDashboard());
    initializeLiveDataSubscriptions();

    const banner = document.getElementById('liveBanner');
    if (banner) banner.hidden = false;
}

function onLoggedOut() {
    clearLiveDataSubscriptions();
    drivers = [];
    rides = [];
    children = [];

    document.getElementById('signInBtn')?.removeAttribute('hidden');
    document.getElementById('emailLoginBtn')?.removeAttribute('hidden');
    document.getElementById('logoutTopBtn')?.setAttribute('hidden', '');
    document.getElementById('logoutBtn')?.setAttribute('hidden', '');

    const nameEl = document.getElementById('sidebarUserName');
    const roleEl = document.getElementById('sidebarUserRole');
    if (nameEl) nameEl.textContent = t('auth.guest', 'Guest');
    if (roleEl) roleEl.textContent = t('auth.signInToContinue', 'Sign in to continue');

    const banner = document.getElementById('liveBanner');
    if (banner) banner.hidden = true;

    const loginModal = document.getElementById('loginModal');
    const pageContent = document.getElementById('pageContent');
    if (loginModal) loginModal.classList.add('active');
    if (pageContent) pageContent.style.display = 'none';

    renderAll();
}

function useSampleData() {
    drivers = [];
    rides = [];
    children = [];
    renderAll();
}

// ---------------- Live data subscriptions ----------------
function clearLiveDataSubscriptions() {
    liveDataUnsubscribers.forEach(unsubscribe => {
        try { if (typeof unsubscribe === 'function') unsubscribe(); }
        catch (err) { console.warn('Unsubscribe failed:', err); }
    });
    liveDataUnsubscribers = [];
    if (liveRefreshTimer) { clearTimeout(liveRefreshTimer); liveRefreshTimer = null; }
    isFetchingFirestoreData = false;
    hasQueuedFirestoreRefresh = false;
}

function scheduleFirestoreRefresh(delayMs = 200) {
    if (!firestore) return;
    if (liveRefreshTimer) clearTimeout(liveRefreshTimer);
    liveRefreshTimer = setTimeout(() => {
        liveRefreshTimer = null;
        refreshDataFromFirestore();
    }, delayMs);
}

async function refreshDataFromFirestore() {
    if (!firestore) return;
    if (isFetchingFirestoreData) { hasQueuedFirestoreRefresh = true; return; }
    isFetchingFirestoreData = true;
    try {
        await fetchDataFromFirestore();
        renderAll();
    } finally {
        isFetchingFirestoreData = false;
        if (hasQueuedFirestoreRefresh) {
            hasQueuedFirestoreRefresh = false;
            scheduleFirestoreRefresh(0);
        }
    }
}

function initializeLiveDataSubscriptions() {
    if (!firestore || typeof firestore.collection !== 'function') return;
    clearLiveDataSubscriptions();

    LIVE_DATA_COLLECTIONS.forEach(collectionName => {
        const unsubscribe = firestore.collection(collectionName).onSnapshot(
            () => scheduleFirestoreRefresh(),
            (err) => console.error(`Live listener failed for "${collectionName}":`, err),
        );
        liveDataUnsubscribers.push(unsubscribe);
    });

    if (typeof firestore.collectionGroup === 'function') {
        const childrenUnsub = firestore.collectionGroup('children').onSnapshot(
            () => scheduleFirestoreRefresh(),
            (err) => console.error('children collectionGroup listener failed:', err),
        );
        liveDataUnsubscribers.push(childrenUnsub);
        const schedulesUnsub = firestore.collectionGroup('schedules').onSnapshot(
            () => scheduleFirestoreRefresh(),
            (err) => console.error('schedules collectionGroup listener failed:', err),
        );
        liveDataUnsubscribers.push(schedulesUnsub);
    }
}

// ---------------- Firestore fetch ----------------
async function fetchDataFromFirestore() {
    if (!firestore) return;

    const driversSnap = await firestore.collection('drivers').get();
    drivers = driversSnap.docs.map(doc => window.normalizeDriverFromFirestore(doc.id, doc.data()));
    const driverMap = {};
    driversSnap.forEach(doc => {
        const d = doc.data();
        driverMap[doc.id] = d.fullName || d.name || [d.firstName, d.lastName].filter(Boolean).join(' ') || 'Unknown Driver';
    });

    // Rides (flatten trips from parents/children/schedules)
    const collectedRides = [];
    const collectedChildren = [];
    const parentsSnap = await firestore.collection('parents').get();

    for (const parentDoc of parentsSnap.docs) {
        const parentId = parentDoc.id;
        const parentData = parentDoc.data();
        const parentName = parentData.fullName || parentData.name || 'Unknown Parent';
        const parentPhone =
            parentData.phone || parentData.phoneNumber || parentData.mobile || parentData.whatsapp || 'N/A';
        const parentBaladia = parentData.baladia?.id || parentData.baladia?.name || parentData.baladia || '';
        const parentWilaya = parentData.wilaya?.code || parentData.wilaya?.name || parentData.wilaya || '';

        const childrenSnap = await parentDoc.ref.collection('children').get();
        for (const childDoc of childrenSnap.docs) {
            const childId = childDoc.id;
            const childData = childDoc.data();
            const childName = childData.firstName || childData.fullName || 'Unknown Child';
            const childAge = calculateAge(childData.dateOfBirth);
            const childPhotoUrl = childData.photoUrl || null;

            collectedChildren.push({
                __docId: childId,
                id: childId,
                name: childName,
                age: childAge,
                parent: parentName,
                parentPhone,
                parentId,
                photoUrl: childPhotoUrl,
            });

            const schedulesSnap = await childDoc.ref.collection('schedules').get();
            for (const scheduleDoc of schedulesSnap.docs) {
                const scheduleData = scheduleDoc.data();
                const day = scheduleData.day || scheduleDoc.id;
                const trips = scheduleData.trips || [];

                trips.forEach((trip, index) => {
                    const tripAssignedDriverId = String(trip.assignedDriverId || trip.driverId || '').trim();
                    const rawStatus = String(trip.status || 'pending').trim().toLowerCase();
                    const driverName = tripAssignedDriverId
                        ? (driverMap[tripAssignedDriverId] || 'Unknown Driver')
                        : 'Pending Driver';

                    const pickupObj = trip.pickupLocation || trip.pickup || {};
                    const dropoffObj = trip.dropoffLocation || trip.dropoff || {};
                    const pickupDisplay = formatPlaceLabel(pickupObj, 'Unknown pickup');
                    const dropoffDisplay = formatPlaceLabel(dropoffObj, 'Unknown dropoff');

                    collectedRides.push({
                        __docId: scheduleDoc.id,
                        id: `${parentId}-${childId}-${day}-${index}`,
                        scheduleField: 'trips',
                        dayIndex: -1,
                        tripIndex: index,
                        childName,
                        childAge,
                        childPhotoUrl,
                        parentName,
                        parentPhone,
                        driverName,
                        pickup: pickupDisplay,
                        dropoff: dropoffDisplay,
                        pickupLat: numFromCoord(pickupObj.lat),
                        pickupLng: numFromCoord(pickupObj.lng),
                        pickupLocationFull: pickupObj,
                        dropoffLocationFull: dropoffObj,
                        pickupBaladia: pickupObj.baladia?.id || pickupObj.baladia?.name || parentBaladia,
                        pickupWilaya: pickupObj.wilaya?.code || pickupObj.wilaya?.name || parentWilaya,
                        idTrip: trip.idTrip || '',
                        tripType: trip.type || 'other',
                        fromLabel: trip.from || '',
                        toLabel: trip.to || '',
                        isPaused: trip.isPaused || false,
                        isScheduleActive: scheduleData.isActive !== false,
                        childId,
                        parentId,
                        driverId: tripAssignedDriverId,
                        time: trip.time || 'N/A',
                        day,
                        status: tripAssignedDriverId && rawStatus === 'pending' ? 'accepted' : (rawStatus || 'pending'),
                    });
                });
            }
        }
    }

    rides = collectedRides;
    children = collectedChildren;
}

function formatPlaceLabel(place, fallback) {
    if (!place || typeof place !== 'object') return fallback;
    const label =
        place.label || place.name || place.address || place.title || place.description || place.locationName || '';
    if (label && !/detecting place/i.test(label)) return label;

    const lat = numFromCoord(place.lat);
    const lng = numFromCoord(place.lng);
    if (lat != null && lng != null) return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    return fallback || 'Unknown';
}

// ---------------- Theme ----------------
function initializeTheme() {
    const stored = localStorage.getItem('tk.theme');
    const initial = stored || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    applyTheme(initial);

    document.getElementById('themeToggle')?.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
        applyTheme(current === 'dark' ? 'light' : 'dark');
    });
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('tk.theme', theme);
    const toggle = document.getElementById('themeToggle');
    if (toggle) {
        const icon = toggle.querySelector('i');
        if (icon) icon.className = theme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
    }
}

// ---------------- Navigation ----------------
function initializeNavigation() {
    document.querySelectorAll('.nav-item[data-page]').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            switchPage(link.getAttribute('data-page'), { updateHash: true });
        });
    });
    document.querySelectorAll('[data-page]:not(.nav-item)').forEach(el => {
        el.addEventListener('click', () => {
            const filter = el.getAttribute('data-driver-filter');
            if (filter) {
                driverTableFilter = filter;
                setActiveFilterButton('filter-btn', 'data-filter', filter);
            }
            switchPage(el.getAttribute('data-page'), { updateHash: true });
        });
    });
    window.addEventListener('hashchange', () => {
        const hash = location.hash.replace('#', '');
        if (hash) switchPage(hash, { updateHash: false });
    });
}

function switchPage(page, { updateHash = true, refreshData = false } = {}) {
    const target = normalizePage(page);
    document.querySelectorAll('.nav-item[data-page]').forEach(link => {
        link.classList.toggle('active', link.getAttribute('data-page') === target);
    });
    document.querySelectorAll('.page').forEach(p => p.setAttribute('hidden', ''));
    const el = document.getElementById(`${target}Page`);
    if (el) el.removeAttribute('hidden');
    const titleEl = document.getElementById('pageTitle');
    if (titleEl) titleEl.textContent = t(PAGE_TITLES[target], target);
    if (updateHash) history.replaceState(null, '', `#${target}`);
    if (refreshData) refreshDataFromFirestore();

    // When switching to dashboard, recompute map size once it's visible
    if (target === 'dashboard' && window.fleetMap) {
        setTimeout(() => window.fleetMap.updateFleetMap(drivers), 50);
    }
    // Close mobile sidebar after nav
    document.getElementById('sidebar')?.classList.remove('open');

    renderAll();
}

function loadDashboard() {
    const hashPage = window.location.hash.replace('#', '');
    switchPage(hashPage || DEFAULT_PAGE, { refreshData: false, updateHash: Boolean(hashPage) });
}

// ---------------- Event listeners ----------------
function setupEventListeners() {
    document.getElementById('sidebarToggle')?.addEventListener('click', () => {
        const sidebar = document.getElementById('sidebar');
        if (!sidebar) return;
        // Mobile: toggle open class; desktop: toggle collapsed
        if (window.matchMedia('(max-width: 1024px)').matches) {
            sidebar.classList.toggle('open');
        } else {
            sidebar.classList.toggle('collapsed');
        }
    });

    document.getElementById('driverSearch')?.addEventListener('input', (e) => {
        driverSearchQuery = String(e.target.value || '').trim().toLowerCase();
        renderDriversPage();
    });
    document.querySelectorAll('#driversPage .filter-btn[data-filter]').forEach(btn => {
        btn.addEventListener('click', () => {
            driverTableFilter = btn.getAttribute('data-filter');
            setActiveFilterButton('filter-btn', 'data-filter', driverTableFilter);
            renderDriversPage();
        });
    });

    document.getElementById('rideSearch')?.addEventListener('input', (e) => {
        rideSearchQuery = String(e.target.value || '').trim().toLowerCase();
        renderRidesPage();
    });
    document.querySelectorAll('#ridesPage .filter-btn[data-ride-filter]').forEach(btn => {
        btn.addEventListener('click', () => {
            rideTableFilter = btn.getAttribute('data-ride-filter');
            setActiveFilterButton('filter-btn', 'data-ride-filter', rideTableFilter);
            renderRidesPage();
        });
    });

    document.getElementById('childSearch')?.addEventListener('input', () => renderChildrenPage());

    // Modal close buttons
    document.getElementById('closeModal')?.addEventListener('click', () => {
        document.getElementById('driverModal')?.classList.remove('active');
    });
    document.getElementById('closeAssignModal')?.addEventListener('click', closeAssignDriverModal);
    document.getElementById('closeLoginModal')?.addEventListener('click', () => {
        document.getElementById('loginModal')?.classList.remove('active');
    });
    document.addEventListener('click', (e) => {
        // Close modal when clicking backdrop
        if (e.target.classList.contains('modal')) e.target.classList.remove('active');
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            document.querySelectorAll('.modal.active').forEach(m => {
                if (m.id !== 'loginModal') m.classList.remove('active');
            });
        }
    });

    // Assign driver list delegation
    document.getElementById('assignDriverList')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-assign-pick]');
        if (!btn) return;
        assignDriverToRide(btn.getAttribute('data-ride-id'), btn.getAttribute('data-driver-id'));
    });
    document.getElementById('assignAllowModify')?.addEventListener('change', () => {
        const modal = document.getElementById('assignDriverModal');
        const rideId = modal?.getAttribute('data-ride-id');
        if (rideId) renderAssignDriverList(rideId);
    });

    // Login handlers
    document.getElementById('signInBtn')?.addEventListener('click', () => {
        document.getElementById('loginModal')?.classList.add('active');
    });
    document.getElementById('emailLoginBtn')?.addEventListener('click', () => {
        document.getElementById('loginModal')?.classList.add('active');
        document.getElementById('emailTabBtn')?.click();
    });
    document.querySelectorAll('.login-tab[data-tab]').forEach(tab => {
        tab.addEventListener('click', () => {
            const name = tab.getAttribute('data-tab');
            document.querySelectorAll('.login-tab').forEach(t => t.classList.toggle('active', t === tab));
            document.querySelectorAll('.login-tab-content').forEach(c => {
                c.classList.toggle('active', c.id === `${name}TabContent`);
            });
        });
    });
    document.getElementById('emailLoginForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('loginEmail').value;
        const password = document.getElementById('loginPassword').value;
        try {
            await firebase.auth().signInWithEmailAndPassword(email, password);
            document.getElementById('loginModal')?.classList.remove('active');
        } catch (err) {
            showToast({ title: 'Login failed', body: err.message || 'Try again', variant: 'error' });
        }
    });
    document.getElementById('googleLoginBtn')?.addEventListener('click', async () => {
        try {
            const provider = new firebase.auth.GoogleAuthProvider();
            await firebase.auth().signInWithPopup(provider);
            document.getElementById('loginModal')?.classList.remove('active');
        } catch (err) {
            showToast({ title: 'Login failed', body: err.message || 'Try again', variant: 'error' });
        }
    });
    const doLogout = async () => {
        try { await firebase.auth().signOut(); } catch { /* ignore */ }
    };
    document.getElementById('logoutBtn')?.addEventListener('click', doLogout);
    document.getElementById('logoutTopBtn')?.addEventListener('click', doLogout);

    // Re-render on language change
    document.addEventListener('i18n:changed', () => {
        const activePage = document.querySelector('.nav-item.active')?.getAttribute('data-page') || DEFAULT_PAGE;
        const titleEl = document.getElementById('pageTitle');
        if (titleEl) titleEl.textContent = t(PAGE_TITLES[activePage], activePage);
        renderAll();
    });
}

function setActiveFilterButton(cls, attr, value) {
    document.querySelectorAll(`.${cls}[${attr}]`).forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute(attr) === value);
    });
}

// ---------------- Rendering (all) ----------------
function renderAll() {
    renderStats();
    renderRecentDrivers();
    renderRecentRides();
    renderDriversPage();
    renderRidesPage();
    renderDispatchPage();
    renderChildrenPage();
    renderOnlineDrivers();
    if (window.fleetMap) window.fleetMap.updateFleetMap(drivers);
}

function renderStats() {
    const pending = drivers.filter(d => d.status === 'pending').length;
    setText('totalDrivers', drivers.length);
    setText('pendingDrivers', pending);
    setText('totalRides', rides.length);
    setText('totalChildren', children.length);
    const badge = document.getElementById('pendingDriversBadge');
    if (badge) {
        badge.textContent = String(pending);
        badge.setAttribute('data-count', String(pending));
    }
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = String(value);
}

function renderRecentDrivers() {
    const tbody = document.getElementById('recentDriversTable');
    if (!tbody) return;
    const recent = [...drivers]
        .sort((a, b) => String(b.registrationDate).localeCompare(String(a.registrationDate)))
        .slice(0, 5);
    if (!recent.length) {
        tbody.innerHTML = `<tr class="empty-row"><td colspan="4">${escapeHtml(t('common.noData', 'No data'))}</td></tr>`;
        return;
    }
    tbody.innerHTML = recent.map(driver => `
        <tr>
            <td>
                <div class="table-cell-with-avatar">
                    <div class="cell-avatar">${renderAvatar(driver.profilePhotoUrl, driver.name)}</div>
                    <div class="cell-stack">
                        <strong>${escapeHtml(driver.name)}</strong>
                        <small>${escapeHtml(driver.email)}</small>
                    </div>
                </div>
            </td>
            <td><span class="status-badge status-${driverStatusClass(driver.status)}">${escapeHtml(driver.status)}</span></td>
            <td class="text-sm">${escapeHtml(formatDate(driver.registrationDate))}</td>
            <td><button type="button" class="btn btn-sm" data-driver-id="${escapeAttr(driver.id)}" data-action="view">${escapeHtml(t('common.viewAll', 'View'))}</button></td>
        </tr>
    `).join('');
    tbody.querySelectorAll('[data-action="view"]').forEach(btn => {
        btn.addEventListener('click', () => openDriverModal(btn.getAttribute('data-driver-id')));
    });
}

function renderRecentRides() {
    const tbody = document.getElementById('recentRidesTable');
    if (!tbody) return;
    const recent = rides.slice(0, 5);
    if (!recent.length) {
        tbody.innerHTML = `<tr class="empty-row"><td colspan="5">${escapeHtml(t('common.noData', 'No data'))}</td></tr>`;
        return;
    }
    tbody.innerHTML = recent.map(ride => `
        <tr>
            <td><strong>${escapeHtml(getRideChildName(ride))}</strong></td>
            <td class="text-sm">${escapeHtml(ride.day)}</td>
            <td class="text-sm">${escapeHtml(ride.driverName)}</td>
            <td><span class="status-badge status-${rideStatusClass(getEffectiveRideStatus(ride))}">${escapeHtml(getEffectiveRideStatus(ride))}</span></td>
            <td class="text-sm">${escapeHtml(ride.time)}</td>
        </tr>
    `).join('');
}

function renderAvatar(url, name) {
    if (url) return `<img src="${escapeAttr(url)}" alt="" onerror="this.outerHTML='<span>${escapeHtml(initials(name))}</span>'">`;
    return `<span>${escapeHtml(initials(name))}</span>`;
}

// ---------------- Drivers page ----------------
function renderDriversPage() {
    const tbody = document.getElementById('driversTable');
    if (!tbody) return;
    const filtered = drivers.filter(driver => {
        if (driverTableFilter !== 'all' && driver.status !== driverTableFilter) return false;
        if (!driverSearchQuery) return true;
        const hay = `${driver.name} ${driver.email} ${driver.phone} ${driver.vehiclePlate}`.toLowerCase();
        return hay.includes(driverSearchQuery);
    });
    if (!filtered.length) {
        tbody.innerHTML = `<tr class="empty-row"><td colspan="6">${escapeHtml(t('common.noData', 'No drivers'))}</td></tr>`;
        return;
    }
    tbody.innerHTML = filtered.map(driver => `
        <tr>
            <td>
                <div class="table-cell-with-avatar">
                    <div class="cell-avatar">${renderAvatar(driver.profilePhotoUrl, driver.name)}</div>
                    <div class="cell-stack">
                        <strong>${escapeHtml(driver.name)}</strong>
                        <small>${escapeHtml(driver.wilaya || '')}</small>
                    </div>
                </div>
            </td>
            <td class="text-sm">
                <div class="cell-stack">
                    <span>${escapeHtml(driver.phone)}</span>
                    <small>${escapeHtml(driver.email)}</small>
                </div>
            </td>
            <td class="text-sm">${escapeHtml([driver.vehicleMake, driver.vehicleModel].filter(Boolean).join(' ') || '—')}</td>
            <td><span class="status-badge status-${driverStatusClass(driver.status)}">${escapeHtml(driver.status)}</span></td>
            <td class="text-sm">${escapeHtml(formatDate(driver.registrationDate))}</td>
            <td><button type="button" class="btn btn-sm" data-driver-id="${escapeAttr(driver.id)}" data-action="view">${escapeHtml(t('common.viewAll', 'View'))}</button></td>
        </tr>
    `).join('');
    tbody.querySelectorAll('[data-action="view"]').forEach(btn => {
        btn.addEventListener('click', () => openDriverModal(btn.getAttribute('data-driver-id')));
    });
}

// ---------------- Rides page ----------------
function renderRidesPage() {
    const tbody = document.getElementById('ridesTable');
    if (!tbody) return;
    const filtered = rides.filter(ride => {
        const status = getEffectiveRideStatus(ride);
        if (rideTableFilter !== 'all' && status !== rideTableFilter) return false;
        if (!rideSearchQuery) return true;
        const hay = `${getRideChildName(ride)} ${ride.driverName} ${ride.pickup} ${ride.dropoff}`.toLowerCase();
        return hay.includes(rideSearchQuery);
    });
    if (!filtered.length) {
        tbody.innerHTML = `<tr class="empty-row"><td colspan="8">${escapeHtml(t('common.noData', 'No rides'))}</td></tr>`;
        return;
    }
    tbody.innerHTML = filtered.map(ride => {
        const assigned = isRideAssigned(ride);
        const status = getEffectiveRideStatus(ride);
        const actionLabel = assigned ? t('assign.change', 'Change') : t('assign.assign', 'Assign');
        return `
            <tr>
                <td><strong>${escapeHtml(getRideChildName(ride))}</strong></td>
                <td class="text-sm">${escapeHtml(ride.day)}</td>
                <td class="text-sm">${escapeHtml(ride.driverName)}</td>
                <td class="text-sm">${escapeHtml(ride.pickup)}</td>
                <td class="text-sm">${escapeHtml(ride.dropoff)}</td>
                <td class="text-sm">${escapeHtml(ride.time)}</td>
                <td><span class="status-badge status-${rideStatusClass(status)}">${escapeHtml(status)}</span></td>
                <td><button type="button" class="btn btn-sm btn-primary" data-ride-id="${escapeAttr(ride.id)}" data-action="assign">${escapeHtml(actionLabel)}</button></td>
            </tr>
        `;
    }).join('');
    tbody.querySelectorAll('[data-action="assign"]').forEach(btn => {
        btn.addEventListener('click', () => openAssignDriverModal(btn.getAttribute('data-ride-id')));
    });
}

// ---------------- Dispatch page ----------------
function renderDispatchPage() {
    const tbody = document.getElementById('dispatchTable');
    if (!tbody) return;
    const unassigned = rides.filter(r => !isRideAssigned(r));
    const summary = document.getElementById('dispatchSummary');
    if (summary) summary.textContent = `${unassigned.length} / ${rides.length}`;
    if (!unassigned.length) {
        tbody.innerHTML = `<tr class="empty-row"><td colspan="6">${escapeHtml(t('dispatch.noUnassigned', 'All rides have a driver assigned.'))}</td></tr>`;
        return;
    }
    tbody.innerHTML = unassigned.map(ride => {
        const candidates = window.dispatcher
            ? window.dispatcher.scoreCandidates(drivers, ride, rides)
            : [];
        const top = candidates[0];
        const topLabel = top
            ? `${escapeHtml(top.driver.name || 'Driver')} · ${top.distKm != null ? top.distKm.toFixed(1) + ' km' : '—'} · ${Math.round(top.score * 100)}%`
            : '<span class="text-muted">—</span>';
        return `
            <tr>
                <td><strong>${escapeHtml(getRideChildName(ride))}</strong></td>
                <td class="text-sm">${escapeHtml(ride.day)}</td>
                <td class="text-sm">${escapeHtml(ride.pickup)}</td>
                <td class="text-sm">${escapeHtml(ride.time)}</td>
                <td class="text-sm">${topLabel}</td>
                <td><button type="button" class="btn btn-sm btn-primary" data-ride-id="${escapeAttr(ride.id)}" data-action="assign">${escapeHtml(t('dispatch.assign', 'Assign'))}</button></td>
            </tr>
        `;
    }).join('');
    tbody.querySelectorAll('[data-action="assign"]').forEach(btn => {
        btn.addEventListener('click', () => openAssignDriverModal(btn.getAttribute('data-ride-id')));
    });
}

// ---------------- Children page ----------------
function renderChildrenPage() {
    const tbody = document.getElementById('childrenTable');
    if (!tbody) return;
    const q = String(document.getElementById('childSearch')?.value || '').trim().toLowerCase();
    const filtered = children.filter(child => {
        if (!q) return true;
        return `${child.name} ${child.parent} ${child.parentPhone}`.toLowerCase().includes(q);
    });
    if (!filtered.length) {
        tbody.innerHTML = `<tr class="empty-row"><td colspan="4">${escapeHtml(t('common.noData', 'No children'))}</td></tr>`;
        return;
    }
    tbody.innerHTML = filtered.map(child => `
        <tr>
            <td>
                <div class="table-cell-with-avatar">
                    <div class="cell-avatar">${renderAvatar(child.photoUrl, child.name)}</div>
                    <strong>${escapeHtml(child.name)}</strong>
                </div>
            </td>
            <td class="text-sm">${escapeHtml(String(child.age))}</td>
            <td class="text-sm">${escapeHtml(child.parent)}</td>
            <td class="text-sm">${escapeHtml(child.parentPhone)}</td>
        </tr>
    `).join('');
}

// ---------------- Online drivers side panel ----------------
function renderOnlineDrivers() {
    const list = document.getElementById('onlineDriversList');
    const count = document.getElementById('onlineDriversCount');
    if (!list) return;
    const online = drivers.filter(d => d.isOnline);
    if (count) count.textContent = String(online.length);
    if (!online.length) {
        list.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-wifi"></i>
                <h3>${escapeHtml(t('common.noData', 'No drivers online'))}</h3>
            </div>`;
        return;
    }
    list.innerHTML = online.map(driver => {
        const state = driver.canReceiveTrips !== false ? 'online' : 'idle';
        const seats = Number.isFinite(Number(driver.availableSeats)) ? `${driver.availableSeats} seats` : '';
        return `
            <div class="assign-driver-row" style="grid-template-columns: auto 1fr auto; cursor: pointer;" data-driver-id="${escapeAttr(driver.id)}" role="button" tabindex="0">
                <span class="pin pin-driver-${state}" style="transform: none; border-radius: 50%; width: 10px; height: 10px; box-shadow: none; border: 0;"></span>
                <div class="driver-main">
                    <div class="driver-name">${escapeHtml(driver.name)}</div>
                    <div class="driver-sub">${escapeHtml([driver.vehicleMake, driver.vehicleModel].filter(Boolean).join(' ') || '—')}</div>
                </div>
                <div class="text-sm">${escapeHtml(seats)}</div>
            </div>`;
    }).join('');
    list.querySelectorAll('[data-driver-id]').forEach(el => {
        el.addEventListener('click', () => openDriverModal(el.getAttribute('data-driver-id')));
    });
}

// ---------------- Driver modal (with tabs including trip history) ----------------
async function openDriverModal(driverId) {
    const driver = drivers.find(d => d.id === driverId);
    if (!driver) return;
    const modal = document.getElementById('driverModal');
    const body = document.getElementById('driverModalBody');
    if (!modal || !body) return;

    body.innerHTML = renderDriverModalSkeleton(driver);

    // Tab switching
    body.querySelectorAll('.detail-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const name = tab.getAttribute('data-tab');
            body.querySelectorAll('.detail-tab').forEach(t => t.classList.toggle('active', t === tab));
            body.querySelectorAll('.detail-tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${name}`));
        });
    });

    body.querySelectorAll('[data-driver-action]').forEach(btn => {
        btn.addEventListener('click', () => onDriverActionClick(driver, btn.getAttribute('data-driver-action')));
    });

    modal.classList.add('active');
    loadDriverTripHistory(driver.__docId || driver.id);
}

function renderDriverModalSkeleton(driver) {
    return `
        <div class="driver-modal-top">
            <div class="driver-photo">${renderAvatar(driver.profilePhotoUrl, driver.name)}</div>
            <div class="driver-heading">
                <h3>${escapeHtml(driver.name)}</h3>
                <small>${escapeHtml(driver.email)} · ${escapeHtml(driver.phone)}</small>
                <div style="display:flex; gap:6px; margin-top:4px;">
                    <span class="status-badge status-${driverStatusClass(driver.status)}">${escapeHtml(driver.status)}</span>
                    ${driver.isOnline ? '<span class="badge badge-info">Online</span>' : ''}
                    ${driver.canReceiveTrips !== false ? '' : '<span class="badge-neutral badge">Paused</span>'}
                </div>
            </div>
            <div style="margin-inline-start:auto; display:flex; gap:6px;">
                ${driver.status !== 'approved' ? `<button type="button" class="btn btn-sm btn-success" data-driver-action="approve">${escapeHtml(t('driver.approve', 'Approve'))}</button>` : ''}
                ${driver.status !== 'rejected' ? `<button type="button" class="btn btn-sm btn-danger" data-driver-action="reject">${escapeHtml(t('driver.reject', 'Reject'))}</button>` : ''}
            </div>
        </div>

        <div class="detail-tabs" role="tablist">
            <button type="button" class="detail-tab active" data-tab="profile">${escapeHtml(t('driver.profile', 'Profile'))}</button>
            <button type="button" class="detail-tab" data-tab="vehicle">${escapeHtml(t('driver.vehicle', 'Vehicle & License'))}</button>
            <button type="button" class="detail-tab" data-tab="kyc">${escapeHtml(t('driver.kyc', 'KYC'))}</button>
            <button type="button" class="detail-tab" data-tab="history">${escapeHtml(t('driver.history', 'Trip History'))}</button>
        </div>

        <div class="detail-tab-content active" id="tab-profile">
            <div class="info-grid">
                ${infoItem('First name', driver.firstName)}
                ${infoItem('Last name', driver.lastName)}
                ${infoItem('Gender', driver.gender)}
                ${infoItem('Blood type', driver.bloodType)}
                ${infoItem('Family status', driver.familyStatus)}
                ${infoItem('National ID', driver.nationalId)}
                ${infoItem('Date of birth', driver.dateOfBirth ? formatDate(driver.dateOfBirth) : '')}
                ${infoItem('Wilaya', driver.wilaya)}
                ${infoItem('Baladia', driver.baladia)}
                ${infoItem('Address', driver.address)}
                ${infoItem('Registered', formatDateTime(driver.registrationDate))}
                ${infoItem('Available seats', driver.availableSeats)}
            </div>
        </div>

        <div class="detail-tab-content" id="tab-vehicle">
            <div class="info-grid">
                ${infoItem('Make', driver.vehicleMake)}
                ${infoItem('Model', driver.vehicleModel)}
                ${infoItem('Year', driver.vehicleYear)}
                ${infoItem('Color', driver.vehicleColor)}
                ${infoItem('Plate', driver.vehiclePlate)}
                ${infoItem('License number', driver.licenseNumber)}
                ${infoItem('License category', driver.licenseCategory)}
                ${infoItem('License expiry', driver.licenseExpiryDate ? formatDate(driver.licenseExpiryDate) : '')}
            </div>
            <div style="margin-top: 16px; display:grid; grid-template-columns: 1fr 1fr; gap:12px;">
                ${renderLicenseImage('License front', driver.licenseFrontUrl)}
                ${renderLicenseImage('License back', driver.licenseBackUrl)}
            </div>
        </div>

        <div class="detail-tab-content" id="tab-kyc">
            ${kycDoc('Grey card', driver.greyCardPhotoUrl, driver.greyCardRegistration, driver.greyCardVerified)}
            ${kycDoc('Judicial record', driver.judicialRecordPhotoUrl, driver.judicialRecordIssueDate && 'Issued ' + formatDate(driver.judicialRecordIssueDate), driver.judicialRecordVerified)}
            ${kycDoc('Medical certificate', driver.medicalCertPhotoUrl, driver.medicalCertDoctor || (driver.medicalCertIssueDate ? 'Issued ' + formatDate(driver.medicalCertIssueDate) : ''), driver.medicalCertVerified)}
            ${driver.kycNotes ? `<div class="info-item" style="margin-top:12px;"><div class="info-label">Notes</div><div class="info-value">${escapeHtml(driver.kycNotes)}</div></div>` : ''}
        </div>

        <div class="detail-tab-content" id="tab-history">
            <div id="tripHistoryContainer">
                <div class="loading-row"><div class="loading-spinner"></div></div>
            </div>
        </div>
    `;
}

function infoItem(label, value) {
    const v = value == null || value === '' ? t('common.notAvailable', 'N/A') : value;
    return `
        <div class="info-item">
            <div class="info-label">${escapeHtml(label)}</div>
            <div class="info-value">${escapeHtml(String(v))}</div>
        </div>`;
}

function renderLicenseImage(label, url) {
    if (!url) {
        return `<div class="info-item"><div class="info-label">${escapeHtml(label)}</div><div class="info-value text-muted">${escapeHtml(t('common.notAvailable', 'N/A'))}</div></div>`;
    }
    return `
        <div class="info-item" style="padding:0; overflow:hidden;">
            <img src="${escapeAttr(url)}" alt="${escapeAttr(label)}" style="width:100%; height:160px; object-fit:cover; border-radius: var(--r-md) var(--r-md) 0 0; background: var(--bg-app);" loading="lazy" onerror="this.remove();">
            <div style="padding: 8px 12px;">
                <div class="info-label">${escapeHtml(label)}</div>
                <a href="${escapeAttr(url)}" target="_blank" rel="noopener">Open</a>
            </div>
        </div>`;
}

function kycDoc(label, url, subtitle, verified) {
    const img = url
        ? `<img src="${escapeAttr(url)}" alt="${escapeAttr(label)}" loading="lazy" onerror="this.style.display='none'">`
        : `<div style="width:64px;height:64px;background:var(--bg-app);border-radius:var(--r-sm);display:grid;place-items:center;color:var(--text-muted);"><i class="fas fa-file"></i></div>`;
    return `
        <div class="kyc-doc">
            ${img}
            <div class="kyc-doc-stack">
                <strong>${escapeHtml(label)}</strong>
                ${subtitle ? `<small>${escapeHtml(subtitle)}</small>` : ''}
                <span class="badge ${verified ? 'badge-approved' : 'badge-neutral'}" style="margin-top:4px; align-self:flex-start;">${verified ? 'Verified' : 'Unverified'}</span>
            </div>
            ${url ? `<a class="btn btn-sm" href="${escapeAttr(url)}" target="_blank" rel="noopener">Open</a>` : ''}
        </div>
    `;
}

async function loadDriverTripHistory(driverId) {
    const container = document.getElementById('tripHistoryContainer');
    if (!container) return;
    const reqId = ++pendingTripHistoryReq;

    if (!firestore || !driverId) {
        container.innerHTML = renderTripHistoryList([]);
        return;
    }
    try {
        const snap = await firestore
            .collection('drivers').doc(driverId)
            .collection('trip_history')
            .orderBy('completedAt', 'desc')
            .limit(50)
            .get()
            .catch(async () => {
                // Fall back without orderBy if the index is missing
                return firestore.collection('drivers').doc(driverId).collection('trip_history').limit(50).get();
            });
        if (reqId !== pendingTripHistoryReq) return; // stale
        const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        items.sort((a, b) => {
            const ta = toMillis(a.completedAt) || 0;
            const tb = toMillis(b.completedAt) || 0;
            return tb - ta;
        });
        container.innerHTML = renderTripHistoryList(items);
    } catch (err) {
        console.error('Failed to load trip_history:', err);
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-triangle-exclamation"></i>
                <h3>Failed to load trip history</h3>
                <p>${escapeHtml(err.message || String(err))}</p>
            </div>`;
    }
}

function toMillis(v) {
    if (!v) return 0;
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v.toDate === 'function') return v.toDate().getTime();
    if (v instanceof Date) return v.getTime();
    const n = Date.parse(v);
    return Number.isFinite(n) ? n : 0;
}

function renderTripHistoryList(items) {
    if (!items.length) {
        return `
            <div class="empty-state">
                <i class="fas fa-clock-rotate-left"></i>
                <h3>${escapeHtml(t('driver.noHistory', 'No completed trips yet.'))}</h3>
            </div>`;
    }
    return `<div class="trip-history-list">${
        items.map(trip => `
            <div class="trip-history-item">
                <div class="day-pill">${escapeHtml(trip.day || '—')}</div>
                <div class="trip-body">
                    <div class="trip-title">
                        <i class="fas fa-child" style="color: var(--primary);"></i>
                        ${escapeHtml(trip.childName || 'Child')}
                        <span class="status-badge status-${rideStatusClass(trip.status || 'completed')}" style="margin-inline-start:auto;">${escapeHtml(trip.status || 'completed')}</span>
                    </div>
                    <div class="trip-route">
                        <i class="fas fa-circle"></i> ${escapeHtml(trip.pickup || '—')}
                        <span class="text-muted" style="margin: 0 4px;">→</span>
                        <i class="fas fa-flag" style="color: var(--danger-500);"></i> ${escapeHtml(trip.dropoff || '—')}
                    </div>
                    <div class="trip-meta">
                        <span><i class="fas fa-user"></i> ${escapeHtml(trip.parentName || '—')}</span>
                        <span><i class="fas fa-clock"></i> ${escapeHtml(trip.pickupTime || '—')}</span>
                        <span><i class="fas fa-calendar-check"></i> ${escapeHtml(formatDateTime(trip.completedAt))}</span>
                    </div>
                </div>
            </div>
        `).join('')
    }</div>`;
}

async function onDriverActionClick(driver, action) {
    if (!isAdmin || !firestore) {
        showToast({ title: t('toast.loginRequired', 'Only admins can perform this action.'), variant: 'error' });
        return;
    }
    const docId = driver.__docId || driver.id;
    const ref = firestore.collection('drivers').doc(docId);
    try {
        if (action === 'approve') {
            await ref.update({ isApproved: true, status: 'approved', 'kyc.status': 'verified', 'kyc.reviewedAt': new Date().toISOString() });
            showToast({ title: t('toast.approved', 'Driver approved'), variant: 'success' });
        } else if (action === 'reject') {
            await ref.update({ isApproved: false, status: 'rejected', 'kyc.status': 'rejected', 'kyc.reviewedAt': new Date().toISOString() });
            showToast({ title: t('toast.rejected', 'Driver rejected'), variant: 'success' });
        }
        document.getElementById('driverModal')?.classList.remove('active');
        refreshDataFromFirestore();
    } catch (err) {
        console.error(err);
        showToast({ title: 'Action failed', body: err.message || '', variant: 'error' });
    }
}

// ---------------- Assign driver modal (with scored list + map preview) ----------------
function openAssignDriverModal(rideId) {
    if (!isAdmin) {
        showToast({ title: t('toast.loginRequired', 'Only admins can perform this action.'), variant: 'error' });
    }
    const ride = rides.find(r => r.id === rideId);
    if (!ride) return;

    const modal = document.getElementById('assignDriverModal');
    modal?.setAttribute('data-ride-id', rideId);
    const allowModify = document.getElementById('assignAllowModify');
    if (allowModify) allowModify.checked = false;
    const modifyWrap = document.getElementById('assignModifyWrap');
    const alreadyAssigned = isRideAssigned(ride);
    if (modifyWrap) modifyWrap.hidden = !alreadyAssigned;

    const parentContact = getRideParentContact(ride);
    const meta = document.getElementById('assignRideMeta');
    let line = `<strong>${escapeHtml(getRideChildName(ride))}</strong> · ${escapeHtml(parentContact.name)} (${escapeHtml(parentContact.phone)})<br>
                <span class="text-muted text-sm">${escapeHtml(ride.day)} · ${escapeHtml(ride.time)} · ${escapeHtml(ride.pickup)} → ${escapeHtml(ride.dropoff)}</span>`;
    if (ride.pickupLat == null || ride.pickupLng == null) {
        line += `<br><span class="badge badge-neutral">${escapeHtml(t('assign.noCoords', 'Pickup coordinates missing'))}</span>`;
    }
    if (alreadyAssigned) {
        const currentDriver = drivers.find(d => String(d.id) === String(getRideAssignedDriverId(ride)));
        const currentName = currentDriver?.name || ride.driverName || 'Assigned';
        line += `<br><span class="badge badge-info">Current: ${escapeHtml(currentName)}</span>`;
    }
    if (meta) meta.innerHTML = line;

    modal?.classList.add('active');
    renderAssignDriverList(rideId);
}

function closeAssignDriverModal() {
    const modal = document.getElementById('assignDriverModal');
    modal?.classList.remove('active');
    modal?.removeAttribute('data-ride-id');
    const allowModify = document.getElementById('assignAllowModify');
    if (allowModify) allowModify.checked = false;
    const modifyWrap = document.getElementById('assignModifyWrap');
    if (modifyWrap) modifyWrap.hidden = true;
    if (window.fleetMap) window.fleetMap.destroyAssignMap();
}

function isAssignModifyEnabled(rideId) {
    const modal = document.getElementById('assignDriverModal');
    const activeRideId = modal?.getAttribute('data-ride-id');
    const enabled = document.getElementById('assignAllowModify')?.checked === true;
    return modal?.classList.contains('active') && activeRideId === rideId && enabled;
}

function renderAssignDriverList(rideId) {
    const ride = rides.find(r => r.id === rideId);
    if (!ride) return;
    const candidates = window.dispatcher
        ? window.dispatcher.scoreCandidates(drivers, ride, rides)
        : [];
    const el = document.getElementById('assignDriverList');
    if (!el) return;
    const assignedDriverId = getRideAssignedDriverId(ride);
    const alreadyAssigned = isRideAssigned(ride);
    const canModify = document.getElementById('assignAllowModify')?.checked === true;
    const locked = alreadyAssigned && !canModify;

    if (!candidates.length) {
        el.innerHTML = `<div class="empty-state"><i class="fas fa-user-slash"></i><h3>${escapeHtml(t('assign.noDrivers', 'No approved drivers available.'))}</h3></div>`;
        if (window.fleetMap) window.fleetMap.initAssignMap(ride, []);
        return;
    }

    el.innerHTML = candidates.map((c, index) => {
        const driver = c.driver;
        const isCurrent = assignedDriverId && String(driver.id) === String(assignedDriverId);
        const topPick = index === 0;
        const distLabel = c.distKm == null ? '—' : `${c.distKm.toFixed(1)} km`;
        const chips = window.dispatcher
            ? window.dispatcher.explainRow(c).map(chip => `<span class="chip">${escapeHtml(chip)}</span>`).join('')
            : '';
        const tags = [];
        if (topPick) tags.push(`<span class="status-badge status-approved">${escapeHtml(t('assign.top', 'Top pick'))}</span>`);
        if (isCurrent) tags.push(`<span class="status-badge status-scheduled">${escapeHtml(t('assign.current', 'Current'))}</span>`);

        let actionBtn;
        if (isCurrent) {
            actionBtn = `<button type="button" class="btn btn-sm btn-success" disabled>${escapeHtml(t('assign.assigned', 'Assigned'))}</button>`;
        } else if (locked) {
            actionBtn = `<button type="button" class="btn btn-sm btn-primary" disabled title="Enable modify">${escapeHtml(t('assign.assign', 'Assign'))}</button>`;
        } else {
            const label = alreadyAssigned ? t('assign.change', 'Change') : t('assign.assign', 'Assign');
            actionBtn = `<button type="button" class="btn btn-sm btn-primary" data-assign-pick data-ride-id="${escapeAttr(ride.id)}" data-driver-id="${escapeAttr(driver.id)}">${escapeHtml(label)}</button>`;
        }

        return `
            <div class="assign-driver-row ${topPick ? 'top-pick' : ''}">
                <div class="cell-avatar">${renderAvatar(driver.profilePhotoUrl, driver.name)}</div>
                <div class="driver-main">
                    <div class="driver-name">${escapeHtml(driver.name)} ${tags.join(' ')}</div>
                    <div class="driver-sub">${escapeHtml(driver.phone)} · ${escapeHtml([driver.vehicleMake, driver.vehicleModel].filter(Boolean).join(' ') || '—')}</div>
                    <div class="driver-explain">${chips}</div>
                </div>
                <div>
                    <div class="dist">${escapeHtml(distLabel)}</div>
                    <div class="score-bar" title="Score ${Math.round(c.score * 100)}%"><div style="width: ${Math.round(c.score * 100)}%"></div></div>
                </div>
                ${actionBtn}
            </div>`;
    }).join('');

    if (window.fleetMap) window.fleetMap.initAssignMap(ride, candidates);
}

async function assignDriverToRide(rideId, driverId) {
    if (!rideId || !driverId) return;
    const ride = rides.find(r => r.id === rideId);
    const driver = drivers.find(d => d.id === driverId);
    if (!ride || !driver) {
        showToast({ title: 'Ride or driver not found.', variant: 'error' });
        return;
    }
    const existingDriverId = getRideAssignedDriverId(ride);
    const isReassign = Boolean(existingDriverId) && String(existingDriverId) !== String(driver.id);
    const modifyEnabled = isAssignModifyEnabled(rideId);
    if (isReassign && !modifyEnabled) {
        showToast({ title: 'Enable modify to change driver.', variant: 'warn' });
        return;
    }
    if (existingDriverId && String(existingDriverId) === String(driver.id)) {
        showToast({ title: 'Driver already assigned.', variant: 'warn' });
        return;
    }
    if (!driver.isApproved || driver.status === 'rejected') {
        showToast({ title: 'Only approved drivers can be assigned.', variant: 'error' });
        return;
    }
    if (typeof driver.availableSeats === 'number' && driver.availableSeats <= 0) {
        showToast({ title: 'Driver has no available seats.', variant: 'error' });
        return;
    }

    if (!isAdmin || !firestore) {
        // Sample/offline mode: mutate in place
        const previousDriverId = existingDriverId;
        ride.driverId = driverId;
        ride.driverName = driver.name;
        ride.status = 'accepted';
        if (typeof driver.availableSeats === 'number') {
            driver.availableSeats = Math.max(0, driver.availableSeats - 1);
        }
        if (previousDriverId && previousDriverId !== driverId) {
            const prev = drivers.find(d => d.id === previousDriverId);
            if (prev && typeof prev.availableSeats === 'number') prev.availableSeats += 1;
        }
        showToast({ title: t('toast.assigned', 'Driver assigned'), variant: 'success' });
        closeAssignDriverModal();
        renderAll();
        return;
    }

    try {
        const driverDocId = String(driver.__docId || driver.id).trim();
        const acceptedAt = new Date().toISOString();
        const parentId = ride.parentId;
        const childId = ride.childId;
        const day = ride.day;
        const tripIndex = Number(ride.tripIndex);

        if (!parentId || !childId || !day || !Number.isInteger(tripIndex)) {
            showToast({ title: 'Missing ride identifiers.', variant: 'error' });
            return;
        }

        await firestore.runTransaction(async (tx) => {
            const scheduleRef = firestore
                .collection('parents').doc(parentId)
                .collection('children').doc(childId)
                .collection('schedules').doc(day);
            const driverRef = firestore.collection('drivers').doc(driverDocId);

            const [scheduleSnap, driverSnap] = await Promise.all([tx.get(scheduleRef), tx.get(driverRef)]);
            if (!scheduleSnap.exists) throw new Error('Schedule document not found.');
            if (!driverSnap.exists)  throw new Error('Driver not found.');

            const trips = (scheduleSnap.data().trips || []).slice();
            const trip = trips[tripIndex];
            if (!trip || typeof trip !== 'object') throw new Error('Trip item not found.');

            const currentTripDriverId = String(trip.assignedDriverId || trip.driverId || '').trim();
            if (currentTripDriverId && currentTripDriverId === driverDocId) {
                throw new Error('This driver is already assigned to this trip.');
            }
            if (currentTripDriverId && currentTripDriverId !== driverDocId && !isAssignModifyEnabled(ride.id)) {
                throw new Error('Reassign is locked for this trip.');
            }

            trips[tripIndex] = {
                ...trip,
                driverId: driverDocId,
                assignedDriverId: driverDocId,
                status: 'accepted',
                isAssignedDriver: true,
            };

            const driverData = driverSnap.data() || {};
            const currentSeats = Number(driverData.availableSeats != null ? driverData.availableSeats : driverData.capacity);
            if (!Number.isFinite(currentSeats) || currentSeats <= 0) {
                throw new Error('Driver has no available seats.');
            }

            let previousDriverRef = null;
            let previousDriverSnap = null;
            if (currentTripDriverId && currentTripDriverId !== driverDocId) {
                previousDriverRef = firestore.collection('drivers').doc(currentTripDriverId);
                previousDriverSnap = await tx.get(previousDriverRef);
            }
            const previousSeats = previousDriverSnap?.exists
                ? Number(previousDriverSnap.data()?.availableSeats ?? NaN)
                : NaN;

            tx.update(scheduleRef, { trips });
            tx.update(driverRef, { availableSeats: currentSeats - 1 });
            if (previousDriverRef && previousDriverSnap?.exists) {
                tx.update(previousDriverRef, {
                    availableSeats: Number.isFinite(previousSeats) ? previousSeats + 1 : 1,
                });
            }
        });

        try {
            const tripRequest = {
                acceptedAt,
                childId,
                childSnapshot: {
                    age: ride.childAge || null,
                    fullName: ride.childName || '',
                    photoUrl: ride.childPhotoUrl || null,
                },
                createdAt: new Date().toISOString(),
                day,
                driverId: driverDocId,
                dropoff: ride.dropoff || '',
                parentId,
                parentSnapshot: {
                    fullName: ride.parentName || '',
                    phone: ride.parentPhone || '',
                },
                pickup: ride.pickup || '',
                pickupTime: ride.time || '',
                tripIndex,
                status: 'accepted',
                pickupLocation: ride.pickupLocationFull || {},
                dropoffLocation: ride.dropoffLocationFull || {},
                idTrip: ride.idTrip || '',
                type: ride.tripType || 'other',
                from: ride.fromLabel || ride.pickup || '',
                to: ride.toLabel || ride.dropoff || '',
                isPaused: ride.isPaused || false,
                isActive: ride.isScheduleActive !== false,
            };
            const docRef = await firestore.collection('trip_requests').add(tripRequest);
            await docRef.update({ id: docRef.id });
        } catch (tripReqErr) {
            console.warn('Failed to create trip_request document:', tripReqErr);
        }

        showToast({ title: t('toast.assigned', 'Driver assigned'), variant: 'success' });
        closeAssignDriverModal();
        await refreshDataFromFirestore();
    } catch (err) {
        console.error(err);
        showToast({ title: t('toast.assignFailed', 'Failed to assign driver'), body: err.message || '', variant: 'error' });
    }
}

// ---------------- Dispatch settings sliders ----------------
function setupDispatchSettingsUI() {
    const fields = [
        ['wDistance',  'distance'],
        ['wLocality',  'locality'],
        ['wRating',    'rating'],
        ['wFreshness', 'freshness'],
        ['wWorkload',  'workload'],
    ];
    if (!window.dispatcher) return;

    const weights = window.dispatcher.getWeights();
    const total = Object.values(weights).reduce((s, v) => s + v, 0) || 1;
    fields.forEach(([inputId, key]) => {
        const input = document.getElementById(inputId);
        if (!input) return;
        const pct = Math.round((weights[key] / total) * 100);
        input.value = pct;
        const valEl = document.getElementById(`${inputId}Val`);
        if (valEl) valEl.textContent = `${pct}%`;
        input.addEventListener('input', () => {
            if (valEl) valEl.textContent = `${input.value}%`;
            persistDispatchWeights();
        });
    });
}

function persistDispatchWeights() {
    if (!window.dispatcher) return;
    const next = {
        distance:  Number(document.getElementById('wDistance')?.value || 0) / 100,
        locality:  Number(document.getElementById('wLocality')?.value || 0) / 100,
        rating:    Number(document.getElementById('wRating')?.value || 0) / 100,
        freshness: Number(document.getElementById('wFreshness')?.value || 0) / 100,
        workload:  Number(document.getElementById('wWorkload')?.value || 0) / 100,
    };
    window.dispatcher.saveWeights(next);
    renderDispatchPage();
}
