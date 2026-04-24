// this is newwer version

// Data arrays
let drivers = [];
let rides = [];
let children = [];

// Sample data removed - login required to access real Firebase data
const PAGE_TITLES = Object.freeze({
    dashboard: 'Dashboard',
    drivers: 'Drivers',
    rides: 'Rides',
    children: 'Children',
    settings: 'Settings'
});
const DEFAULT_PAGE = 'dashboard';
const LIVE_DATA_COLLECTIONS = Object.freeze(['drivers', 'trip_requests', 'parents']);

// Initialization and UI Logic
document.addEventListener('DOMContentLoaded', async () => {
    initializeNavigation();
    initializeTheme();
    setupEventListeners();
    
    // Show login modal initially
    const loginModal = document.getElementById('loginModal');
    const pageContent = document.getElementById('pageContent');
    if (loginModal) loginModal.classList.add('active');
    if (pageContent) pageContent.style.display = 'none';
    
    await initFirebase();
});

function loadDashboard() {
    const hashPage = window.location.hash.replace('#', '');
    const initialPage = normalizePage(hashPage || DEFAULT_PAGE);
    switchPage(initialPage, { refreshData: true, updateHash: Boolean(hashPage) });
}


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

function collectAssignedDriverIdsFromTripRequest(tripRequest) {
    const ids = new Set();
    const addId = (value) => {
        const id = String(value ?? '').trim();
        if (id) ids.add(id);
    };
    const addFromTrip = (trip) => {
        if (!trip || typeof trip !== 'object') return;
        addId(trip.assignedDriverId || trip.driverId);
    };
    const addFromScheduleArray = (items) => {
        if (!Array.isArray(items)) return;
        items.forEach(day => {
            if (!day || typeof day !== 'object' || !Array.isArray(day.trips)) return;
            day.trips.forEach(addFromTrip);
        });
    };

    if (!tripRequest || typeof tripRequest !== 'object') return [];

    if (Array.isArray(tripRequest.trips)) {
        tripRequest.trips.forEach(addFromTrip);
    }
    addFromScheduleArray(tripRequest.schedule);
    addFromScheduleArray(tripRequest.days);

    if (tripRequest.activeTrip && typeof tripRequest.activeTrip === 'object') {
        addId(tripRequest.activeTrip.assignedDriverId || tripRequest.activeTrip.driverId);
    }

    return Array.from(ids);
}

function isRideAssigned(ride) {
    const assignedId = getRideAssignedDriverId(ride);
    if (assignedId) return true;
    const driverName = String(ride?.driverName || '').trim();
    return Boolean(driverName) && !/^pending driver$/i.test(driverName);
}

function getRideParentContact(ride) {
    if (!ride || typeof ride !== 'object') {
        return { name: 'Unknown Parent', phone: 'N/A' };
    }
    if (ride.childId) {
        const child = children.find(c => c.id === ride.childId);
        if (child) {
            return {
                name: child.parent || 'Unknown Parent',
                phone: child.parentPhone || 'N/A'
            };
        }
    }
    return {
        name: ride.parent?.fullName || ride.parent?.name || 'Unknown Parent',
        phone: ride.parent?.phone || 'N/A'
    };
}

function makeTripRideKey(parentId, childId, day, tripIndex) {
    if (tripIndex == null || tripIndex === '') return '';
    const parsedIndex = Number(tripIndex);
    if (!Number.isInteger(parsedIndex) || parsedIndex < 0) return '';
    const parent = String(parentId ?? '').trim();
    const child = String(childId ?? '').trim();
    const dayValue = String(day ?? '').trim();
    if (!parent || !child || !dayValue) return '';
    return `${parent}_${child}_${dayValue}_${parsedIndex}`;
}

function getTripRequestTimeValue(tripRequest) {
    if (!tripRequest || typeof tripRequest !== 'object') return 0;
    const candidates = [tripRequest.acceptedAt, tripRequest.createdAt, tripRequest.updatedAt];
    let newest = 0;
    for (const value of candidates) {
        if (!value) continue;
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed) && parsed > newest) {
            newest = parsed;
        }
    }
    return newest;
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

function clearLiveDataSubscriptions() {
    liveDataUnsubscribers.forEach(unsubscribe => {
        try {
            if (typeof unsubscribe === 'function') unsubscribe();
        } catch (err) {
            console.warn('Unable to unsubscribe from live data listener:', err);
        }
    });
    liveDataUnsubscribers = [];

    if (liveRefreshTimer) {
        clearTimeout(liveRefreshTimer);
        liveRefreshTimer = null;
    }
    isFetchingFirestoreData = false;
    hasQueuedFirestoreRefresh = false;
}

function scheduleFirestoreRefresh(delayMs = 160) {
    if (!isAdmin || !firestore) return;
    if (liveRefreshTimer) clearTimeout(liveRefreshTimer);
    liveRefreshTimer = setTimeout(() => {
        liveRefreshTimer = null;
        refreshDataFromFirestore();
    }, delayMs);
}

async function refreshDataFromFirestore() {
    if (!isAdmin || !firestore) return;
    if (isFetchingFirestoreData) {
        hasQueuedFirestoreRefresh = true;
        return;
    }
    isFetchingFirestoreData = true;
    try {
        await fetchDataFromFirestore();
    } finally {
        isFetchingFirestoreData = false;
        if (hasQueuedFirestoreRefresh) {
            hasQueuedFirestoreRefresh = false;
            scheduleFirestoreRefresh(0);
        }
    }
}

