# ClinicPlus Appointment Portal — REST API Design & Test Evidence

Context: **Clinic appointment portal (appointment booking and patient-safe data handling)**

## Quick Overview of the 4 Endpoints

| # | Method | Path | Purpose | Primary Status Codes |
|---|--------|------|---------|----------------------|
| 1 | `GET` | `/api/v1/doctors/{doctorId}/availability` | Query open 30-min clinic slots for a doctor on a given date without exposing who booked busy slots | `200 OK`, `400 Bad Request`, `404 Not Found` |
| 2 | `POST` | `/api/v1/appointments` | Book an appointment slot with explicit PHI consent, idempotency support, and double-booking protection | `201 Created`, `200 OK` (idempotent replay), `404 Not Found`, `409 Conflict`, `422 Unprocessable Entity` |
| 3 | `GET` | `/api/v1/patients/{patientId}/appointments` | Retrieve a patient's appointments using a **patient-safe DTO** (redacts `reasonForVisit`, `clinicalNotes`, and masks PII) | `200 OK`, `401 Unauthorized`, `403 Forbidden`, `404 Not Found` |
| 4 | `PATCH` | `/api/v1/appointments/{appointmentId}/cancel` | Soft-cancel an existing appointment with audit preservation and ownership verification | `200 OK`, `401 Unauthorized`, `403 Forbidden`, `404 Not Found`, `409 Conflict`, `422 Unprocessable Entity` |

---

## Patient-Safe Data Handling Principles Applied

1. **Write-Only Symptom Intake (`reasonForVisit`) & Clinical Notes Redaction**:
   Patients submit `reasonForVisit` during `POST /api/v1/appointments` so the clinician's internal EHR receives triage context, but **portal API responses never echo back `reasonForVisit` or `clinicalNotes`**. This prevents PHI exposure in browser caches, shared family devices, proxies, or frontend state logs.
2. **PII Masking in Portal Responses**:
   Responses return only `patientSummary.maskedPatientId` (`***412`) and `displayName` (`Meera N.`), omitting full national IDs, date of birth, phone numbers, and email addresses.
3. **Zero-Leakage Availability**:
   `GET /api/v1/doctors/{doctorId}/availability` exposes only `{ "available": true | false }` booleans per time slot—never exposing patient IDs or appointment IDs of other patients occupying a slot.
