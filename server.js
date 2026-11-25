const http = require('http');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const UNIX_SOCKET = process.env.UNIX_SOCKET || '';

// Seeded data store (in-memory for deterministic demo & testing)
const doctors = new Map([
  [
    'doc_1024',
    {
      doctorId: 'doc_1024',
      doctorName: 'Dr. Ananya Sharma',
      specialty: 'Cardiology',
      slotDurationMinutes: 30,
      dailySlots: ['09:00', '09:30', '10:00', '10:30', '11:00', '14:00', '14:30', '15:00']
    }
  ],
  [
    'doc_2048',
    {
      doctorId: 'doc_2048',
      doctorName: 'Dr. Rajesh Verma',
      specialty: 'General Medicine',
      slotDurationMinutes: 30,
      dailySlots: ['10:00', '10:30', '11:00', '11:30', '16:00', '16:30']
    }
  ]
]);

const patients = new Map([
  [
    'pat_88412',
    {
      patientId: 'pat_88412',
      fullName: 'Meera Nair',
      phone: '+91-9876543210',
      email: 'meera.nair@example.com',
      nationalId: 'XXXX-XXXX-4829',
      dateOfBirth: '1988-04-12'
    }
  ]
]);

// Map of appointmentId -> appointment record
const appointments = new Map([
  [
    'apt_89900',
    {
      appointmentId: 'apt_89900',
      patientId: 'pat_99100', // Another patient occupying 09:30 slot on 2026-12-01
      doctorId: 'doc_1024',
      slotStart: '2026-12-01T09:30:00+05:30',
      slotEnd: '2026-12-01T10:00:00+05:30',
      visitType: 'IN_PERSON',
      status: 'CONFIRMED',
      reasonForVisit: 'Routine ECG review',
      clinicalNotes: 'BP stable 120/78',
      patientConsentAccepted: true,
      createdAt: '2026-11-24T10:00:00Z',
      updatedAt: '2026-11-24T10:00:00Z'
    }
  ]
]);

// Map of idempotencyKey -> appointmentId
const idempotencyStore = new Map();
let nextAptSeq = 90210;

// Helpers for patient-safe masking & redaction
function maskPatientName(fullName) {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

function maskPatientId(patientId) {
  return `***${patientId.slice(-3)}`;
}

/**
 * Projects an internal appointment object into a patient-safe DTO.
 * Redacts: reasonForVisit, clinicalNotes, full phone/email/nationalId/DOB.
 */
function toPatientSafeAppointment(apt) {
  const doc = doctors.get(apt.doctorId);
  const pat = patients.get(apt.patientId);
  const response = {
    appointmentId: apt.appointmentId,
    status: apt.status,
    doctor: {
      doctorId: apt.doctorId,
      name: doc ? doc.doctorName : 'Unknown Doctor',
      specialty: doc ? doc.specialty : 'General'
    },
    patientSummary: {
      maskedPatientId: maskPatientId(apt.patientId),
      displayName: pat ? maskPatientName(pat.fullName) : 'Patient'
    },
    slotStart: apt.slotStart,
    slotEnd: apt.slotEnd,
    visitType: apt.visitType,
    privacyNotice: 'Clinical notes, reasonForVisit, and full PII are redacted in portal responses.',
    createdAt: apt.createdAt,
    updatedAt: apt.updatedAt
  };
  if (apt.status === 'CANCELLED') {
    response.cancellationReason = apt.cancellationReason;
    response.cancelledAt = apt.cancelledAt;
  }
  return response;
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders
  });
  res.end(body + '\n');
}

function sendError(res, statusCode, code, message, details = [], instance = '/') {
  sendJson(res, statusCode, {
    error: {
      code,
      message,
      status: statusCode,
      instance,
      timestamp: new Date().toISOString(),
      details
    }
  });
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e5) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
      }
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('INVALID_JSON'));
      }
    });
  });
}