function initializeLiveDataSubscriptions() {
    if (!isAdmin || !firestore || typeof firestore.collection !== 'function') return;
    clearLiveDataSubscriptions();

    LIVE_DATA_COLLECTIONS.forEach(collectionName => {
        const unsubscribe = firestore.collection(collectionName).onSnapshot(
            () => {
                scheduleFirestoreRefresh();
            },
            (err) => {
                console.error(`Live listener failed for "${collectionName}":`, err);
            }
        );
        liveDataUnsubscribers.push(unsubscribe);
    });

    if (typeof firestore.collectionGroup === 'function') {
        const childrenUnsubscribe = firestore.collectionGroup('children').onSnapshot(
            () => {
                scheduleFirestoreRefresh();
            },
            (err) => {
                console.error('Live listener failed for "children" collection group:', err);
            }
        );
        liveDataUnsubscribers.push(childrenUnsubscribe);
    }
}

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

        if (firebase.auth) {
            firebase.auth().onAuthStateChanged(async (user) => {
                currentUser = user;
                updateAuthUI(user);
                
                if (user) {
                    try {
                        const idTokenResult = await user.getIdTokenResult();
                        // Check if the custom claim 'admin' is true
                        // Change this block in script.js:
                        if ((idTokenResult?.claims?.admin === true) || user.uid === 'XNSrFLevivdIrzTg4exZQxiK3162') {
                           isAdmin = true;
                           initializeLiveDataSubscriptions();
                           await refreshDataFromFirestore();
                        } else {
                           isAdmin = false;
                           clearLiveDataSubscriptions();
                           alert("You are logged in, but you do not have Admin privileges.");
                           useSampleData();
                        }

                    } catch (e) {
                        isAdmin = false;
                        console.error('Admin check failed:', e);
                        clearLiveDataSubscriptions();
                        useSampleData();
                    }
                } else {
                    isAdmin = false;
                    clearLiveDataSubscriptions();
                    useSampleData();
                }
            });
        }
    } catch (err) {
        isAdmin = false;
        console.error('Firebase initialization failed:', err);
        useSampleData();
    }
}

function updateAuthUI(user) {
    const signInBtn = document.getElementById('signInBtn');
    const logoutTopBtn = document.getElementById('logoutTopBtn');
    const loginModal = document.getElementById('loginModal');
    const pageContent = document.getElementById('pageContent');
    
    if (user) {
        signInBtn.textContent = user.email;
        signInBtn.style.backgroundColor = 'var(--success)';
        signInBtn.disabled = true;
        logoutTopBtn?.removeAttribute('hidden');
        // Hide login modal and show dashboard
        if (loginModal) loginModal.classList.remove('active');
        if (pageContent) pageContent.style.display = '';
        // Load dashboard when user logs in
        loadDashboard();
    } else {
        signInBtn.textContent = 'Sign In';
        signInBtn.style.backgroundColor = 'var(--primary)';
        signInBtn.disabled = false;
        logoutTopBtn?.setAttribute('hidden', '');
        // Show login modal and hide dashboard
        if (loginModal) loginModal.classList.add('active');
        if (pageContent) pageContent.style.display = 'none';
    }
}

