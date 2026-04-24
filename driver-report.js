(function () {
    'use strict';

    const ADMIN_UID = 'XNSrFLevivdIrzTg4exZQxiK3162';

    /* ─── Helpers ──────────────────────────────────────────── */
    function esc(text) {
        return String(text ?? '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function toJsDate(value) {
        if (value == null) return null;
        if (typeof value.toDate === 'function') return value.toDate();
        if (typeof value.toMillis === 'function') return new Date(value.toMillis());
        if (value instanceof Date) return value;
        const d = new Date(value);
        return isNaN(d.getTime()) ? null : d;
    }

    function fmtDate(v) {
        const d = toJsDate(v);
        return d ? d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : 'N/A';
    }

    function fmtDateTime(v) {
        const d = toJsDate(v);
        return d ? d.toLocaleString() : 'N/A';
    }

    function yn(v, trueLabel = 'Yes', falseLabel = 'No') {
        return v
            ? `<span class="badge badge-approved"><i class="fas fa-check"></i>${esc(trueLabel)}</span>`
            : `<span class="badge badge-neutral">${esc(falseLabel)}</span>`;
    }

    function statusBadge(status) {
        const s = String(status || 'pending').toLowerCase();
        const cls = s === 'approved' ? 'badge-approved' : s === 'rejected' ? 'badge-rejected' : 'badge-pending';
        const icon = s === 'approved' ? 'fa-check-circle' : s === 'rejected' ? 'fa-times-circle' : 'fa-clock';
        return `<span class="badge ${cls}"><i class="fas ${icon}"></i>${esc(status || 'pending')}</span>`;
    }

    function showBanner(msg, isError) {
        const el = document.getElementById('banner');
        el.hidden = false;
        el.textContent = msg;
        el.className = 'banner' + (isError ? ' error' : '');
    }

    function setLoading(show) {
        document.getElementById('loadingState').style.display = show ? 'flex' : 'none';
        document.getElementById('reportContainer').hidden = show;
    }

    function extractVehicleFields(rawData) {
        const kyc = rawData && typeof rawData.kyc === 'object' ? rawData.kyc : {};
        const source =
            (kyc.vehicle && typeof kyc.vehicle === 'object') ? kyc.vehicle :
            (rawData && rawData.vehicle && typeof rawData.vehicle === 'object') ? rawData.vehicle : {};

        return {
            vehicleMake: source.brand || source.make || '',
            vehicleModel: source.model || '',
            vehiclePlate:
                source.plateNumber || source.plate ||
                source.registrationPlate || source.registrationNumber || '',
            vehicleYear: source.year != null ? String(source.year) : '',
            vehicleColor: source.color || ''
        };
    }

    function hasVehicleFields(driver) {
        return Boolean(
            driver &&
            (driver.vehicleMake || driver.vehicleModel || driver.vehiclePlate || driver.vehicleYear || driver.vehicleColor)
        );
    }

    function applyVehicleFallback(driver, rawData) {
        const base = (driver && typeof driver === 'object') ? driver : {};
        if (hasVehicleFields(base)) return base;

        const fromRaw = extractVehicleFields(rawData);
        const rawHasVehicle = Boolean(
            fromRaw.vehicleMake || fromRaw.vehicleModel || fromRaw.vehiclePlate || fromRaw.vehicleYear || fromRaw.vehicleColor
        );
        if (!rawHasVehicle) return base;

        console.warn('⚠️ Vehicle fallback applied from raw Firestore data.');
        return {
            ...base,
            vehicleMake: fromRaw.vehicleMake,
            vehicleModel: fromRaw.vehicleModel,
            vehiclePlate: fromRaw.vehiclePlate,
            vehicleYear: fromRaw.vehicleYear,
            vehicleColor: fromRaw.vehicleColor
        };
    }

    /* ─── Document Figure ───────────────────────────────────── */
    function docFigure(label, url) {
        if (!url) {
            return `<div class="doc-figure doc-missing">
                <i class="fas fa-image"></i>
                <span>No image on file</span>
                <small>${esc(label)}</small>
            </div>`;
        }
        return `<figure class="doc-figure" data-lightbox="${esc(url)}" data-caption="${esc(label)}" tabindex="0" role="button" aria-label="View ${esc(label)}">
            <img src="${esc(url)}" alt="${esc(label)}" loading="lazy" referrerpolicy="no-referrer" />
            <figcaption>${esc(label)}</figcaption>
        </figure>`;
    }

    /* ─── Lightbox ─────────────────────────────────────────── */
    function initLightbox() {
        const lb = document.getElementById('lightbox');
        const lbImg = document.getElementById('lightboxImg');
        const lbCaption = document.getElementById('lightboxCaption');
        const lbClose = document.getElementById('lightboxClose');

        lb.hidden = true;
        lbImg.src = '';

        function open(url, caption) {
            lbImg.src = url;
            lbCaption.textContent = caption;
            lb.hidden = false;
            document.body.style.overflow = 'hidden';
        }

        function close() {
            lb.hidden = true;
            lbImg.src = '';
            document.body.style.overflow = '';
        }

        document.addEventListener('click', (e) => {
            const fig = e.target.closest('[data-lightbox]');
            if (fig) open(fig.dataset.lightbox, fig.dataset.caption || '');
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                const fig = document.activeElement?.closest('[data-lightbox]');
                if (fig) { e.preventDefault(); open(fig.dataset.lightbox, fig.dataset.caption || ''); }
            }
            if (e.key === 'Escape' && !lb.hidden) close();
        });

        lbClose.addEventListener('click', (e) => { e.stopPropagation(); close(); });
        lb.addEventListener('click', (e) => { if (e.target === lb) close(); });
    }

    /* ─── Render ───────────────────────────────────────────── */
    function render(driver, isAdminUser, firestore) {
        const displayName = driver.name || 'Driver';
        document.title = `${displayName} — KiDrive`;
        document.getElementById('toolbarName').textContent = displayName;

        console.log('🧾 Full driver object:', driver);
        console.log('🚗 Vehicle fields:', {
            vehicleMake:  driver.vehicleMake,
            vehicleModel: driver.vehicleModel,
            vehiclePlate: driver.vehiclePlate,
            vehicleYear:  driver.vehicleYear,
            vehicleColor: driver.vehicleColor,
        });

        /* ── Hero ── */
        const avatarWrap = document.getElementById('avatarWrap');
        if (driver.profilePhotoUrl) {
            avatarWrap.innerHTML = `<img src="${esc(driver.profilePhotoUrl)}" alt="${esc(displayName)}" referrerpolicy="no-referrer" loading="lazy" />`;
        }

        document.getElementById('driverName').textContent = displayName;
        document.getElementById('heroMeta').textContent =
            [driver.email, driver.phone, driver.wilaya].filter(Boolean).join(' · ');

        const badges = [];
        badges.push(statusBadge(driver.status));
        if (driver.isAvailable) badges.push(`<span class="badge badge-approved"><i class="fas fa-wifi"></i>Available</span>`);
        if (driver.availableSeats != null) badges.push(`<span class="badge badge-info"><i class="fas fa-chair"></i>${driver.availableSeats} seats</span>`);
        if (driver.isOnline) badges.push(`<span class="badge badge-approved"><i class="fas fa-circle"></i>Online</span>`);
        document.getElementById('heroBadges').innerHTML = badges.join('');

        /* ── Hero actions ── */
        const heroActions = document.getElementById('heroActions');
        if (isAdminUser && driver.status === 'pending' && !driver.isApproved) {
            heroActions.innerHTML = `
                <button class="action-btn action-btn-approve" id="heroApproveBtn">
                    <i class="fas fa-check-circle"></i> Approve Driver
                </button>`;
            document.getElementById('heroApproveBtn').addEventListener('click', () => approveDriver(driver, firestore));
        }

        /* ── Quick Stats ── */
        const stats = [
            { icon: 'fas fa-calendar-alt', label: 'Registered', value: fmtDate(driver.registrationDate), color: '#1976D2', bg: 'rgba(25,118,210,0.08)' },
            { icon: 'fas fa-id-card', label: 'License', value: driver.licenseNumber || 'N/A', color: '#2E7D32', bg: 'rgba(46,125,50,0.08)' },
            { icon: 'fas fa-car', label: 'Vehicle', value: [driver.vehicleMake, driver.vehicleModel].filter(Boolean).join(' ') || 'N/A', color: '#6A1B9A', bg: 'rgba(106,27,154,0.08)' },
            { icon: 'fas fa-map-marker-alt', label: 'Wilaya', value: driver.wilaya || 'N/A', color: '#E65100', bg: 'rgba(230,81,0,0.08)' },
        ];

        document.getElementById('quickStats').innerHTML = stats.map(s => `
            <div class="qs-card">
                <div class="qs-icon" style="background:${s.bg};color:${s.color}"><i class="${s.icon}"></i></div>
                <div>
                    <div class="qs-label">${esc(s.label)}</div>
                    <div class="qs-value">${esc(s.value)}</div>
                </div>
            </div>
        `).join('');

        /* ── Identity ── */
        const idRows = [
            ['Status', statusBadge(driver.status)],
            driver.email        && ['Email', esc(driver.email)],
            driver.phone        && ['Phone', esc(driver.phone)],
            driver.firstName    && ['First name', esc(driver.firstName)],
            driver.lastName     && ['Last name', esc(driver.lastName)],
            driver.dateOfBirth  && ['Date of birth', fmtDate(driver.dateOfBirth)],
            driver.gender       && ['Gender', esc(driver.gender)],
            driver.bloodType    && ['Blood type', esc(driver.bloodType)],
            driver.familyStatus && ['Family status', esc(driver.familyStatus)],
            driver.nationalId   && ['National ID', `<span style="font-family:var(--mono);font-size:12px">${esc(driver.nationalId)}</span>`],
            driver.wilaya       && ['Wilaya', esc(driver.wilaya)],
            driver.address      && ['Address', esc(driver.address)],
            ['Registered', fmtDate(driver.registrationDate)],
            driver.updatedAt    && ['Last update', fmtDateTime(driver.updatedAt)],
            ['Email verified', yn(driver.emailVerified)],
            ['Profile complete', yn(driver.profileComplete)],
        ].filter(Boolean);

        document.getElementById('identityGrid').innerHTML = idRows.map(([label, val]) =>
            `<dt>${esc(label)}</dt><dd>${val}</dd>`
        ).join('');

        /* ── Vehicle ── */
        const vCard = document.getElementById('vehicleBody');
        const hasVehicle = driver.vehicleMake || driver.vehicleModel || driver.vehiclePlate || driver.vehicleYear || driver.vehicleColor;

        if (hasVehicle) {
            const cells = [
                driver.vehicleMake  && { label: 'Brand', value: driver.vehicleMake },
                driver.vehicleModel && { label: 'Model', value: driver.vehicleModel },
                driver.vehicleYear  && { label: 'Year', value: driver.vehicleYear },
                driver.vehicleColor && { label: 'Color', value: driver.vehicleColor },
            ].filter(Boolean);

            vCard.innerHTML = `
                <div class="vehicle-grid">
                    ${cells.map(c => `
                        <div class="vehicle-cell">
                            <div class="vehicle-cell-label">${esc(c.label)}</div>
                            <div class="vehicle-cell-value">${esc(c.value)}</div>
                        </div>
                    `).join('')}
                    ${driver.vehiclePlate ? `
                        <div class="vehicle-cell" style="grid-column:1/-1">
                            <div class="vehicle-cell-label">Plate number</div>
                            <div class="vehicle-cell-value"><span class="plate-display">${esc(driver.vehiclePlate)}</span></div>
                        </div>
                    ` : ''}
                </div>`;
        } else {
            vCard.innerHTML = `<div class="empty-state"><i class="fas fa-car"></i>No vehicle details on file</div>`;
        }

        /* ── KYC Card ── */
        const kycRows = [
            ['KYC status', statusBadge(driver.kycStatus || driver.status)],
            driver.licenseNumber     && ['License №', `<span style="font-family:var(--mono);font-size:12px">${esc(driver.licenseNumber)}</span>`],
            driver.licenseCategory   && ['Category', esc(driver.licenseCategory)],
            driver.licenseExpiryDate && ['Expiry', esc(driver.licenseExpiryDate)],
            ['License verified', yn(driver.licenseVerified)],
            driver.kycSubmittedAt    && ['Submitted', fmtDateTime(driver.kycSubmittedAt)],
            driver.kycReviewedAt     && ['Reviewed', fmtDateTime(driver.kycReviewedAt)],
        ].filter(Boolean);

        let kycHtml = kycRows.map(([label, val]) => `
            <div class="kyc-row">
                <span class="kyc-label">${esc(label)}</span>
                <span class="kyc-value">${val}</span>
            </div>
        `).join('');

        if (driver.kycNotes) {
            kycHtml += `<div class="kyc-notes-box"><strong>Notes:</strong> ${esc(driver.kycNotes)}</div>`;
        }
        document.getElementById('kycBody').innerHTML = kycHtml;

        /* ── Documents ── */
        document.getElementById('kycMeta').innerHTML = [
            driver.licenseNumber ? `<span class="badge badge-info"><i class="fas fa-id-card"></i>${esc(driver.licenseNumber)}</span>` : '',
            driver.licenseVerified ? `<span class="badge badge-approved"><i class="fas fa-check"></i>Verified</span>` : '',
        ].join('');

        document.getElementById('docsGrid').innerHTML = [
            docFigure('License (front)', driver.licenseFrontUrl),
            docFigure('License (back)', driver.licenseBackUrl),
            driver.greyCardPhotoUrl ? docFigure('Carte grise', driver.greyCardPhotoUrl) : '',
        ].join('');

        /* ── Grey Card ── */
        if (driver.greyCardPhotoUrl || driver.greyCardRegistration || driver.greyCardVerified != null) {
            document.getElementById('greyCardSection').hidden = false;
            document.getElementById('greyCardBody').innerHTML = `
                <div class="kyc-row">
                    <span class="kyc-label">Verified</span>
                    <span class="kyc-value">${yn(driver.greyCardVerified)}</span>
                </div>
                ${driver.greyCardRegistration ? `
                <div class="kyc-row">
                    <span class="kyc-label">Registration №</span>
                    <span class="kyc-value" style="font-family:var(--mono);font-size:12px">${esc(driver.greyCardRegistration)}</span>
                </div>` : ''}`;
        }

        /* ── Location ── */
        const lat = driver.locationLat;
        const lng = driver.locationLng;
        if (lat != null && lng != null) {
            const mapsUrl = `https://www.google.com/maps?q=${encodeURIComponent(`${lat},${lng}`)}`;
            document.getElementById('locationBody').innerHTML = `
                <div class="location-coords">
                    <div><strong>Lat:</strong> ${lat.toFixed(6)}</div>
                    <div><strong>Lng:</strong> ${lng.toFixed(6)}</div>
                </div>
                ${driver.locationUpdatedAt ? `<div class="location-updated">Updated: ${fmtDateTime(driver.locationUpdatedAt)}</div>` : ''}
                <a class="map-btn" href="${esc(mapsUrl)}" target="_blank" rel="noopener noreferrer">
                    <i class="fas fa-map-marked-alt"></i> Open in Google Maps
                </a>`;
        } else {
            document.getElementById('locationBody').innerHTML =
                `<div class="empty-state"><i class="fas fa-map-marker-alt"></i>No coordinates on file</div>`;
        }

        /* ── Admin Actions ── */
        if (isAdminUser) {
            const actCard = document.getElementById('actionsCard');
            actCard.hidden = false;
            const actBody = document.getElementById('actionsBody');

            if (driver.status === 'approved') {
                actBody.innerHTML = `
                    <button class="action-btn action-btn-reject" id="rejectBtn">
                        <i class="fas fa-times-circle"></i> Revoke Approval
                    </button>
                    <p class="action-note">This driver is currently approved.</p>`;
                document.getElementById('rejectBtn').addEventListener('click', () => rejectDriver(driver, firestore));
            } else if (driver.status === 'pending') {
                actBody.innerHTML = `
                    <button class="action-btn action-btn-approve" id="approveBtn">
                        <i class="fas fa-check-circle"></i> Approve Driver
                    </button>
                    <button class="action-btn action-btn-reject" id="rejectBtn" style="margin-top:4px">
                        <i class="fas fa-times-circle"></i> Reject Driver
                    </button>
                    <p class="action-note">Review KYC documents before approving.</p>`;
                document.getElementById('approveBtn').addEventListener('click', () => approveDriver(driver, firestore));
                document.getElementById('rejectBtn').addEventListener('click', () => rejectDriver(driver, firestore));
            } else if (driver.status === 'rejected') {
                actBody.innerHTML = `
                    <button class="action-btn action-btn-approve" id="approveBtn">
                        <i class="fas fa-check-circle"></i> Approve Driver
                    </button>
                    <p class="action-note">This driver was previously rejected.</p>`;
                document.getElementById('approveBtn').addEventListener('click', () => approveDriver(driver, firestore));
            }
        }
    }

    /* ─── Admin Actions ────────────────────────────────────── */
    async function approveDriver(driver, firestore) {
        if (!firestore) { alert('Not connected to Firestore.'); return; }
        if (!confirm(`Approve ${driver.name}? This will verify their KYC documents.`)) return;
        try {
            await firestore.collection('drivers').doc(driver.__docId || driver.id).update({
                isApproved: true,
                'kyc.status': 'verified',
                'kyc.reviewedAt': new Date().toISOString()
            });
            alert('✅ Driver approved successfully!');
            location.reload();
        } catch (err) {
            alert('Error: ' + err.message);
        }
    }

    async function rejectDriver(driver, firestore) {
        if (!firestore) { alert('Not connected to Firestore.'); return; }
        const reason = prompt('Rejection reason (optional):') ?? '';
        if (!confirm(`Reject ${driver.name}?`)) return;
        try {
            await firestore.collection('drivers').doc(driver.__docId || driver.id).update({
                isApproved: false,
                'kyc.status': 'rejected',
                'kyc.rejectionReason': reason,
                'kyc.reviewedAt': new Date().toISOString()
            });
            alert('Driver rejected.');
            location.reload();
        } catch (err) {
            alert('Error: ' + err.message);
        }
    }

    /* ─── Firebase Auth + Data ─────────────────────────────── */
    async function tryLoadFromFirestore(id) {
        if (typeof firebase === 'undefined' || !window.FIREBASE_CONFIG) {
            console.warn('⚠️ Firebase غير متاح أو FIREBASE_CONFIG مفقود');
            return { skip: true };
        }

        try {
            if (!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
        } catch (e) {
            console.error('❌ Firebase init error:', e);
            return { skip: true };
        }

        const auth = firebase.auth();

        // ✅ الإصلاح الرئيسي: انتظار Auth بشكل صحيح مع timeout
        const user = await new Promise(resolve => {
            // إذا كان المستخدم مسجلاً بالفعل، أرجعه فوراً
            if (auth.currentUser) {
                resolve(auth.currentUser);
                return;
            }
            // وإلا انتظر حتى يتحقق Firebase من الجلسة (مع timeout 8 ثوانٍ)
            const timer = setTimeout(() => {
                console.warn('⏱️ Auth timeout - لم يتم التحقق خلال 8 ثوانٍ');
                unsub();
                resolve(null);
            }, 8000);
            const unsub = auth.onAuthStateChanged(u => {
                clearTimeout(timer);
                unsub();
                resolve(u);
            });
        });

        console.log('👤 Auth user:', user ? user.email : 'لم يسجل الدخول');

        if (!user) {
            return { skip: true, reason: 'not-signed-in' };
        }

        const tokenResult = await user.getIdTokenResult();
        const isAdmin = tokenResult?.claims?.admin === true || user.uid === ADMIN_UID;

        const db = firebase.firestore();
        console.log('📡 جاري تحميل السائق:', id);
        const snap = await db.collection('drivers').doc(id).get();

        if (!snap.exists) {
            console.warn('❌ الوثيقة غير موجودة في Firestore');
            return { missing: true, isAdmin, firestore: db };
        }

        const rawData = JSON.parse(JSON.stringify(snap.data()));
        console.log('📋 RAW JSON:', JSON.stringify(rawData, null, 2));
        console.log('🚗 vehicle من Firestore (root level):', rawData.vehicle);
        console.log('🚗 vehicle من kyc:', rawData.kyc?.vehicle);
        console.log('⏳ BEFORE normalize - kyc object:', rawData.kyc);

        const normalizeFn = typeof window.normalizeDriverFromFirestore === 'function'
            ? window.normalizeDriverFromFirestore
            : null;

        const normalizedBase = normalizeFn
            ? normalizeFn(snap.id, rawData)
            : { __docId: snap.id, id: snap.id, name: rawData.fullName || 'Unknown' };

        const normalized = applyVehicleFallback(normalizedBase, rawData);
        console.log('✅ بعد normalize:', {
            vehicleMake:  normalized.vehicleMake,
            vehicleModel: normalized.vehicleModel,
            vehiclePlate: normalized.vehiclePlate,
            vehicleYear:  normalized.vehicleYear,
            vehicleColor: normalized.vehicleColor,
        });

        return { driver: normalized, isAdmin, firestore: db };
    }

    /* ─── Main ─────────────────────────────────────────────── */
    async function main() {
        const theme = localStorage.getItem('theme') || 'light';
        document.documentElement.setAttribute('data-theme', theme);
        const themeToggle = document.getElementById('themeToggle');
        themeToggle.querySelector('i').className = theme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
        themeToggle.addEventListener('click', () => {
            const current = document.documentElement.getAttribute('data-theme');
            const next = current === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', next);
            localStorage.setItem('theme', next);
            themeToggle.querySelector('i').className = next === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
        });

        document.getElementById('btnPrint').addEventListener('click', () => window.print());
        initLightbox();

        const params = new URLSearchParams(window.location.search);
        const id = params.get('id');

        if (!id) {
            setLoading(false);
            showBanner('Missing driver id in URL.', true);
            return;
        }

        setLoading(true);

        // ✅ امسح الكاش القديم دائماً لضمان بيانات حديثة
        try { sessionStorage.removeItem('driverReport:' + id); } catch (e) { /* ignore */ }

        let driver = null;
        let isAdminUser = false;
        let firestoreDb = null;

        try {
            const remote = await tryLoadFromFirestore(id);

            if (remote.driver) {
                driver = remote.driver;
                isAdminUser = remote.isAdmin || false;
                firestoreDb = remote.firestore || null;
                // احفظ في الكاش للاستخدام اللاحق
                try { sessionStorage.setItem('driverReport:' + id, JSON.stringify(driver)); } catch (e) { /* ignore */ }

            } else if (remote.missing) {
                isAdminUser = remote.isAdmin || false;
                firestoreDb = remote.firestore || null;
                showBanner('Driver document not found in Firestore.', true);

            } else if (remote.skip) {
                // لم يسجل الدخول - حاول الكاش
                try {
                    const raw = sessionStorage.getItem('driverReport:' + id);
                    if (raw) {
                        driver = JSON.parse(raw);
                        showBanner('Not signed in — showing cached data. Sign in on the main dashboard to load live data.', false);
                    }
                } catch (e) { /* ignore */ }
            }

        } catch (err) {
            console.error('❌ خطأ في تحميل البيانات:', err);
            showBanner('Error loading driver: ' + err.message, true);
        }

        setLoading(false);

        if (!driver) {
            showBanner('No data available. Go to the dashboard → Drivers → click View for this driver.', true);
            return;
        }

        render(driver, isAdminUser, firestoreDb);
    }

    main();
})();