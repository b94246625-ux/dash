/* ================================================================
   i18n.js — EN / AR with RTL toggle.
   Stores the selected language in localStorage.
   Exposes:
     window.i18n = { t(key), setLang(lang), getLang(), apply(root?) }
   Usage in HTML:
     <span data-i18n="nav.dashboard">Dashboard</span>
     <input data-i18n-placeholder="search.drivers">
   ================================================================ */
(function () {
    'use strict';

    const DICT = {
        en: {
            appName: 'Taxi for Kids',
            'nav.dashboard': 'Dashboard',
            'nav.drivers': 'Drivers',
            'nav.rides': 'Rides',
            'nav.dispatch': 'Dispatch',
            'nav.children': 'Children',
            'nav.settings': 'Settings',

            'kpi.totalDrivers': 'Total Drivers',
            'kpi.pendingApproval': 'Pending Approval',
            'kpi.totalRides': 'Total Rides',
            'kpi.activeChildren': 'Active Children',

            'dashboard.liveFleetMap': 'Live Fleet Map',
            'dashboard.onlineDrivers': 'Online Drivers',
            'dashboard.recentDrivers': 'Recent Drivers',
            'dashboard.recentRides': 'Recent Rides',

            'common.viewAll': 'View all',
            'common.loading': 'Loading…',
            'common.noData': 'No data',
            'common.close': 'Close',
            'common.cancel': 'Cancel',
            'common.ok': 'OK',
            'common.notAvailable': 'N/A',
            'common.refresh': 'Refresh',

            'filter.all': 'All',
            'filter.pending': 'Pending',
            'filter.approved': 'Approved',
            'filter.rejected': 'Rejected',
            'filter.accepted': 'Accepted',
            'filter.completed': 'Completed',

            'search.drivers': 'Search drivers…',
            'search.rides': 'Search rides…',
            'search.children': 'Search children…',

            'table.name': 'Name',
            'table.contact': 'Contact',
            'table.vehicle': 'Vehicle',
            'table.email': 'Email',
            'table.phone': 'Phone',
            'table.status': 'Status',
            'table.date': 'Date',
            'table.registration': 'Registered',
            'table.child': 'Child',
            'table.day': 'Day',
            'table.driver': 'Driver',
            'table.pickup': 'Pickup',
            'table.dropoff': 'Dropoff',
            'table.time': 'Time',
            'table.age': 'Age',
            'table.parent': 'Parent',
            'table.parentPhone': 'Parent Phone',

            'map.online': 'Online',
            'map.idle': 'Idle',
            'map.offline': 'Offline',

            'assign.title': 'Assign driver',
            'assign.enableModify': 'Enable modifying driver for this trip',
            'assign.top': 'Top pick',
            'assign.closest': 'Closest',
            'assign.current': 'Current',
            'assign.noDrivers': 'No approved drivers available.',
            'assign.noCoords': 'Pickup coordinates missing — distances unavailable.',
            'assign.assign': 'Assign',
            'assign.change': 'Change',
            'assign.assigned': 'Assigned',

            'driver.details': 'Driver details',
            'driver.profile': 'Profile',
            'driver.vehicle': 'Vehicle & License',
            'driver.kyc': 'KYC Documents',
            'driver.history': 'Trip History',
            'driver.noHistory': 'No completed trips yet.',
            'driver.actions': 'Actions',
            'driver.approve': 'Approve',
            'driver.reject': 'Reject',
            'driver.location': 'Location',

            'dispatch.title': 'Unassigned rides',
            'dispatch.topSuggestion': 'Top suggestion',
            'dispatch.noUnassigned': 'All rides have a driver assigned.',
            'dispatch.assign': 'Assign',

            'settings.general': 'General',
            'settings.autoApprove': 'Auto-approve drivers',
            'settings.autoApproveDesc': 'Automatically approve new driver registrations',
            'settings.emailNotifications': 'Email notifications',
            'settings.emailNotificationsDesc': 'Receive email notifications for important events',
            'settings.dispatch': 'Dispatch algorithm',
            'settings.dispatchHint': 'Weights for candidate scoring',
            'settings.wDistance': 'Distance to pickup',
            'settings.wLocality': 'Same baladia / wilaya',
            'settings.wRating': 'Driver rating / history',
            'settings.wFreshness': 'Location freshness',
            'settings.wWorkload': 'Workload balance',
            'settings.dispatchNote': 'Saved locally in your browser.',

            'auth.guest': 'Guest',
            'auth.signInToContinue': 'Sign in to continue',
            'auth.signIn': 'Sign in',
            'auth.signInGoogle': 'Sign in with Google',
            'auth.logout': 'Log out',
            'auth.emailLogin': 'Email login',
            'auth.emailPassword': 'Email & password',
            'auth.google': 'Google Sign-in',
            'auth.email': 'Email',
            'auth.password': 'Password',
            'auth.adminLogin': 'Admin login',
            'auth.contactAdmin': "Don't have an account? Contact your administrator.",
            'auth.googleHint': 'Click above to sign in with your Google account.',

            'live.streaming': 'Live data',
            'toast.assigned': 'Driver assigned successfully',
            'toast.assignFailed': 'Failed to assign driver',
            'toast.loginRequired': 'Only admins can perform this action.',
            'toast.approved': 'Driver approved',
            'toast.rejected': 'Driver rejected',
        },
        ar: {
            appName: 'تاكسي الأطفال',
            'nav.dashboard': 'لوحة التحكم',
            'nav.drivers': 'السائقون',
            'nav.rides': 'الرحلات',
            'nav.dispatch': 'التوزيع',
            'nav.children': 'الأطفال',
            'nav.settings': 'الإعدادات',

            'kpi.totalDrivers': 'إجمالي السائقين',
            'kpi.pendingApproval': 'بانتظار الموافقة',
            'kpi.totalRides': 'إجمالي الرحلات',
            'kpi.activeChildren': 'الأطفال النشطون',

            'dashboard.liveFleetMap': 'خريطة الأسطول المباشرة',
            'dashboard.onlineDrivers': 'السائقون المتصلون',
            'dashboard.recentDrivers': 'سائقون جدد',
            'dashboard.recentRides': 'رحلات حديثة',

            'common.viewAll': 'عرض الكل',
            'common.loading': 'جارٍ التحميل…',
            'common.noData': 'لا توجد بيانات',
            'common.close': 'إغلاق',
            'common.cancel': 'إلغاء',
            'common.ok': 'حسناً',
            'common.notAvailable': 'غير متوفر',
            'common.refresh': 'تحديث',

            'filter.all': 'الكل',
            'filter.pending': 'بالانتظار',
            'filter.approved': 'موافق عليه',
            'filter.rejected': 'مرفوض',
            'filter.accepted': 'مقبول',
            'filter.completed': 'مكتمل',

            'search.drivers': 'ابحث عن سائق…',
            'search.rides': 'ابحث عن رحلة…',
            'search.children': 'ابحث عن طفل…',

            'table.name': 'الاسم',
            'table.contact': 'جهة الاتصال',
            'table.vehicle': 'المركبة',
            'table.email': 'البريد',
            'table.phone': 'الهاتف',
            'table.status': 'الحالة',
            'table.date': 'التاريخ',
            'table.registration': 'تاريخ التسجيل',
            'table.child': 'الطفل',
            'table.day': 'اليوم',
            'table.driver': 'السائق',
            'table.pickup': 'نقطة الركوب',
            'table.dropoff': 'نقطة النزول',
            'table.time': 'الوقت',
            'table.age': 'العمر',
            'table.parent': 'ولي الأمر',
            'table.parentPhone': 'هاتف ولي الأمر',

            'map.online': 'متصل',
            'map.idle': 'خامل',
            'map.offline': 'غير متصل',

            'assign.title': 'تعيين سائق',
            'assign.enableModify': 'تفعيل تعديل السائق لهذه الرحلة',
            'assign.top': 'الأفضل',
            'assign.closest': 'الأقرب',
            'assign.current': 'الحالي',
            'assign.noDrivers': 'لا يوجد سائقون معتمدون متاحون.',
            'assign.noCoords': 'إحداثيات نقطة الركوب مفقودة — المسافات غير متاحة.',
            'assign.assign': 'تعيين',
            'assign.change': 'تغيير',
            'assign.assigned': 'تم التعيين',

            'driver.details': 'تفاصيل السائق',
            'driver.profile': 'الملف الشخصي',
            'driver.vehicle': 'المركبة والرخصة',
            'driver.kyc': 'وثائق KYC',
            'driver.history': 'سجل الرحلات',
            'driver.noHistory': 'لا توجد رحلات مكتملة بعد.',
            'driver.actions': 'الإجراءات',
            'driver.approve': 'موافقة',
            'driver.reject': 'رفض',
            'driver.location': 'الموقع',

            'dispatch.title': 'رحلات بدون سائق',
            'dispatch.topSuggestion': 'أفضل اقتراح',
            'dispatch.noUnassigned': 'جميع الرحلات لديها سائق.',
            'dispatch.assign': 'تعيين',

            'settings.general': 'عام',
            'settings.autoApprove': 'موافقة تلقائية على السائقين',
            'settings.autoApproveDesc': 'الموافقة تلقائياً على تسجيلات السائقين الجدد',
            'settings.emailNotifications': 'إشعارات البريد',
            'settings.emailNotificationsDesc': 'استلام الإشعارات للأحداث المهمة',
            'settings.dispatch': 'خوارزمية التوزيع',
            'settings.dispatchHint': 'أوزان المعايير في اختيار السائق',
            'settings.wDistance': 'المسافة إلى نقطة الركوب',
            'settings.wLocality': 'نفس البلدية / الولاية',
            'settings.wRating': 'تقييم السائق / السجل',
            'settings.wFreshness': 'حداثة الموقع',
            'settings.wWorkload': 'توازن الحمل',
            'settings.dispatchNote': 'محفوظ محلياً في متصفحك.',

            'auth.guest': 'زائر',
            'auth.signInToContinue': 'سجّل الدخول للمتابعة',
            'auth.signIn': 'تسجيل الدخول',
            'auth.signInGoogle': 'الدخول عبر Google',
            'auth.logout': 'تسجيل الخروج',
            'auth.emailLogin': 'دخول بالبريد',
            'auth.emailPassword': 'البريد وكلمة السر',
            'auth.google': 'دخول Google',
            'auth.email': 'البريد الإلكتروني',
            'auth.password': 'كلمة السر',
            'auth.adminLogin': 'تسجيل دخول المسؤول',
            'auth.contactAdmin': 'لا تملك حساباً؟ تواصل مع المسؤول.',
            'auth.googleHint': 'اضغط أعلاه للدخول بحساب Google.',

            'live.streaming': 'بث مباشر',
            'toast.assigned': 'تم تعيين السائق بنجاح',
            'toast.assignFailed': 'فشل تعيين السائق',
            'toast.loginRequired': 'فقط المسؤول يمكنه تنفيذ هذا الإجراء.',
            'toast.approved': 'تمت الموافقة على السائق',
            'toast.rejected': 'تم رفض السائق',
        }
    };

    const STORAGE_KEY = 'tk.lang';
    let currentLang = (localStorage.getItem(STORAGE_KEY) || 'en').toLowerCase();
    if (!DICT[currentLang]) currentLang = 'en';

    function t(key, fallback) {
        const table = DICT[currentLang] || DICT.en;
        if (table[key] != null) return table[key];
        if (DICT.en[key] != null) return DICT.en[key];
        return fallback != null ? fallback : key;
    }

    function applyToNode(node) {
        const key = node.getAttribute('data-i18n');
        if (key) node.textContent = t(key);
        const placeholderKey = node.getAttribute('data-i18n-placeholder');
        if (placeholderKey) node.setAttribute('placeholder', t(placeholderKey));
        const titleKey = node.getAttribute('data-i18n-title');
        if (titleKey) node.setAttribute('title', t(titleKey));
        const ariaKey = node.getAttribute('data-i18n-aria');
        if (ariaKey) node.setAttribute('aria-label', t(ariaKey));
    }

    function apply(root) {
        const scope = root || document;
        scope.querySelectorAll('[data-i18n], [data-i18n-placeholder], [data-i18n-title], [data-i18n-aria]').forEach(applyToNode);
    }

    function setLang(lang) {
        if (!DICT[lang]) lang = 'en';
        currentLang = lang;
        localStorage.setItem(STORAGE_KEY, lang);
        document.documentElement.setAttribute('lang', lang);
        document.documentElement.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
        apply();
        const label = document.getElementById('langToggleLabel');
        if (label) label.textContent = lang === 'ar' ? 'EN' : 'ع';
        const toggleBtn = document.getElementById('langToggle');
        if (toggleBtn) toggleBtn.setAttribute('title', lang === 'ar' ? 'English' : 'العربية');
        document.dispatchEvent(new CustomEvent('i18n:changed', { detail: { lang } }));
    }

    function getLang() { return currentLang; }

    function toggleLang() {
        setLang(currentLang === 'ar' ? 'en' : 'ar');
    }

    // Apply on DOM ready.
    document.addEventListener('DOMContentLoaded', () => {
        setLang(currentLang);
        const toggle = document.getElementById('langToggle');
        if (toggle) toggle.addEventListener('click', toggleLang);
    });

    window.i18n = { t, apply, setLang, getLang, toggleLang };
})();