function performLogout() {
    if (!confirm('Are you sure you want to logout?')) return;
    clearLiveDataSubscriptions();
    if (typeof firebase !== 'undefined' && firebase.auth) {
        firebase.auth().signOut();
    }
}
function calculateAge(dob) {
    if (!dob) return 'N/A';
    
    let birthDate;
    // Check if it is a Firestore Timestamp object
    if (typeof dob.toDate === 'function') {
        birthDate = dob.toDate();
    } else {
        // Otherwise, assume it is a standard date string like "YYYY-MM-DD"
        birthDate = new Date(dob);
    }

    // If the date is invalid, return N/A
    if (isNaN(birthDate.getTime())) return 'N/A';

    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDifference = today.getMonth() - birthDate.getMonth();
    
    // If the child hasn't had their birthday yet this year, subtract 1
    if (monthDifference < 0 || (monthDifference === 0 && today.getDate() < birthDate.getDate())) {
        age--;
    }
    
    return age;
}
async function fetchDataFromFirestore() {
    try {
        // 1. Fetch Drivers
        const driversSnap = await firestore.collection('drivers').get();
        drivers = driversSnap.docs.map(doc => normalizeDriverFromFirestore(doc.id, doc.data()));
     
        const driverMap = {}; // This will hold our ID to Name links
        
        driversSnap.forEach(doc => {
            const driverData = doc.data();
            // Assuming the driver's name is saved as 'name' or 'fullName'
            driverMap[doc.id] = driverData.name || driverData.fullName || 'Unknown Driver';
        });

        // 2. Now fetch Trip Requests and flatten schedule into individual rides
// 2. جلب الرحلات من schedules subcollection
rides = [];
const parentsForRidesSnap = await firestore.collection('parents').get();

for (const parentDoc of parentsForRidesSnap.docs) {
    const parentId = parentDoc.id;
    const parentData = parentDoc.data();
    const parentName = parentData.fullName || parentData.name || 'Unknown Parent';
    const parentPhone =
        parentData.phone ||
        parentData.phoneNumber ||
        parentData.mobile ||
        parentData.whatsapp ||
        'N/A';
    
    const childrenForRidesSnap = await parentDoc.ref.collection('children').get();

    for (const childDoc of childrenForRidesSnap.docs) {
        const childId = childDoc.id;
        const childData = childDoc.data();
        const childName = childData.firstName || 'Unknown Child';
        const childAge = calculateAge(childData.dateOfBirth);
        const childPhotoUrl = childData.photoUrl || null;
        
        const schedulesSnap = await childDoc.ref.collection('schedules').get();

        for (const scheduleDoc of schedulesSnap.docs) {
            const scheduleData = scheduleDoc.data();
            const day = scheduleData.day || scheduleDoc.id;
            const trips = scheduleData.trips || [];

            trips.forEach((trip, index) => {
                const tripAssignedDriverId = String(
                    trip.assignedDriverId || trip.driverId || ''
                ).trim();
                const rawStatus = String(trip.status || 'pending').trim().toLowerCase();
                const driverName = tripAssignedDriverId
                    ? driverMap[tripAssignedDriverId] || 'Unknown Driver'
                    : 'Pending Driver';

                // pickup
                const pickupObj = trip.pickupLocation || trip.pickup || {};
                const dropoffObj = trip.dropoffLocation || trip.dropoff || {};
                const pickupDisplay = formatPlaceLabel(pickupObj, 'Unknown pickup');
                const dropoffDisplay = formatPlaceLabel(dropoffObj, 'Unknown dropoff');

               rides.push({
    __docId: scheduleDoc.id,
    id: `${parentId}-${childId}-${day}-${index}`,
    scheduleField: 'trips',
    dayIndex: -1,
    tripIndex: index,
    childName: childName,
    childAge: childAge,
    childPhotoUrl: childPhotoUrl,
    parentName: parentName,
    parentPhone: parentPhone,
    driverName,
    pickup: pickupDisplay,
    dropoff: dropoffDisplay,
    pickupLat: numFromCoord(pickupObj.lat),
    pickupLng: numFromCoord(pickupObj.lng),
    pickupLocationFull: pickupObj,
    dropoffLocationFull: dropoffObj,
    idTrip: trip.idTrip || '',
    tripType: trip.type || 'other',
    fromLabel: trip.from || '',
    toLabel: trip.to || '',
    isPaused: trip.isPaused || false,
    isScheduleActive: scheduleData.isActive !== false,
    childId: childId,
    parentId: parentId,
    driverId: tripAssignedDriverId,
    time: trip.time || 'N/A',
    day: day,
    status: tripAssignedDriverId && rawStatus === 'pending' ? 'accepted'
          : (rawStatus || 'pending')
});
            });
        }
    }
}
// 3. Fetch Children (Looping through parents to get their children)
        const parentsSnap = await firestore.collection('parents').get();
        let fetchedChildren = [];
        
        for (const parentDoc of parentsSnap.docs) {
            const parentData = parentDoc.data();
            // Get parent's name to display in the table
            const parentName = parentData.fullName || parentData.name || 'Unknown Parent';
            const parentPhone =
                parentData.phone ||
                parentData.phoneNumber ||
                parentData.mobile ||
                parentData.whatsapp ||
                'N/A';
            
            // Get the children subcollection for this specific parent
            const childrenSnap = await parentDoc.ref.collection('children').get();
            
            childrenSnap.forEach(childDoc => {
                const childData = childDoc.data();
                fetchedChildren.push({
                    __docId: childDoc.id,
                    id: childDoc.id,
                    // Pulling the child's actual name
                    name: childData.firstName || 'Unknown Child',
                    // Assuming you have an age field, otherwise defaults to N/A
                    age: calculateAge(childData.dateOfBirth),
                    parent: parentName,
                    parentPhone: parentPhone,
                    // If you save the assigned driver ID to the child, it will show here
                    driver: childData.assignedDriverId || 'None', 
                    status: 'N/A'
                });
            });
        }
        // Save the fetched children to your global array
        children = fetchedChildren;

        // Fetch trip_requests and map them to an exact trip key (parent + child + day + tripIndex).
        // This prevents a single assignment from being copied to all trips of the same day.
        const tripRequestsSnap = await firestore.collection('trip_requests').get();
        const tripRequestsByTripKey = new Map();
        const legacyTripRequestsByDay = new Map();
        const ridesCountByDay = new Map();

        rides.forEach(ride => {
            const dayKey = `${ride.parentId}_${ride.childId}_${ride.day}`;
            ridesCountByDay.set(dayKey, (ridesCountByDay.get(dayKey) || 0) + 1);
        });

        tripRequestsSnap.forEach(doc => {
            const data = doc.data();
            const dayKey = `${data.parentId}_${data.childId}_${data.day}`;
            const tripKey = makeTripRideKey(data.parentId, data.childId, data.day, data.tripIndex);

            if (tripKey) {
                const existing = tripRequestsByTripKey.get(tripKey);
                if (!existing || getTripRequestTimeValue(data) >= getTripRequestTimeValue(existing)) {
                    tripRequestsByTripKey.set(tripKey, data);
                }
                return;
            }

            if (!legacyTripRequestsByDay.has(dayKey)) {
                legacyTripRequestsByDay.set(dayKey, []);
            }
            legacyTripRequestsByDay.get(dayKey).push(data);
        });

        // Update rides with trip_requests data only when it is unambiguous.
        rides.forEach(ride => {
            const tripKey = makeTripRideKey(ride.parentId, ride.childId, ride.day, ride.tripIndex);
            let tripReq = tripKey ? tripRequestsByTripKey.get(tripKey) : null;

            if (!tripReq) {
                const dayKey = `${ride.parentId}_${ride.childId}_${ride.day}`;
                const dayRequests = legacyTripRequestsByDay.get(dayKey) || [];
                if (dayRequests.length === 1 && ridesCountByDay.get(dayKey) === 1) {
                    tripReq = dayRequests[0];
                }
            }

            if (tripReq?.driverId) {
                const driverName = driverMap[tripReq.driverId] || 'Unknown Driver';
                ride.driverName = driverName;
                ride.driverId = tripReq.driverId;
                ride.status = tripReq.status || 'accepted';
            }
        });

        // Resolve child names from children array
        rides.forEach(ride => {
            if (!ride.childName || ride.childName === 'Unknown Child') {
                const child = children.find(c => c.id === ride.childId);
                if (child) ride.childName = child.name;
            }
        });

        // Update UI with all the real data
        updateStats();
        loadRecentDrivers();
        loadRecentRides();
        loadDrivers();
        loadRides();
        
        // ADDED: Make sure to call the function that loads the children into the HTML table!
        if (typeof loadChildren === 'function') {
            loadChildren(); 
        }

    } catch (err) {
        console.error('Error fetching from Firestore:', err);
        alert("Error fetching data. Check your console for details.");
    }
}
function useSampleData() {
    // Sample data removed - login required to access real Firebase data
    drivers = [];
    rides = [];
    children = [];
}