function addMinutesIso(isoStart, minutes) {
  const m = isoStart.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):00([+-]\d{2}:\d{2}|Z)$/);
  if (!m) return null;
  const [, datePart, hh, mm, tz] = m;
  const totalMinutes = parseInt(hh, 10) * 60 + parseInt(mm, 10) + minutes;
  const endH = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
  const endM = String(totalMinutes % 60).padStart(2, '0');
  return `${datePart}T${endH}:${endM}:00${tz}`;
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;
  const method = req.method.toUpperCase();

  // ---------------------------------------------------------------------------
  // ENDPOINT 1: GET /api/v1/doctors/:doctorId/availability?date=YYYY-MM-DD
  // ---------------------------------------------------------------------------
  const availMatch = pathname.match(/^\/api\/v1\/doctors\/([^/]+)\/availability$/);
  if (method === 'GET' && availMatch) {
    const doctorId = availMatch[1];
    const date = parsedUrl.searchParams.get('date');
    const visitTypeFilter = parsedUrl.searchParams.get('visitType');

    const validationErrors = [];
    if (!/^doc_[a-zA-Z0-9]{4,12}$/.test(doctorId)) {
      validationErrors.push({
        field: 'doctorId',
        issue: 'Must match pattern ^doc_[a-zA-Z0-9]{4,12}$'
      });
    }
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      validationErrors.push({
        field: 'date',
        issue: 'Required query parameter in YYYY-MM-DD format'
      });
    }
    if (visitTypeFilter && !['IN_PERSON', 'TELEHEALTH'].includes(visitTypeFilter)) {
      validationErrors.push({
        field: 'visitType',
        issue: 'Optional filter must be IN_PERSON or TELEHEALTH'
      });
    }

    if (validationErrors.length > 0) {
      return sendError(
        res,
        400,
        'VALIDATION_ERROR',
        'Invalid availability query parameters.',
        validationErrors,
        pathname
      );
    }

    const doctor = doctors.get(doctorId);
    if (!doctor) {
      return sendError(
        res,
        404,
        'DOCTOR_NOT_FOUND',
        `No active practitioner found with ID '${doctorId}'.`,
        [{ field: 'doctorId', issue: 'Unknown doctorId' }],
        pathname
      );
    }

    // Build patient-safe availability slots (boolean only; zero info about who booked)
    const slots = doctor.dailySlots.map((timeStr) => {
      const slotStart = `${date}T${timeStr}:00+05:30`;
      const slotEnd = addMinutesIso(slotStart, doctor.slotDurationMinutes);
      let isBooked = false;
      for (const apt of appointments.values()) {
        if (
          apt.doctorId === doctorId &&
          apt.slotStart === slotStart &&
          apt.status === 'CONFIRMED'
        ) {
          isBooked = true;
          break;
        }
      }
      return {
        slotStart,
        slotEnd,
        available: !isBooked,
        supportedVisitTypes: ['IN_PERSON', 'TELEHEALTH']
      };
    });

    return sendJson(res, 200, {
      doctorId: doctor.doctorId,
      doctorName: doctor.doctorName,
      specialty: doctor.specialty,
      date,
      timezone: 'Asia/Kolkata (+05:30)',
      slotDurationMinutes: doctor.slotDurationMinutes,
      availableCount: slots.filter((s) => s.available).length,
      slots
    });
  }

  // ---------------------------------------------------------------------------
  // ENDPOINT 2: POST /api/v1/appointments
  // ---------------------------------------------------------------------------
  if (method === 'POST' && pathname === '/api/v1/appointments') {
    let body;
    try {
      body = await parseJsonBody(req);
    } catch (err) {
      return sendError(
        res,
        400,
        'MALFORMED_JSON',
        'Request body must be valid JSON.',
        [],
        pathname
      );
    }

    const idempotencyKey = req.headers['idempotency-key'];
    if (idempotencyKey && idempotencyStore.has(idempotencyKey)) {
      const existingId = idempotencyStore.get(idempotencyKey);
      const existingApt = appointments.get(existingId);
      return sendJson(res, 200, toPatientSafeAppointment(existingApt), {
        'X-Idempotent-Replay': 'true'
      });
    }

    const details = [];
    if (!body.patientId || !/^pat_[a-zA-Z0-9]{4,12}$/.test(body.patientId)) {
      details.push({
        field: 'patientId',
        issue: 'Required string matching ^pat_[a-zA-Z0-9]{4,12}$'
      });
    }
    if (!body.doctorId || !/^doc_[a-zA-Z0-9]{4,12}$/.test(body.doctorId)) {
      details.push({
        field: 'doctorId',
        issue: 'Required string matching ^doc_[a-zA-Z0-9]{4,12}$'
      });
    }
    const isoMatch =
      typeof body.slotStart === 'string' &&
      body.slotStart.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):00([+-]\d{2}:\d{2}|Z)$/);
    if (!isoMatch) {
      details.push({
        field: 'slotStart',
        issue: 'Required ISO-8601 timestamp aligned to minute boundary (e.g., 2026-12-01T10:00:00+05:30)'
      });
    } else if (!['00', '30'].includes(isoMatch[3])) {
      details.push({
        field: 'slotStart',
        issue: 'Appointments must align to 30-minute clinic slot boundaries (:00 or :30)'
      });
    }
    if (!['IN_PERSON', 'TELEHEALTH'].includes(body.visitType)) {
      details.push({
        field: 'visitType',
        issue: 'Required enum: IN_PERSON or TELEHEALTH'
      });
    }
    if (
      typeof body.reasonForVisit !== 'string' ||
      body.reasonForVisit.trim().length < 5 ||
      body.reasonForVisit.trim().length > 250
    ) {
      details.push({
        field: 'reasonForVisit',
        issue: 'Required string between 5 and 250 characters'
      });
    } else if (/[<>]|script/i.test(body.reasonForVisit)) {
      details.push({
        field: 'reasonForVisit',
        issue: 'Contains disallowed HTML/script characters'
      });
    }
    if (body.patientConsentAccepted !== true) {
      details.push({
        field: 'patientConsentAccepted',
        issue: 'Must be explicitly true to consent to clinic PHI processing'
      });
    }

    if (details.length > 0) {
      return sendError(
        res,
        422,
        'UNPROCESSABLE_ENTITY',
        'Appointment request failed validation rules.',
        details,
        pathname
      );
    }

    const doctor = doctors.get(body.doctorId);
    if (!doctor) {
      return sendError(
        res,
        404,
        'DOCTOR_NOT_FOUND',
        `Doctor '${body.doctorId}' does not exist.`,
        [{ field: 'doctorId', issue: 'Not found' }],
        pathname
      );
    }
    const patient = patients.get(body.patientId);
    if (!patient) {
      return sendError(
        res,
        404,
        'PATIENT_NOT_FOUND',
        `Patient '${body.patientId}' is not registered.`,
        [{ field: 'patientId', issue: 'Not found' }],
        pathname
      );
    }

    // Check double-booking conflict for the same doctor & slotStart
    for (const apt of appointments.values()) {
      if (
        apt.doctorId === body.doctorId &&
        apt.slotStart === body.slotStart &&
        apt.status === 'CONFIRMED'
      ) {
        return sendError(
          res,
          409,
          'SLOT_ALREADY_BOOKED',
          'The requested practitioner time slot is no longer available.',
          [
            {
              field: 'slotStart',
              rejectedValue: body.slotStart,
              issue: `Doctor ${body.doctorId} already has a confirmed booking at ${body.slotStart}.`
            }
          ],
          pathname
        );
      }
    }

    const appointmentId = `apt_${nextAptSeq++}`;
    const nowIso = new Date().toISOString();
    const newApt = {
      appointmentId,
      patientId: body.patientId,
      doctorId: body.doctorId,
      slotStart: body.slotStart,
      slotEnd: addMinutesIso(body.slotStart, doctor.slotDurationMinutes),
      visitType: body.visitType,
      status: 'CONFIRMED',
      reasonForVisit: body.reasonForVisit.trim(), // Stored internally for clinician EHR, redacted in portal response
      clinicalNotes: null,
      patientConsentAccepted: true,
      createdAt: nowIso,
      updatedAt: nowIso
    };

    appointments.set(appointmentId, newApt);
    if (idempotencyKey) {
      idempotencyStore.set(idempotencyKey, appointmentId);
    }

    return sendJson(res, 201, toPatientSafeAppointment(newApt), {
      Location: `/api/v1/patients/${body.patientId}/appointments`
    });
  }

  // ---------------------------------------------------------------------------
  // ENDPOINT 3: GET /api/v1/patients/:patientId/appointments
  // ---------------------------------------------------------------------------
  const patAptsMatch = pathname.match(/^\/api\/v1\/patients\/([^/]+)\/appointments$/);
  if (method === 'GET' && patAptsMatch) {
    const patientId = patAptsMatch[1];
    const authHeader = req.headers['authorization'] || '';
    const scopedPatientHeader = req.headers['x-patient-context'] || '';

    // Patient-safe BOLA (Broken Object Level Authorization) check
    if (!authHeader.startsWith('Bearer ')) {
      return sendError(
        res,
        401,
        'UNAUTHORIZED',
        'Missing or invalid Bearer authentication token.',
        [{ field: 'Authorization', issue: 'Bearer token required' }],
        pathname
      );
    }
    if (scopedPatientHeader && scopedPatientHeader !== patientId) {
      return sendError(
        res,
        403,
        'FORBIDDEN_PATIENT_SCOPE',
        'Access denied: Authenticated token scope does not match requested patientId.',
        [
          {
            field: 'patientId',
            issue: 'Cross-patient record access is strictly prohibited (BOLA protection).'
          }
        ],
        pathname
      );
    }

    if (!patients.has(patientId)) {
      return sendError(
        res,
        404,
        'PATIENT_NOT_FOUND',
        `Patient '${patientId}' not found.`,
        [{ field: 'patientId', issue: 'Unknown patientId' }],
        pathname
      );
    }

    const statusFilter = parsedUrl.searchParams.get('status');
    if (statusFilter && !['CONFIRMED', 'CANCELLED'].includes(statusFilter)) {
      return sendError(
        res,
        400,
        'VALIDATION_ERROR',
        'Invalid status query filter.',
        [{ field: 'status', issue: 'Allowed values: CONFIRMED, CANCELLED' }],
        pathname
      );
    }

    const items = [];
    for (const apt of appointments.values()) {
      if (apt.patientId === patientId) {
        if (!statusFilter || apt.status === statusFilter) {
          items.push(toPatientSafeAppointment(apt));
        }
      }
    }

    return sendJson(res, 200, {
      patientSummary: {
        maskedPatientId: maskPatientId(patientId),
        displayName: maskPatientName(patients.get(patientId).fullName)
      },
      totalCount: items.length,
      data: items
    });
  }

  // ---------------------------------------------------------------------------
  // ENDPOINT 4: PATCH /api/v1/appointments/:appointmentId/cancel
  // ---------------------------------------------------------------------------
  const cancelMatch = pathname.match(/^\/api\/v1\/appointments\/([^/]+)\/cancel$/);
  if (method === 'PATCH' && cancelMatch) {
    const appointmentId = cancelMatch[1];
    const authHeader = req.headers['authorization'] || '';
    if (!authHeader.startsWith('Bearer ')) {
      return sendError(
        res,
        401,
        'UNAUTHORIZED',
        'Missing or invalid Bearer authentication token.',
        [{ field: 'Authorization', issue: 'Bearer token required' }],
        pathname
      );
    }

    let body;
    try {
      body = await parseJsonBody(req);
    } catch (err) {
      return sendError(res, 400, 'MALFORMED_JSON', 'Request body must be valid JSON.', [], pathname);
    }

    const details = [];
    if (!body.patientId || !/^pat_[a-zA-Z0-9]{4,12}$/.test(body.patientId)) {
      details.push({
        field: 'patientId',
        issue: 'Required string matching ^pat_[a-zA-Z0-9]{4,12}$ to verify ownership'
      });
    }
    const allowedReasons = ['PATIENT_REQUEST', 'SCHEDULING_CONFLICT', 'SYMPTOMS_RESOLVED', 'OTHER'];
    if (!allowedReasons.includes(body.cancellationReason)) {
      details.push({
        field: 'cancellationReason',
        issue: `Required enum: ${allowedReasons.join(', ')}`
      });
    }

    if (details.length > 0) {
      return sendError(
        res,
        422,
        'UNPROCESSABLE_ENTITY',
        'Cancellation payload failed validation.',
        details,
        pathname
      );
    }

    const apt = appointments.get(appointmentId);
    if (!apt) {
      return sendError(
        res,
        404,
        'APPOINTMENT_NOT_FOUND',
        `Appointment '${appointmentId}' does not exist.`,
        [{ field: 'appointmentId', issue: 'Unknown appointmentId' }],
        pathname
      );
    }

    if (apt.patientId !== body.patientId) {
      return sendError(
        res,
        403,
        'FORBIDDEN_OWNERSHIP_MISMATCH',
        'You do not have permission to cancel another patient’s appointment.',
        [{ field: 'patientId', issue: 'Ownership verification failed' }],
        pathname
      );
    }

    if (apt.status === 'CANCELLED') {
      return sendError(
        res,
        409,
        'APPOINTMENT_ALREADY_CANCELLED',
        `Appointment '${appointmentId}' has already been cancelled.`,
        [{ field: 'status', issue: 'Current status is already CANCELLED' }],
        pathname
      );
    }

    const nowIso = new Date().toISOString();
    apt.status = 'CANCELLED';
    apt.cancellationReason = body.cancellationReason;
    apt.cancelledAt = nowIso;
    apt.updatedAt = nowIso;

    return sendJson(res, 200, toPatientSafeAppointment(apt));
  }

  return sendError(res, 404, 'ROUTE_NOT_FOUND', `Route ${method} ${pathname} not found.`, [], pathname);
});

if (UNIX_SOCKET) {
  server.listen(UNIX_SOCKET, () => {
    console.log(`ClinicPlus REST API listening on unix:${UNIX_SOCKET}`);
  });
} else {
  server.listen(PORT, () => {
    console.log(`ClinicPlus REST API listening on http://localhost:${PORT}`);
  });
}
