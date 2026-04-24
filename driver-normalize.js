/**
 * Map Firestore `drivers/{docId}` → dashboard / report shape.
 * Exposes: window.normalizeDriverFromFirestore(docId, data)
 */
(function () {
    'use strict';

    function toIsoString(value) {
        if (value == null || value === '') return '';
        if (typeof value.toDate === 'function') {
            try { const d = value.toDate(); return isNaN(d.getTime()) ? '' : d.toISOString(); } catch { return ''; }
        }
        if (typeof value.toMillis === 'function') {
            try { const d = new Date(value.toMillis()); return isNaN(d.getTime()) ? '' : d.toISOString(); } catch { return ''; }
        }
        if (value instanceof Date) return isNaN(value.getTime()) ? '' : value.toISOString();
        if (typeof value === 'string') { const d = new Date(value); return isNaN(d.getTime()) ? String(value) : d.toISOString(); }
        if (typeof value === 'number') { const d = new Date(value); return isNaN(d.getTime()) ? '' : d.toISOString(); }
        return '';
    }

    function parseWilaya(w) {
        if (w == null || w === '') return { display: '', code: '', name: '' };
        if (typeof w === 'string') { const s = w.trim(); return { display: s, code: '', name: s }; }
        if (typeof w !== 'object') return { display: '', code: '', name: '' };
        const name = w.name != null ? String(w.name).trim() : '';
        const code = w.code != null ? String(w.code).trim() : '';
        const display = (name && code) ? `${name} (${code})` : (name || code);
        return { display, code, name };
    }

    function parseBaladia(b) {
        if (b == null || b === '') return { display: '', id: '', name: '' };
        if (typeof b === 'string') { const s = b.trim(); return { display: s, id: '', name: s }; }
        if (typeof b !== 'object') return { display: '', id: '', name: '' };
        const name = b.name != null ? String(b.name).trim() : '';
        const id = b.id != null ? String(b.id).trim() : '';
        return { display: name || id, id, name };
    }

    function deriveDriverStatus(data) {
        if (data.isApproved === true) return 'approved';
        const kyc = data.kyc;
        if (kyc && (kyc.status === 'rejected' || kyc.status === 'declined')) return 'rejected';
        if (data.status === 'rejected' || data.rejected === true) return 'rejected';
        return 'pending';
    }

    function pickLicenseImages(data, kyc, rootLicense, kycLicense) {
        const front =
            kycLicense.frontPhoto || kycLicense.frontPhotoUrl || kycLicense.frontUrl ||
            kycLicense.frontImageUrl || kycLicense.front ||
            rootLicense.frontPhoto || rootLicense.frontUrl || rootLicense.frontImageUrl || rootLicense.front ||
            data.licenseFrontUrl || data.drivingLicenseFrontUrl ||
            kyc.licenseFrontUrl || kyc.idFrontUrl ||
            (kycLicense.images && kycLicense.images[0]) || (rootLicense.images && rootLicense.images[0]) || '';
        const back =
            kycLicense.backPhoto || kycLicense.backPhotoUrl || kycLicense.backUrl ||
            kycLicense.backImageUrl || kycLicense.back ||
            rootLicense.backPhoto || rootLicense.backUrl || rootLicense.backImageUrl || rootLicense.back ||
            data.licenseBackUrl || data.drivingLicenseBackUrl ||
            kyc.licenseBackUrl || kyc.idBackUrl ||
            (kycLicense.images && kycLicense.images[1]) || (rootLicense.images && rootLicense.images[1]) || '';
        return { licenseFrontUrl: front || '', licenseBackUrl: back || '' };
    }

    function numOrNull(v) {
        if (v == null || v === '') return null;
        const raw = typeof v === 'string' ? v.trim().replace(',', '.') : v;
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
    }

    window.normalizeDriverFromFirestore = function normalizeDriverFromFirestore(docId, data) {
        data = data || {};
        const kyc = data.kyc && typeof data.kyc === 'object' ? data.kyc : {};

        const rootLicense =
            data.license && typeof data.license === 'object' ? data.license :
            data.drivingLicense && typeof data.drivingLicense === 'object' ? data.drivingLicense : {};
        const kycLicense =
            kyc.license && typeof kyc.license === 'object' ? kyc.license :
            kyc.licence && typeof kyc.licence === 'object' ? kyc.licence : {};
        const greyCard = kyc.greyCard && typeof kyc.greyCard === 'object' ? kyc.greyCard : {};
        const judicialRecord = kyc.judicialRecord && typeof kyc.judicialRecord === 'object' ? kyc.judicialRecord : {};
        const medicalCert = kyc.medicalCert && typeof kyc.medicalCert === 'object' ? kyc.medicalCert : {};

        const vehicle =
            (kyc.vehicle && typeof kyc.vehicle === 'object') ? kyc.vehicle :
            (data.vehicle && typeof data.vehicle === 'object') ? data.vehicle : {};

        const startLocation =
            data.startLocation && typeof data.startLocation === 'object' ? data.startLocation :
            data.startlocation && typeof data.startlocation === 'object' ? data.startlocation : {};
        const location = data.location && typeof data.location === 'object' ? data.location : {};
        const currentLocation = data.currentLocation && typeof data.currentLocation === 'object' ? data.currentLocation : {};
        const imgs = pickLicenseImages(data, kyc, rootLicense, kycLicense);
        const wilayaParts = parseWilaya(data.wilaya);
        const baladiaParts = parseBaladia(data.baladia);

        const profilePhotoUrl =
            data.facePhotoUrl || data.profilePhotoUrl || data.photoUrl ||
            data.avatarUrl || data.profileImageUrl || kyc.selfieUrl || '';

        return {
            __docId: docId,
            id: docId,
            name: data.fullName || [data.firstName, data.lastName].filter(Boolean).join(' ') || data.name || 'Unknown',
            firstName: data.firstName || '',
            lastName: data.lastName || '',
            email: data.email || 'N/A',
            phone: data.phone || 'N/A',
            emailVerified: data.emailVerified === true,
            status: deriveDriverStatus(data),
            isApproved: data.isApproved === true,
            isAvailable: data.isAvailable === true,
            isOnline: data.isOnline === true,
            canReceiveTrips: data.canReceiveTrips !== false,
            availableSeats: Number.isFinite(Number(data.availableSeats)) ? Number(data.availableSeats) : null,
            capacity: Number.isFinite(Number(data.capacity)) ? Number(data.capacity) : null,
            profileComplete: data.profileComplete === true,
            role: data.role || '',
            bloodType: data.bloodType || '',
            gender: data.gender || '',
            familyStatus: data.familyStatus || '',
            registrationDate: toIsoString(data.createdAt) || new Date().toISOString(),
            updatedAt: toIsoString(data.updatedAt) || '',
            wilaya: wilayaParts.display || data.province || data.region || '',
            wilayaCode: wilayaParts.code,
            wilayaName: wilayaParts.name,
            baladia: baladiaParts.display,
            baladiaId: baladiaParts.id,
            baladiaName: baladiaParts.name,
            address: data.address || data.streetAddress || '',
            nationalId: data.nationalId || data.nin || data.nationalID || '',
            dateOfBirth: toIsoString(data.dateOfBirth || data.dob) || '',
            profilePhotoUrl,
            licenseFrontUrl: imgs.licenseFrontUrl,
            licenseBackUrl: imgs.licenseBackUrl,
            licenseNumber:
                kycLicense.number || kycLicense.licenseNumber ||
                rootLicense.number || rootLicense.licenseNumber ||
                data.licenseNumber || '',
            licenseCategory: kycLicense.category || '',
            licenseExpiryDate: kycLicense.expiryDate || '',
            licenseVerified: kycLicense.verified === true,
            greyCardPhotoUrl: greyCard.photo || '',
            greyCardRegistration: greyCard.registrationNumber || '',
            greyCardVerified: greyCard.verified === true,
            judicialRecordPhotoUrl: judicialRecord.photo || '',
            judicialRecordVerified: judicialRecord.verified === true,
            judicialRecordIssueDate: judicialRecord.issueDate || '',
            medicalCertPhotoUrl: medicalCert.photo || '',
            medicalCertDoctor: medicalCert.doctorName || '',
            medicalCertIssueDate: medicalCert.issueDate || '',
            medicalCertExpiryDate: medicalCert.expiryDate || '',
            medicalCertVerified: medicalCert.verified === true,

            vehicleMake:  vehicle.brand || vehicle.make || data.vehicleMake || '',
            vehicleModel: vehicle.model || data.vehicleModel || '',
            vehiclePlate:
                vehicle.plateNumber || vehicle.plate ||
                vehicle.registrationPlate || vehicle.registrationNumber ||
                data.vehiclePlate || data.plate || '',
            vehicleYear:  vehicle.year  != null ? String(vehicle.year)  : data.vehicleYear  != null ? String(data.vehicleYear)  : '',
            vehicleColor: vehicle.color || data.vehicleColor || '',

            kycStatus: kyc.status || '',
            kycReviewedAt: toIsoString(kyc.reviewedAt) || '',
            kycSubmittedAt: toIsoString(kyc.submittedAt) || '',
            kycNotes:
                kyc.reviewNotes || kyc.review_notes || kyc.notes ||
                kyc.rejectionReason || kyc.comment || '',

            startLocation,
            locationLat: numOrNull(
                startLocation.lat ?? startLocation.latitude ?? startLocation._lat ??
                location.lat ?? location.latitude ?? location._lat ??
                currentLocation.lat ?? currentLocation.latitude ?? currentLocation._lat ??
                data.locationLat ?? data.latitude ?? data.currentLat ?? data.currentLatitude ?? data.lat
            ),
            locationLng: numOrNull(
                startLocation.lng ?? startLocation.longitude ?? startLocation._lng ??
                startLocation._long ?? startLocation.lon ?? startLocation.long ??
                location.lng ?? location.longitude ?? location._lng ??
                location._long ?? location.lon ?? location.long ??
                currentLocation.lng ?? currentLocation.longitude ?? currentLocation._lng ??
                currentLocation._long ?? currentLocation.lon ?? currentLocation.long ??
                data.locationLng ?? data.longitude ?? data.currentLng ??
                data.currentLongitude ?? data.lng ?? data.long
            ),
            locationUpdatedAt:
                toIsoString(startLocation.locationUpdatedAt) ||
                toIsoString(startLocation.updatedAt) ||
                toIsoString(location.locationUpdatedAt) ||
                toIsoString(currentLocation.locationUpdatedAt) ||
                toIsoString(data.startLocationUpdatedAt) ||
                toIsoString(data.locationUpdatedAt) || '',
            startLocationUpdatedAt:
                toIsoString(data.startLocationUpdatedAt) ||
                toIsoString(startLocation.updatedAt) || '',
            completedTrips: Number.isFinite(Number(data.completedTrips)) ? Number(data.completedTrips) : null,
            cancelledTrips: Number.isFinite(Number(data.cancelledTrips)) ? Number(data.cancelledTrips) : null,
            rating: Number.isFinite(Number(data.rating)) ? Number(data.rating) : null,
        };
    };
})();