function signInWithGoogle() {
    if (typeof firebase === 'undefined' || !firebase?.auth) {
        alert('Firebase is not available. Cannot sign in.');
        return;
    }
    const provider = new firebase.auth.GoogleAuthProvider();
    firebase.auth().signInWithPopup(provider).catch(err => {
        alert('Sign-in failed: ' + err.message);
    });
}

function initializeNavigation() {
    document.querySelectorAll('.nav-item, .view-all').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const page = link.getAttribute('data-page');
            switchPage(page, { refreshData: true, updateHash: true });
            if (window.matchMedia('(max-width: 768px)').matches) {
                document.getElementById('sidebar')?.classList.remove('active');
            }
        });
    });

    document.querySelectorAll('.stat-card[data-page]').forEach(card => {
        const openCardPage = () => {
            const page = card.getAttribute('data-page');
            switchPage(page, { refreshData: true, updateHash: true });

            const filter = card.getAttribute('data-driver-filter');
            if (page === 'drivers' && filter) {
                driverTableFilter = filter;
                document.querySelectorAll('#driversPage .filter-btn').forEach(btn => {
                    const btnFilter = btn.getAttribute('data-filter') || 'all';
                    btn.classList.toggle('active', btnFilter === filter);
                });
                loadDrivers();
            }
        };

        card.addEventListener('click', openCardPage);
        card.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openCardPage();
            }
        });
    });

    window.addEventListener('hashchange', () => {
        switchPage(window.location.hash.replace('#', ''), { refreshData: true, updateHash: false });
    });
}

function normalizePage(page) {
    const normalized = String(page || '').trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(PAGE_TITLES, normalized) ? normalized : DEFAULT_PAGE;
}

function setActiveNavigation(page) {
    document.querySelectorAll('.nav-item').forEach(item => {
        const isActive = item.getAttribute('data-page') === page;
        item.classList.toggle('active', isActive);
        if (isActive) item.setAttribute('aria-current', 'page');
        else item.removeAttribute('aria-current');
    });
}

function refreshPageData(page) {
    if (page === 'dashboard') {
        updateStats();
        loadRecentDrivers();
        loadRecentRides();
        return;
    }
    if (page === 'drivers') loadDrivers();
    else if (page === 'rides') loadRides();
    else if (page === 'children') loadChildren();
}

function switchPage(page, options = {}) {
    const currentPage = normalizePage(page);
    const shouldRefreshData = options.refreshData === true;
    const shouldUpdateHash = options.updateHash === true;

    document.querySelectorAll('.page').forEach(p => p.style.display = 'none');
    const pageElement = document.getElementById(`${currentPage}Page`);
    if (pageElement) pageElement.style.display = 'block';
    setActiveNavigation(currentPage);

    if (shouldUpdateHash) {
        const nextHash = `#${currentPage}`;
        if (window.location.hash !== nextHash && window.history?.replaceState) {
            window.history.replaceState(null, '', nextHash);
        }
    }

    if (shouldRefreshData) refreshPageData(currentPage);
    document.getElementById('pageTitle').textContent = PAGE_TITLES[currentPage];
}

function initializeTheme() {
    const theme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', theme);
    document.querySelector('#themeToggle i').className = theme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
}

function setupEventListeners() {
    document.getElementById('themeToggle').addEventListener('click', () => {
        const currentTheme = document.documentElement.getAttribute('data-theme');
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);
        document.querySelector('#themeToggle i').className = newTheme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
    });
    
    document.getElementById('sidebarToggle')?.addEventListener('click', () => document.getElementById('sidebar').classList.toggle('active'));
    document.getElementById('logoutBtn').addEventListener('click', performLogout);
    document.getElementById('logoutTopBtn')?.addEventListener('click', performLogout);
    document.getElementById('closeModal')?.addEventListener('click', () => document.getElementById('driverModal').classList.remove('active'));
    document.getElementById('signInBtn')?.addEventListener('click', signInWithGoogle);
    document.getElementById('emailLoginBtn')?.addEventListener('click', () => {
        const loginModal = document.getElementById('loginModal');
        if (loginModal) loginModal.classList.add('active');
    });
    document.getElementById('googleLoginBtn')?.addEventListener('click', signInWithGoogle);
    document.getElementById('closeLoginModal')?.addEventListener('click', () => {
        const loginModal = document.getElementById('loginModal');
        if (loginModal) loginModal.classList.remove('active');
    });
    
    // Login tab switching
    document.getElementById('emailTabBtn')?.addEventListener('click', (e) => {
        e.preventDefault();
        document.querySelector('#emailTabContent')?.classList.add('active');
        document.querySelector('#googleTabContent')?.classList.remove('active');
        document.getElementById('emailTabBtn')?.classList.add('active');
        document.getElementById('googleTabBtn')?.classList.remove('active');
    });
    document.getElementById('googleTabBtn')?.addEventListener('click', (e) => {
        e.preventDefault();
        document.querySelector('#emailTabContent')?.classList.remove('active');
        document.querySelector('#googleTabContent')?.classList.add('active');
        document.getElementById('emailTabBtn')?.classList.remove('active');
        document.getElementById('googleTabBtn')?.classList.add('active');
    });

    // Email login form
    document.getElementById('emailLoginForm')?.addEventListener('submit', (e) => {
        e.preventDefault();
        const email = document.getElementById('loginEmail')?.value || '';
        const password = document.getElementById('loginPassword')?.value || '';
        
        if (!email || !password) {
            alert('Please enter both email and password.');
            return;
        }
        
        if (typeof firebase === 'undefined' || !firebase?.auth) {
            alert('Firebase is not available. Cannot sign in.');
            return;
        }
        
        firebase.auth().signInWithEmailAndPassword(email, password).catch(err => {
            alert('Email login failed: ' + err.message);
        });
    });

    const driverModal = document.getElementById('driverModal');
    driverModal?.addEventListener('click', (e) => {
        if (e.target === driverModal) driverModal.classList.remove('active');
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            driverModal?.classList.remove('active');
            document.getElementById('assignDriverModal')?.classList.remove('active');
            document.getElementById('loginModal')?.classList.remove('active');
        }
    });

    setupDriverFiltersAndSearch();
    setupRideSearch();
    setupDriverActionDelegation();

    const assignModal = document.getElementById('assignDriverModal');
    document.getElementById('closeAssignModal')?.addEventListener('click', () => closeAssignDriverModal());
    assignModal?.addEventListener('click', (e) => {
        if (e.target === assignModal) closeAssignDriverModal();
    });
    document.getElementById('assignAllowModify')?.addEventListener('change', () => {
        const activeRideId = assignModal?.getAttribute('data-ride-id');
        if (activeRideId) {
            renderAssignDriverList(activeRideId);
        }
    });
}

