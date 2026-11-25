#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"

run_curl() {
  if [[ -n "${UNIX_SOCKET:-}" ]]; then
    curl -i -s --unix-socket "$UNIX_SOCKET" "$@"
  else
    curl -i -s "$@"
  fi
}

echo "================================================================================"
echo "TEST 1: GET /api/v1/doctors/doc_1024/availability?date=2026-12-01 (200 OK)"
echo "================================================================================"
run_curl -X GET "${BASE_URL}/api/v1/doctors/doc_1024/availability?date=2026-12-01"
echo ""

echo "================================================================================"
echo "TEST 2: POST /api/v1/appointments - Create Appointment (201 Created)"
echo "================================================================================"
run_curl -X POST "${BASE_URL}/api/v1/appointments" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: idem-booking-20261201-1000" \
  -d '{
    "patientId": "pat_88412",
    "doctorId": "doc_1024",
    "slotStart": "2026-12-01T10:00:00+05:30",
    "visitType": "IN_PERSON",
    "reasonForVisit": "Annual hypertension follow-up and blood pressure check",
    "patientConsentAccepted": true
  }'
echo ""

echo "================================================================================"
echo "TEST 3: POST /api/v1/appointments - Double-Booking Conflict Error (409 Conflict)"
echo "================================================================================"
run_curl -X POST "${BASE_URL}/api/v1/appointments" \
  -H "Content-Type: application/json" \
  -d '{
    "patientId": "pat_88412",
    "doctorId": "doc_1024",
    "slotStart": "2026-12-01T10:00:00+05:30",
    "visitType": "TELEHEALTH",
    "reasonForVisit": "Second overlapping booking attempt on same slot",
    "patientConsentAccepted": true
  }'
echo ""

echo "================================================================================"
echo "TEST 4: GET /api/v1/patients/pat_88412/appointments - Patient-Safe List (200 OK)"
echo "================================================================================"
run_curl -X GET "${BASE_URL}/api/v1/patients/pat_88412/appointments?status=CONFIRMED" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.pat_88412" \
  -H "X-Patient-Context: pat_88412"
echo ""

echo "================================================================================"
echo "TEST 5: PATCH /api/v1/appointments/apt_90210/cancel - Cancel Booking (200 OK)"
echo "================================================================================"
run_curl -X PATCH "${BASE_URL}/api/v1/appointments/apt_90210/cancel" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.pat_88412" \
  -H "Content-Type: application/json" \
  -d '{
    "patientId": "pat_88412",
    "cancellationReason": "SCHEDULING_CONFLICT"
  }'
echo ""