4. **No-Store HTTP Caching & BOLA Protection**:
   Every response sets `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. Patient endpoints verify `Authorization: Bearer <token>` and patient scope (`X-Patient-Context`) to prevent Broken Object Level Authorization (BOLA / IDOR).

---

## Detailed Endpoint Specifications

### 1. Query Practitioner Slot Availability
- **Method & Path**: `GET /api/v1/doctors/{doctorId}/availability?date=YYYY-MM-DD&visitType=IN_PERSON`
- **Validation Rules**:
  - `doctorId` (path, required): String matching `^doc_[a-zA-Z0-9]{4,12}$`.
  - `date` (query, required): ISO date string matching `^\d{4}-\d{2}-\d{2}$`.
  - `visitType` (query, optional): Enum `IN_PERSON` or `TELEHEALTH`.
- **Status Codes**:
  - `200 OK` — Availability schedule returned.
  - `400 Bad Request` — Invalid `doctorId` pattern, missing/malformed `date`, or invalid `visitType`.
  - `404 Not Found` — Doctor does not exist.
- **Response JSON (`200 OK`)**:
```json
{
  "doctorId": "doc_1024",
  "doctorName": "Dr. Ananya Sharma",
  "specialty": "Cardiology",
  "date": "2026-12-01",
  "timezone": "Asia/Kolkata (+05:30)",
  "slotDurationMinutes": 30,
  "availableCount": 7,
  "slots": [
    {
      "slotStart": "2026-12-01T09:00:00+05:30",
      "slotEnd": "2026-12-01T09:30:00+05:30",
      "available": true,
      "supportedVisitTypes": ["IN_PERSON", "TELEHEALTH"]
    },
    {
      "slotStart": "2026-12-01T09:30:00+05:30",
      "slotEnd": "2026-12-01T10:00:00+05:30",
      "available": false,
      "supportedVisitTypes": ["IN_PERSON", "TELEHEALTH"]
    }
  ]
}
```

---

### 2. Book a Clinic Appointment
- **Method & Path**: `POST /api/v1/appointments`
- **Headers**:
  - `Content-Type: application/json`
  - `Idempotency-Key: <unique-client-key>` (optional, prevents duplicate booking on network retry)
- **Validation Rules**:
  - `patientId` (required): String matching `^pat_[a-zA-Z0-9]{4,12}$`.
  - `doctorId` (required): String matching `^doc_[a-zA-Z0-9]{4,12}$`.
  - `slotStart` (required): ISO-8601 timestamp with timezone offset aligned to `:00` or `:30` minute boundary.
  - `visitType` (required): Enum `IN_PERSON` | `TELEHEALTH`.
  - `reasonForVisit` (required): String, 5–250 characters, no `<`, `>`, or `script` tags.
  - `patientConsentAccepted` (required): Boolean, must be strictly `true`.
- **Status Codes**:
  - `201 Created` — Appointment booked; returns patient-safe projection + `Location` header.
  - `200 OK` — Returned when an identical `Idempotency-Key` is replayed (`X-Idempotent-Replay: true`).
  - `400 Bad Request` — Malformed JSON body.
  - `404 Not Found` — Referenced `doctorId` or `patientId` does not exist.
  - `409 Conflict` — Double-booking conflict (`SLOT_ALREADY_BOOKED`).
  - `422 Unprocessable Entity` — Field validation or consent failure.
- **Request JSON**:
```json
{
  "patientId": "pat_88412",
  "doctorId": "doc_1024",
  "slotStart": "2026-12-01T10:00:00+05:30",
  "visitType": "IN_PERSON",
  "reasonForVisit": "Annual hypertension follow-up and blood pressure check",
  "patientConsentAccepted": true
}
```
- **Response JSON (`201 Created`)**:
```json
{
  "appointmentId": "apt_90210",
  "status": "CONFIRMED",
  "doctor": {
    "doctorId": "doc_1024",
    "name": "Dr. Ananya Sharma",
    "specialty": "Cardiology"
  },
  "patientSummary": {
    "maskedPatientId": "***412",
    "displayName": "Meera N."
  },
  "slotStart": "2026-12-01T10:00:00+05:30",
  "slotEnd": "2026-12-01T10:30:00+05:30",
  "visitType": "IN_PERSON",
  "privacyNotice": "Clinical notes, reasonForVisit, and full PII are redacted in portal responses.",
  "createdAt": "2026-11-25T07:36:25.119Z",
  "updatedAt": "2026-11-25T07:36:25.119Z"
}
```
- **Error Response JSON (`409 Conflict` — Double-Booking Slot Conflict)**:
```json
{
  "error": {
    "code": "SLOT_ALREADY_BOOKED",
    "message": "The requested practitioner time slot is no longer available.",
    "status": 409,
    "instance": "/api/v1/appointments",
    "timestamp": "2026-11-25T07:36:25.133Z",
    "details": [
      {
        "field": "slotStart",
        "rejectedValue": "2026-12-01T10:00:00+05:30",
        "issue": "Doctor doc_1024 already has a confirmed booking at 2026-12-01T10:00:00+05:30."
      }
    ]
  }
}
```

---

### 3. List Patient's Appointments (Patient-Safe Redacted View)
- **Method & Path**: `GET /api/v1/patients/{patientId}/appointments?status=CONFIRMED`
- **Headers**:
  - `Authorization: Bearer <patient-jwt>` (required)
  - `X-Patient-Context: <authenticated-patientId>` (enforces object-level authorization matching `{patientId}`)
- **Validation Rules**:
  - `patientId` (path, required): Must match authenticated patient context (`403 Forbidden` if mismatched).
  - `status` (query, optional): Enum `CONFIRMED` | `CANCELLED`.
- **Status Codes**:
  - `200 OK` — List of patient-safe appointment records.
  - `400 Bad Request` — Invalid `status` query parameter.
  - `401 Unauthorized` — Missing or malformed Bearer token.
  - `403 Forbidden` — Token scope does not match `{patientId}` (BOLA protection).
  - `404 Not Found` — Patient record not found.
- **Response JSON (`200 OK`)**:
```json
{
  "patientSummary": {
    "maskedPatientId": "***412",
    "displayName": "Meera N."
  },
  "totalCount": 1,
  "data": [
    {
      "appointmentId": "apt_90210",
      "status": "CONFIRMED",
      "doctor": {
        "doctorId": "doc_1024",
        "name": "Dr. Ananya Sharma",
        "specialty": "Cardiology"
      },
      "patientSummary": {
        "maskedPatientId": "***412",
        "displayName": "Meera N."
      },
      "slotStart": "2026-12-01T10:00:00+05:30",
      "slotEnd": "2026-12-01T10:30:00+05:30",
      "visitType": "IN_PERSON",
      "privacyNotice": "Clinical notes, reasonForVisit, and full PII are redacted in portal responses.",
      "createdAt": "2026-11-25T07:36:25.119Z",
      "updatedAt": "2026-11-25T07:36:25.119Z"
    }
  ]
}
```

---

### 4. Cancel an Appointment (Soft-Cancel Lifecycle)
- **Method & Path**: `PATCH /api/v1/appointments/{appointmentId}/cancel`
- **Headers**:
  - `Authorization: Bearer <patient-jwt>` (required)
  - `Content-Type: application/json`
- **Validation Rules**:
  - `appointmentId` (path, required): Valid appointment identifier.
  - `patientId` (body, required): String matching `^pat_[a-zA-Z0-9]{4,12}$`; must match the appointment owner.
  - `cancellationReason` (body, required): Enum `PATIENT_REQUEST` | `SCHEDULING_CONFLICT` | `SYMPTOMS_RESOLVED` | `OTHER`.
- **Status Codes**:
  - `200 OK` — Appointment state transitioned to `CANCELLED` and slot released back to availability pool.
  - `401 Unauthorized` — Missing Bearer token.
  - `403 Forbidden` — `patientId` does not own the target appointment.
  - `404 Not Found` — `appointmentId` does not exist.
  - `409 Conflict` — Appointment is already `CANCELLED`.
  - `422 Unprocessable Entity` — Missing or invalid `cancellationReason` or `patientId`.
- **Request JSON**:
```json
{
  "patientId": "pat_88412",
  "cancellationReason": "SCHEDULING_CONFLICT"
}
```
- **Response JSON (`200 OK`)**:
```json
{
  "appointmentId": "apt_90210",
  "status": "CANCELLED",
  "doctor": {
    "doctorId": "doc_1024",
    "name": "Dr. Ananya Sharma",
    "specialty": "Cardiology"
  },
  "patientSummary": {
    "maskedPatientId": "***412",
    "displayName": "Meera N."
  },
  "slotStart": "2026-12-01T10:00:00+05:30",
  "slotEnd": "2026-12-01T10:30:00+05:30",
  "visitType": "IN_PERSON",
  "privacyNotice": "Clinical notes, reasonForVisit, and full PII are redacted in portal responses.",
  "createdAt": "2026-11-25T07:36:25.119Z",
  "updatedAt": "2026-11-25T07:36:25.159Z",
  "cancellationReason": "SCHEDULING_CONFLICT",
  "cancelledAt": "2026-11-25T07:36:25.159Z"
}
```

---

## Architectural Trade-Off Note

### 1. Patient-Safe DTO Redaction vs. Single Full-Resource Payload
- **Decision**: Strip `reasonForVisit`, `clinicalNotes`, and unmasked patient PII (`phone`, `email`, `nationalId`, `dateOfBirth`) from all patient portal responses (`POST /api/v1/appointments`, `GET /api/v1/patients/{patientId}/appointments`, `PATCH .../cancel`), treating `reasonForVisit` as **write-only** on the public booking portal.
- **Trade-Off**: If a patient or clinician later wants to view or edit the detailed symptom narrative, the frontend cannot simply read it from the appointment list payload—it requires a separate, step-up authenticated clinician/EHR endpoint (`/api/v1/ehr/appointments/{id}/clinical-intake`). However, this extra hop dramatically reduces accidental PHI/HIPAA leakage in shared devices, browser storage, and reverse-proxy logs.

### 2. State-Transition `PATCH .../cancel` vs. Hard `DELETE /api/v1/appointments/{id}`
- **Decision**: Use `PATCH /api/v1/appointments/{appointmentId}/cancel` to transition `status` from `CONFIRMED` to `CANCELLED` while recording `cancellationReason` and `cancelledAt`, rather than executing a hard `DELETE`.
- **Trade-Off**: Soft cancellation consumes slightly more storage and requires partial unique indexing (`WHERE status = 'CONFIRMED'`) so cancelled slots can be re-booked. In healthcare systems, however, preserving an immutable audit trail of who booked and cancelled a clinical slot (and why) is mandatory for medical-legal compliance and no-show analytics.