function setupRideSearch() {
    const input = document.getElementById('rideSearch');
    input?.addEventListener('input', () => {
        rideSearchQuery = input.value;
        loadRides();
    });
}

function setupDriverFiltersAndSearch() {
    const searchInput = document.getElementById('driverSearch');
    searchInput?.addEventListener('input', () => {
        driverSearchQuery = searchInput.value;
        loadDrivers();
    });

    document.querySelectorAll('#driversPage .filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#driversPage .filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            driverTableFilter = btn.getAttribute('data-filter') || 'all';
            loadDrivers();
        });
    });
}

function setupDriverActionDelegation() {
    document.addEventListener('click', (e) => {
        const assignRide = e.target.closest('button[data-ride-action="assign"]');
        if (assignRide) {
            openAssignDriverModal(assignRide.getAttribute('data-ride-id'));
            return;
        }
        const assignPick = e.target.closest('button[data-assign-pick]');
        if (assignPick) {
            assignDriverToRide(
                assignPick.getAttribute('data-ride-id'),
                assignPick.getAttribute('data-driver-id')
            );
            return;
        }
        const btn = e.target.closest('button[data-driver-action]');
        if (!btn) return;
        const id = btn.getAttribute('data-driver-id');
        if (!id) return;
        const action = btn.getAttribute('data-driver-action');
        if (action === 'view') openDriverReport(id);
        else if (action === 'approve') approveDriver(id);
    });
}

function getDriversForTable() {
    let list = drivers.slice();
    if (driverTableFilter === 'pending') list = list.filter(d => d.status === 'pending');
    else if (driverTableFilter === 'approved') list = list.filter(d => d.status === 'approved');
    else if (driverTableFilter === 'rejected') list = list.filter(d => d.status === 'rejected');
    const q = driverSearchQuery.trim().toLowerCase();
    if (q) {
        list = list.filter(d =>
            String(d.name || '').toLowerCase().includes(q) ||
            String(d.email || '').toLowerCase().includes(q) ||
            String(d.phone || '').toLowerCase().includes(q)
        );
    }
    return list;
}

function getRidesForTable() {
    const q = rideSearchQuery.trim().toLowerCase();
    if (!q) return rides.slice();
    return rides.filter(r =>
        String(r.childName || '').toLowerCase().includes(q) ||
        String(r.driverName || '').toLowerCase().includes(q) ||
        String(r.pickup || '').toLowerCase().includes(q) ||
        String(r.dropoff || '').toLowerCase().includes(q) ||
        String(r.status || '').toLowerCase().includes(q)
    );
}

function updateStats() {
    document.getElementById('totalDrivers').textContent = drivers.length;
    const pending = drivers.filter(d => !d.isApproved).length;
    document.getElementById('pendingDrivers').textContent = pending;
    const badge = document.getElementById('pendingDriversBadge');
    if (badge) badge.textContent = String(pending);
    document.getElementById('totalRides').textContent = rides.length;
    const totalChildrenEl = document.getElementById('totalChildren');
    if (totalChildrenEl) totalChildrenEl.textContent = children.length;
}

function driverActionButtons(driver, { approve } = { approve: false }) {
    const idAttr = escapeAttr(driver.id);
    const approveBtn = approve && !driver.isApproved && driver.status === 'pending'
        ? `<button type="button" class="btn btn-sm btn-success" data-driver-action="approve" data-driver-id="${idAttr}">Approve</button>`
        : '';
    return `<div style="display: flex; gap: 8px; flex-wrap: wrap;">${approveBtn}<button type="button" class="btn btn-sm btn-primary" data-driver-action="view" data-driver-id="${idAttr}">View</button></div>`;
}

function loadRecentDrivers() {
    document.getElementById('recentDriversTable').innerHTML = drivers.slice(0, 5).map(driver => `
        <tr>
            <td>${escapeHtml(driver.name)}</td>
            <td>${escapeHtml(driver.email)}</td>
            <td><span class="status-badge status-${driverStatusClass(driver.status)}">${escapeHtml(driver.status)}</span></td>
            <td>${formatDate(driver.registrationDate)}</td>
            <td>${driverActionButtons(driver, { approve: true })}</td>
        </tr>
    `).join('');
}

function loadRecentRides() {
    document.getElementById('recentRidesTable').innerHTML = rides.slice(0, 5).map(ride => {
        const childName = getRideChildName(ride);
        const driverName = ride.driverName || 'Pending Driver';
        const pickup = ride.pickup;
        const dropoff = ride.dropoff;
        const effectiveStatus = getEffectiveRideStatus(ride);
        const statusClass = rideStatusClass(effectiveStatus);
        return `
        <tr>
            <td>${escapeHtml(childName)}</td>
            <td>${escapeHtml(ride.day)}</td>
            <td>${escapeHtml(driverName)}</td>
            <td>${escapeHtml(pickup)}</td>
            <td>${escapeHtml(dropoff)}</td>
            <td><span class="status-badge status-${statusClass}">${escapeHtml(effectiveStatus)}</span></td>
            <td>${escapeHtml(ride.time)}</td>
        </tr>
    `;
    }).join('');
}

function loadDrivers() {
    const list = getDriversForTable();
    document.getElementById('driversTable').innerHTML = list.map(driver => `
        <tr>
            <td>${escapeHtml(driver.name)}</td>
            <td>${escapeHtml(driver.email)}</td>
            <td>${escapeHtml(driver.phone)}</td>
            <td><span class="status-badge status-${driverStatusClass(driver.status)}">${escapeHtml(driver.status)}</span></td>
            <td>${formatDate(driver.registrationDate)}</td>
            <td>${driverActionButtons(driver, { approve: true })}</td>
        </tr>
    `).join('');
}

function loadRides() {
    const list = getRidesForTable();
    document.getElementById('ridesTable').innerHTML = list.map(ride => {
        const effectiveStatus = getEffectiveRideStatus(ride);
        const statusClass = rideStatusClass(effectiveStatus);
        const alreadyAssigned = isRideAssigned(ride);
        const assignBtn = isAdmin
            ? `<button type="button" class="btn btn-sm btn-primary" data-ride-action="assign" data-ride-id="${escapeAttr(ride.id)}">${alreadyAssigned ? 'Manage driver' : 'Assign driver'}</button>`
            : '-';
        return `
        <tr>
            <td>${escapeHtml(ride.childName)}</td>            <td>${escapeHtml(ride.day)}</td>            <td>${escapeHtml(ride.driverName)}</td>
            <td>${escapeHtml(ride.pickup)}</td>
            <td>${escapeHtml(ride.dropoff)}</td>
            <td>${escapeHtml(ride.time)}</td>
            <td><span class="status-badge status-${statusClass}">${escapeHtml(effectiveStatus)}</span></td>
            <td>${assignBtn}</td>
        </tr>
    `;
    }).join('');
}
function loadChildren() {
    // Look for the table body ID in your HTML. 
    // If your HTML uses a different ID for the children table, change 'childrenTable' to match it!
    const childrenTableBody = document.getElementById('childrenTable');
    
    // Safety check: only try to load the table if the table actually exists on the screen
    if (!childrenTableBody) return; 

    childrenTableBody.innerHTML = children.map(child => `
        <tr>
            <td>${escapeHtml(child.name)}</td>
            <td>${escapeHtml(child.age)}</td>
            <td>${escapeHtml(child.parent)}</td>
            <td>${escapeHtml(child.parentPhone || "N/A")}</td>
        </tr>
    `).join('');
}

// --- CORE ADMIN FUNCTION ---
async function approveDriver(id) {
    const driver = drivers.find(d => d.id === id);
    if (!driver) {
        alert('Driver not found.');
        return;
    }
    if (driver.isApproved || driver.status === 'approved') {
        alert('This driver is already approved.');
        return;
    }
    if (driver.status === 'rejected') {
        alert('This driver was rejected and cannot be approved from the dashboard without a database update.');
        return;
    }

    if (!confirm('Approve this driver? This will verify their KYC documents.')) return;

    if (isAdmin && firestore) {
        try {
            const docId = driver.__docId || driver.id;
            await firestore.collection('drivers').doc(docId).update({ 
                isApproved: true, 
                'kyc.status': 'verified',
                'kyc.reviewedAt': new Date().toISOString()
            });
            alert('Driver approved successfully!');
            await refreshDataFromFirestore();
        } catch (err) {
            console.error('Failed to update Firestore:', err);
            alert('Error updating database. Check permissions.');
        }
    } else {
        driver.isApproved = true;
        driver.status = 'approved';
        alert('Driver approved in this session only. Sign in as an admin with Firestore access to save to the database.');
        updateStats();
        loadRecentDrivers();
        loadDrivers();
    }
}

function openDriverReport(id) {
    const driver = drivers.find(d => d.id === id);
    if (!driver) {
        alert('Driver not found.');
        return;
    }
    try {
        sessionStorage.setItem('driverReport:' + id, JSON.stringify(driver));
    } catch (e) {
        console.warn('driver report cache', e);
    }
    const url = 'driver-report.html?id=' + encodeURIComponent(id);
    window.open(url, '_blank');
}

function toJsDate(value) {
    if (value == null) return null;
    if (typeof value.toDate === 'function') return value.toDate();
    if (typeof value.toMillis === 'function') return new Date(value.toMillis());
    if (value instanceof Date) return value;
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
}

function formatDate(dateString) {
    const d = toJsDate(dateString);
    if (!d) return 'N/A';
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatTime(value) {
    const d = toJsDate(value);
    return d ? d.toLocaleTimeString() : 'N/A';
}

function numFromCoord(v) {
    if (v == null || v === '') return null;
    const raw = typeof v === 'string' ? v.trim().replace(',', '.') : v;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
}

/** Great-circle distance in km (WGS84 approximation) */
function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function getDriversSortedByPickup(pickupLat, pickupLng) {
    const eligible = drivers.filter(d => d.isApproved === true && d.status !== 'rejected');
    const pickupLatNum = numFromCoord(pickupLat);
    const pickupLngNum = numFromCoord(pickupLng);
    const hasPickup = pickupLatNum != null && pickupLngNum != null;
    const rows = eligible.map(driver => {
        let distKm = null;
        if (hasPickup) {
            const la = numFromCoord(
                driver.locationLat ??
                driver.startLocation?.lat ??
                driver.startLocation?.latitude ??
                driver.latitude ??
                driver.currentLat ??
                driver.currentLatitude ??
                driver.lat
            );
            const ln = numFromCoord(
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
            if (la != null && ln != null) {
                distKm = haversineKm(pickupLatNum, pickupLngNum, la, ln);
            }
        }
        return { driver, distKm };
    });
    rows.sort((a, b) => {
        if (a.distKm == null && b.distKm == null) {
            return String(a.driver.name || '').localeCompare(String(b.driver.name || ''), undefined, { sensitivity: 'base' });
        }
        if (a.distKm == null) return 1;
        if (b.distKm == null) return -1;
        return a.distKm - b.distKm;
    });
    return rows;
}

function closeAssignDriverModal() {
    const modal = document.getElementById('assignDriverModal');
    modal?.classList.remove('active');
    modal?.removeAttribute('data-ride-id');
    const allowModify = document.getElementById('assignAllowModify');
    if (allowModify) allowModify.checked = false;
    const modifyWrap = document.getElementById('assignModifyWrap');
    if (modifyWrap) modifyWrap.hidden = true;
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
    const sorted = getDriversSortedByPickup(ride.pickupLat, ride.pickupLng);
    const el = document.getElementById('assignDriverList');
    if (!el) return;
    const assignedDriverId = getRideAssignedDriverId(ride);
    const alreadyAssigned = isRideAssigned(ride);
    const canModify = document.getElementById('assignAllowModify')?.checked === true;
    const locked = alreadyAssigned && !canModify;
    if (!sorted.length) {
        el.innerHTML = '<p class="assign-ride-meta">No approved drivers available.</p>';
        return;
    }
    el.innerHTML = sorted
        .map(({ driver, distKm }, index) => {
            const distLabel = distKm == null ? '-' : `${distKm.toFixed(1)} km`;
            const closest =
                index === 0 && distKm != null
                    ? ' <span class="status-badge status-approved" style="font-size:10px;vertical-align:middle;">Closest</span>'
                    : '';
            const isCurrent = assignedDriverId && String(driver.id) === String(assignedDriverId);
            const currentTag = isCurrent
                ? ' <span class="status-badge status-approved" style="font-size:10px;vertical-align:middle;">Current</span>'
                : '';
            let actionBtn = '';
            if (isCurrent) {
                actionBtn = `<button type="button" class="btn btn-sm btn-success" disabled>Assigned</button>`;
            } else if (locked) {
                actionBtn = `<button type="button" class="btn btn-sm btn-primary" disabled title="Enable modify checkbox to change driver">Assign</button>`;
            } else {
                const actionLabel = alreadyAssigned ? 'Change' : 'Assign';
                actionBtn = `<button type="button" class="btn btn-sm btn-primary" data-assign-pick data-ride-id="${escapeAttr(ride.id)}" data-driver-id="${escapeAttr(driver.id)}">${actionLabel}</button>`;
            }
            return `
        <div class="assign-driver-row">
            <div class="driver-main">
                <div class="driver-name">${escapeHtml(driver.name)}${closest}${currentTag}</div>
                <div class="driver-sub">${escapeHtml(driver.phone)} | ${escapeHtml(driver.email)}</div>
            </div>
            <div class="dist">${distLabel}</div>
            ${actionBtn}
        </div>`;
        })
        .join('');
}

function openAssignDriverModal(rideId) {
    if (!isAdmin) {
        alert('Only admins can assign drivers.');
        return;
    }
    const ride = rides.find(r => r.id === rideId);
    if (!ride) {
        alert('Ride not found.');
        return;
    }

    const modal = document.getElementById('assignDriverModal');
    modal?.setAttribute('data-ride-id', rideId);
    const allowModify = document.getElementById('assignAllowModify');
    if (allowModify) allowModify.checked = false;
    const modifyWrap = document.getElementById('assignModifyWrap');

    const assignedDriverId = getRideAssignedDriverId(ride);
    const alreadyAssigned = isRideAssigned(ride);
    if (modifyWrap) modifyWrap.hidden = !alreadyAssigned;

    const meta = document.getElementById('assignRideMeta');
    const parentContact = getRideParentContact(ride);
    let line = `Child: ${ride.childName} | Parent: ${parentContact.name} (${parentContact.phone}) | Pickup: ${ride.pickup}`;
    if (ride.pickupLat != null && ride.pickupLng != null) {
        line += ` | Pickup coordinates: ${Number(ride.pickupLat).toFixed(5)}, ${Number(ride.pickupLng).toFixed(5)}`;
    } else {
        line += ' | Pickup coordinates missing - distances unavailable (drivers sorted A-Z).';
    }
    if (alreadyAssigned) {
        const currentDriver = drivers.find(d => String(d.id) === String(assignedDriverId));
        const currentName = currentDriver?.name || ride.driverName || 'Assigned';
        line += ` | Current driver: ${currentName} | Locked: check "Enable modifying driver for this trip" to change.`;
    }
    meta.textContent = line;

    renderAssignDriverList(rideId);
    document.getElementById('assignDriverModal').classList.add('active');
}

async function assignDriverToRide(rideId, driverId) {
    if (!rideId || !driverId) return;
    const ride = rides.find(r => r.id === rideId);
    const driver = drivers.find(d => d.id === driverId);
    if (!ride || !driver) {
        alert('Ride or driver not found.');
        return;
    }
    const existingDriverId = getRideAssignedDriverId(ride);
    const isReassign = Boolean(existingDriverId) && String(existingDriverId) !== String(driver.id);
    const modifyEnabled = isAssignModifyEnabled(rideId);
    if (isReassign && !modifyEnabled) {
        alert('This trip already has a driver. Check "Enable modifying driver for this trip" to change it.');
        return;
    }
    if (existingDriverId && String(existingDriverId) === String(driver.id)) {
        alert('This driver is already assigned to this trip.');
        return;
    }
    if (!driver.isApproved || driver.status === 'rejected') {
        alert('Only approved drivers can be assigned.');
        return;
    }
    if (typeof driver.availableSeats === 'number' && driver.availableSeats <= 0) {
        alert('This driver has no available seats.');
        return;
    }
    const confirmText = isReassign
        ? `Change driver to ${driver.name} for ${ride.childName}?`
        : `Assign ${driver.name} to this ride for ${ride.childName}?`;
    if (!confirm(confirmText)) return;

   if (isAdmin && firestore) {
    try {
        const driverDocId = String(driver.__docId || driver.id).trim();
        const acceptedAt = new Date().toISOString();

        // ─── 1. اجلب parentId و childId من ride ───────────────────
        // ride لازم يحتوي على parentId و childId
        // راجع fetchDataFromFirestore وأضفهم (شوف الملاحظة أسفل)
        const parentId = ride.parentId;
        const childId = ride.childId;
        const day = ride.day;
        const tripIndex = Number(ride.tripIndex);

        if (!parentId || !childId || !day) {
            alert('Missing parentId / childId / day on this ride. Check fetch logic.');
            return;
        }
        if (!Number.isInteger(tripIndex)) {
            alert('Trip index is missing. Please refresh and try again.');
            return;
        }

        await firestore.runTransaction(async (tx) => {

            // ─── 2. schedules document ────────────────────────────
            const scheduleRef = firestore
                .collection('parents').doc(parentId)
                .collection('children').doc(childId)
                .collection('schedules').doc(day);

            const driverRef = firestore.collection('drivers').doc(driverDocId);

            const [scheduleSnap, driverSnap] = await Promise.all([
                tx.get(scheduleRef),
                tx.get(driverRef)
            ]);

            if (!scheduleSnap.exists) throw new Error('Schedule document not found.');
            if (!driverSnap.exists)   throw new Error('Driver not found.');

            // ─── 3. تحديث trips array ─────────────────────────────
            const trips = (scheduleSnap.data().trips || []).slice();
            const trip = trips[tripIndex];
            if (!trip || typeof trip !== 'object') throw new Error('Trip item not found.');

            const currentTripDriverId = String(
                trip.assignedDriverId || trip.driverId || ''
            ).trim();

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
                isAssignedDriver: true
            };

            // ─── 4. availableSeats ────────────────────────────────
            const driverData = driverSnap.data() || {};
            const currentSeats = Number(
                driverData.availableSeats != null ? driverData.availableSeats : driverData.capacity
            );
            if (!Number.isFinite(currentSeats) || currentSeats <= 0) {
                throw new Error('Driver has no available seats.');
            }

            // السائق السابق (إن وُجد)
            let previousDriverRef = null;
            let previousDriverSnap = null;
            if (currentTripDriverId && currentTripDriverId !== driverDocId) {
                previousDriverRef = firestore.collection('drivers').doc(currentTripDriverId);
                previousDriverSnap = await tx.get(previousDriverRef);
            }
            const previousSeats = previousDriverSnap?.exists
                ? Number(previousDriverSnap.data()?.availableSeats ?? NaN)
                : NaN;

            // ─── 5. اكتب كل التغييرات ─────────────────────────────
            tx.update(scheduleRef, { trips });                              // ← schedules
            tx.update(driverRef, { availableSeats: currentSeats - 1 });    // ← driver جديد
            if (previousDriverRef && previousDriverSnap?.exists) {
                tx.update(previousDriverRef, {
                    availableSeats: Number.isFinite(previousSeats) ? previousSeats + 1 : 1
                });
            }
        });

        // ─── 6. Create trip_requests document (like kidtaxi-admin) ────────
        try {
     const tripRequest = {
    acceptedAt: acceptedAt,
    childId: childId,
    childSnapshot: {
        age: ride.childAge || null,
        fullName: ride.childName || '',
        photoUrl: ride.childPhotoUrl || null,
    },
    createdAt: new Date().toISOString(),
    day: day,
    driverId: driverDocId,
    dropoff: ride.dropoff || '',
    parentId: parentId,
    parentSnapshot: {
        fullName: ride.parentName || '',
        phone: ride.parentPhone || '',
    },
    pickup: ride.pickup || '',
    pickupTime: ride.time || '',
    tripIndex: tripIndex,
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

            // Add document to trip_requests collection
            const docRef = await firestore.collection('trip_requests').add(tripRequest);
            // Set the document ID in the document itself
            await docRef.update({ id: docRef.id });
        } catch (tripReqErr) {
            console.warn('Warning: Failed to create trip_request document:', tripReqErr);
            // Don't fail the entire assignment if trip_requests creation fails
        }

        closeAssignDriverModal();
        await refreshDataFromFirestore();

    } catch (err) {
        console.error(err);
        alert('Failed to assign driver: ' + (err.message || 'Check Firestore rules.'));
    }

} else {
    // === Offline / sample data fallback (لا تغيير) ===
    const previousDriverId = getRideAssignedDriverId(ride);
    ride.driverId = driverId;
    ride.driverName = driver.name;
    ride.status = 'accepted';
    if (typeof driver.availableSeats === 'number') {
        driver.availableSeats = Math.max(0, driver.availableSeats - 1);
    }
    if (previousDriverId && previousDriverId !== driverId) {
        const previousDriver = drivers.find(d => String(d.id) === String(previousDriverId));
        if (previousDriver && typeof previousDriver.availableSeats === 'number') {
            previousDriver.availableSeats += 1;
        }
    }
    closeAssignDriverModal();
    loadRides();
    loadRecentRides();
}
}

/** When label is missing or still "Detecting place...", show lat/lng instead */
function formatPlaceLabel(place, fallback) {
    if (!place || typeof place !== 'object') return fallback;
    const raw = typeof place.label === 'string' ? place.label.trim() : '';
    const isPlaceholder =
        !raw ||
        /^detecting\s*place/i.test(raw) ||
        /^select/i.test(raw) ||
        /^loading/i.test(raw) ||
        raw === '...';
    if (!isPlaceholder) return raw;

    const lat = place.lat;
    const lng = place.lng;
    const la = typeof lat === 'number' ? lat : lat != null ? Number(lat) : NaN;
    const ln = typeof lng === 'number' ? lng : lng != null ? Number(lng) : NaN;
    if (Number.isFinite(la) && Number.isFinite(ln)) {
        return `${la.toFixed(5)}, ${ln.toFixed(5)}`;
    }
    return raw || fallback;
}

window.approveDriver = approveDriver;
window.openDriverReport = openDriverReport;



