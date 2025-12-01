// ===== GLOBAL STATE & CONSTANTS =====
let rpmEvents = [];
let doctors = [];
let patients = [];

const state = {
  role: null,
  doctor: null,
  patient: null,
  doctorEventsBase: [],
  doctorEventsLimit: 10,
  doctorEventsFilter: "all",
  doctorEventsPatientFilter: "all",
  patientEventsBase: [],
  patientEventsLimit: 10,
  patientEventsFilter: "all",
};

const STORAGE_KEY_CREDS = "rccCredentials";
const STORAGE_KEY_MEETINGS = "rccMeetings";
const STORAGE_KEY_NOTIFICATIONS = "rccNotifications";
const STORAGE_KEY_LOGIN_ATTEMPTS = "rccLoginAttempts";
const STORAGE_KEY_LAST_LOGIN = "rccLastLogin";

let meetings = [];
let notifications = [];
let loginAttempts = {};
let lastLogin = {};

const SESSION_TIMEOUT_MINUTES = 15;
let sessionTimer = null;
let lastActivityTime = null;

// Seed meetings (first-run)
const defaultMeetings = [
  {
    id: "M-1001",
    doctor_id: "D001",
    patient_id: "P001",
    datetime: "2025-12-01T09:30",
    type: "Virtual check-in",
    status: "Scheduled",
    createdBy: "system",
  },
  {
    id: "M-1002",
    doctor_id: "D001",
    patient_id: "P002",
    datetime: "2025-12-01T14:00",
    type: "Follow-up",
    status: "Scheduled",
    createdBy: "system",
  },
  {
    id: "M-1003",
    doctor_id: "D002",
    patient_id: "P003",
    datetime: "2025-11-29T10:00",
    type: "Initial consult",
    status: "Completed",
    createdBy: "system",
  },
];

// Seed notifications (first-run)
const defaultNotifications = [
  {
    id: "N-2001",
    role: "doctor",
    doctor_id: "D001",
    patient_id: "P001",
    level: "high",
    message: "High severity alert for P001 – SpO₂ trend requires review.",
    time: "2025-11-30T08:15",
  },
  {
    id: "N-2002",
    role: "patient",
    patient_id: "P001",
    level: "medium",
    message: "Reminder: virtual check-in with Dr. D001 tomorrow at 9:30 AM.",
    time: "2025-11-30T11:00",
  },
  {
    id: "N-2003",
    role: "doctor",
    doctor_id: "D002",
    patient_id: "P003",
    level: "low",
    message: "RPM readings stable for P003 over last 24 hours.",
    time: "2025-11-29T17:20",
  },
  {
    id: "N-2004",
    role: "admin",
    level: "medium",
    message: "RPM event volume increased 15% this week – monitor staffing.",
    time: "2025-11-29T09:00",
  },
];

// ===== BASIC HELPERS =====
function parseNumber(val) {
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function formatShortDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return (
    d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) +
    " · " +
    d.toLocaleDateString()
  );
}

function eventDate(e) {
  const val = e.alert_time || e.date;
  return new Date(val);
}

function defaultPasswordForId(idUpper) {
  return idUpper + "@123";
}

// ===== STORAGE HELPERS =====
function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.error("Failed to save", key, e);
  }
}

// Credentials
function loadCredentials() {
  return loadJson(STORAGE_KEY_CREDS, {});
}
function saveCredentials(creds) {
  saveJson(STORAGE_KEY_CREDS, creds);
}

// Meetings
function loadMeetingsFromStorage() {
  const stored = loadJson(STORAGE_KEY_MEETINGS, null);
  if (Array.isArray(stored)) {
    meetings = stored;
  } else {
    meetings = defaultMeetings.slice();
    saveMeetingsToStorage();
  }
}
function saveMeetingsToStorage() {
  saveJson(STORAGE_KEY_MEETINGS, meetings);
}

// Notifications
function loadNotificationsFromStorage() {
  const stored = loadJson(STORAGE_KEY_NOTIFICATIONS, null);
  if (Array.isArray(stored)) {
    notifications = stored;
  } else {
    notifications = defaultNotifications.slice();
    saveNotificationsToStorage();
  }
}
function saveNotificationsToStorage() {
  saveJson(STORAGE_KEY_NOTIFICATIONS, notifications);
}

// Login attempts for lockout
function loadLoginAttempts() {
  loginAttempts = loadJson(STORAGE_KEY_LOGIN_ATTEMPTS, {});
}
function saveLoginAttempts() {
  saveJson(STORAGE_KEY_LOGIN_ATTEMPTS, loginAttempts);
}

// Last login
function loadLastLogin() {
  lastLogin = loadJson(STORAGE_KEY_LAST_LOGIN, {});
}
function saveLastLogin() {
  saveJson(STORAGE_KEY_LAST_LOGIN, lastLogin);
}

// ===== LOGIN ATTEMPT / LOCKOUT =====
function keyForUser(role, idOrEmail) {
  return `${role}:${idOrEmail.toUpperCase()}`;
}

function isLockedOut(role, idUpper) {
  const key = `${role}:${idUpper}`;
  const rec = loginAttempts[key];
  if (!rec || !rec.lockUntil) return false;
  const now = Date.now();
  if (now < rec.lockUntil) return true;
  // lock expired
  delete rec.lockUntil;
  rec.count = 0;
  saveLoginAttempts();
  return false;
}

function recordFailedAttempt(role, idUpper) {
  const key = `${role}:${idUpper}`;
  if (!loginAttempts[key]) loginAttempts[key] = { count: 0 };
  loginAttempts[key].count = (loginAttempts[key].count || 0) + 1;
  if (loginAttempts[key].count >= 3) {
    loginAttempts[key].lockUntil = Date.now() + 60 * 1000; // 1 minute
  }
  saveLoginAttempts();
}

function clearAttempts(role, idUpper) {
  const key = `${role}:${idUpper}`;
  if (loginAttempts[key]) {
    delete loginAttempts[key];
    saveLoginAttempts();
  }
}

// ===== SESSION MANAGEMENT =====
function resetSessionTimer() {
  if (!state.role) return;
  lastActivityTime = Date.now();
  if (sessionTimer) clearTimeout(sessionTimer);
  sessionTimer = setTimeout(checkSessionTimeout, SESSION_TIMEOUT_MINUTES * 60 * 1000);
}

function checkSessionTimeout() {
  if (!state.role) return;
  const now = Date.now();
  if (now - lastActivityTime >= SESSION_TIMEOUT_MINUTES * 60 * 1000) {
    performLogout("Your session expired for security. Please log in again.");
  }
}

// ===== CSV LOADING =====
function loadCsv(path) {
  return fetch(path)
    .then((res) => {
      if (!res.ok) throw new Error(`Failed to load ${path}`);
      return res.text();
    })
    .then(
      (text) =>
        new Promise((resolve) => {
          Papa.parse(text, {
            header: true,
            skipEmptyLines: true,
            complete: (results) => resolve(results.data),
          });
        })
    );
}

async function loadData() {
  try {
    const [rpm, docs, pats] = await Promise.all([
      loadCsv("rpm_events.csv"),
      loadCsv("doctors.csv"),
      loadCsv("patients.csv"),
    ]);

    rpmEvents = rpm;
    doctors = docs;
    patients = pats;

    console.log("Data loaded:", {
      rpmEvents: rpmEvents.length,
      doctors: doctors.length,
      patients: patients.length,
    });
  } catch (err) {
    console.error(err);
    const errEl = document.getElementById("login-error");
    if (errEl) {
      errEl.textContent =
        "Error loading data. Check CSV filenames or run via a local server.";
    }
  }
}

// ===== NOTIFICATION HELPERS =====
function badgeHtml(level) {
  const cls =
    level === "high"
      ? "badge badge-high"
      : level === "medium"
      ? "badge badge-medium"
      : "badge badge-low";
  const text =
    level === "high" ? "HIGH" : level === "medium" ? "MEDIUM" : "LOW";
  return `<span class="${cls}">${text}</span>`;
}

function badgeLabel(level) {
  return level ? level.toUpperCase() : "";
}

function createNotification(note) {
  const id = "N-" + Date.now().toString().slice(-6);
  const item = { id, time: new Date().toISOString(), ...note };
  notifications.push(item);
  saveNotificationsToStorage();
}

// ===== TIME FILTER =====
function applyTimeFilter(events, filterKey) {
  if (filterKey === "all") return events;
  const now = new Date();
  const msPerDay = 24 * 60 * 60 * 1000;
  let windowMs = 0;
  if (filterKey === "24h") windowMs = msPerDay;
  else if (filterKey === "7d") windowMs = 7 * msPerDay;
  else if (filterKey === "30d") windowMs = 30 * msPerDay;

  return events.filter((e) => {
    const d = eventDate(e);
    if (Number.isNaN(d.getTime())) return true;
    return now - d <= windowMs;
  });
}

// ===== DASHBOARD RENDERING =====
function showPanel(panelId) {
  const panels = document.querySelectorAll(".dashboard-panel");
  panels.forEach((el) => el.classList.add("hidden"));
  const active = document.getElementById(panelId);
  if (active) active.classList.remove("hidden");
}

/* ----- Admin ----- */
function renderAdminDashboard() {
  document.getElementById("kpi-total-patients").textContent = patients.length;
  document.getElementById("kpi-total-doctors").textContent = doctors.length;
  document.getElementById("kpi-total-events").textContent = rpmEvents.length;

  const responses = rpmEvents.map((e) => parseNumber(e.response_minutes));
  const avgResp = avg(responses);
  document.getElementById("kpi-avg-response").textContent = avgResp.toFixed(1);

  const adminLastLoginEl = document.getElementById("admin-last-login");
  const key = "admin:ADMIN@RCC.COM";
  const ts = lastLogin[key];
  adminLastLoginEl.textContent = ts
    ? `Last login: ${formatShortDate(ts)}`
    : "";

  // Admin notifications
  const tbody = document.getElementById("admin-notifications-table");
  tbody.innerHTML = "";

  const adminNotes = notifications
    .filter((n) => n.role === "admin" || !n.role)
    .sort((a, b) => new Date(b.time) - new Date(a.time))
    .slice(0, 8);

  adminNotes.forEach((n) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${formatShortDate(n.time)}</td>
      <td>${n.role ? n.role : "system"}</td>
      <td>${n.message}</td>
      <td>${badgeLabel(n.level)}</td>
    `;
    tbody.appendChild(tr);
  });

  // Meeting audit log
  const mBody = document.getElementById("admin-meetings-table");
  mBody.innerHTML = "";
  const sortedMeetings = meetings
    .slice()
    .sort((a, b) => new Date(b.datetime) - new Date(a.datetime))
    .slice(0, 20);

  sortedMeetings.forEach((m) => {
    const doc = doctors.find((d) => d.doctor_id === m.doctor_id);
    const pat = patients.find((p) => p.patient_id === m.patient_id);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${m.id}</td>
      <td>${doc ? doc.doctor_name : m.doctor_id}</td>
      <td>${pat ? pat.patient_name : m.patient_id}</td>
      <td>${formatShortDate(m.datetime)}</td>
      <td>${m.type}</td>
      <td>${m.status}</td>
      <td>${m.createdBy || "system"}</td>
    `;
    mBody.appendChild(tr);
  });
}

/* ----- Doctor ----- */
function renderDoctorDashboard() {
  const doc = state.doctor;
  if (!doc) return;

  const info = document.getElementById("doctor-info");
  const key = `doctor:${doc.doctor_id.toUpperCase()}`;
  const ts = lastLogin[key];
  const lastEl = document.getElementById("doctor-last-login");
  lastEl.textContent = ts ? `Last login: ${formatShortDate(ts)}` : "";

  info.innerHTML = `
    <p><strong>${doc.doctor_name}</strong> (${doc.doctor_id})</p>
    <p>Specialization: <strong>${doc.specialization}</strong></p>
    <p>Experience: <strong>${doc.experience_years} years</strong> · Shift: <strong>${doc.shift}</strong></p>
    <p>City: <strong>${doc.city}</strong></p>
  `;

  const assignedPatients = patients.filter(
    (p) => p.doctor_id === doc.doctor_id
  );
  const tbodyPatients = document.getElementById("doctor-patient-table");
  tbodyPatients.innerHTML = "";
  assignedPatients.forEach((p) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${p.patient_id}</td>
      <td>${p.patient_name}</td>
      <td>${p.age}</td>
      <td>${p.gender}</td>
      <td>${p.chronic_condition}</td>
      <td>${p.device_type}</td>
      <td>${p.city}</td>
    `;
    tbodyPatients.appendChild(tr);
  });

  // Populate patient filter for events
  const patFilter = document.getElementById("doctor-events-patient-filter");
  if (patFilter) {
    patFilter.innerHTML = `<option value="all">All patients</option>`;
    assignedPatients.forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.patient_id;
      opt.textContent = `${p.patient_name} (${p.patient_id})`;
      patFilter.appendChild(opt);
    });
  }

  // Populate patient dropdown in create meeting form
  const patientSelect = document.getElementById("create-meeting-patient");
  if (patientSelect) {
    patientSelect.innerHTML =
      '<option value="">Select assigned patient</option>';
    assignedPatients.forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.patient_id;
      opt.textContent = `${p.patient_name} (${p.patient_id})`;
      patientSelect.appendChild(opt);
    });
  }

  // Base doctor events
  state.doctorEventsBase = rpmEvents
    .filter((e) => e.doctor_id === doc.doctor_id)
    .sort((a, b) => eventDate(b) - eventDate(a));
  state.doctorEventsLimit = 10;
  state.doctorEventsFilter = "all";
  state.doctorEventsPatientFilter = "all";

  renderDoctorEvents();
  renderDoctorMeetings(doc.doctor_id);
  renderDoctorNotifications(doc.doctor_id);

  setupDoctorEventsControls();
  setupCreateMeetingForDoctor(doc.doctor_id);
}

function renderDoctorEvents() {
  const tbodyEvents = document.getElementById("doctor-events-table");
  const summaryEl = document.getElementById("doctor-events-summary");
  tbodyEvents.innerHTML = "";

  let base = state.doctorEventsBase;
  if (state.doctorEventsPatientFilter !== "all") {
    base = base.filter(
      (e) => e.patient_id === state.doctorEventsPatientFilter
    );
  }

  const filtered = applyTimeFilter(base, state.doctorEventsFilter).slice(
    0,
    state.doctorEventsLimit
  );

  let high = 0,
    med = 0,
    low = 0;
  filtered.forEach((e) => {
    const s = (e.severity || "").toLowerCase();
    if (s === "high") high++;
    else if (s === "medium") med++;
    else if (s === "low") low++;
  });

  if (summaryEl) {
    summaryEl.textContent = `High: ${high} · Medium: ${med} · Low: ${low} · Showing ${filtered.length} event(s).`;
  }

  if (!filtered.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="7">No RPM events for the selected filters.</td>`;
    tbodyEvents.appendChild(tr);
    return;
  }

  filtered.forEach((e) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${formatShortDate(e.date || e.alert_time)}</td>
      <td>${e.event_id}</td>
      <td>${e.patient_id}</td>
      <td>${e.severity}</td>
      <td>${e.response_minutes}</td>
      <td>${e.heart_rate}</td>
      <td>${e.bp_sys}/${e.bp_dia}</td>
    `;
    tbodyEvents.appendChild(tr);
  });
}

function renderDoctorMeetings(doctorId) {
  const tbody = document.getElementById("doctor-meetings-table");
  tbody.innerHTML = "";

  const docMeetings = meetings
    .filter((m) => m.doctor_id === doctorId)
    .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

  if (!docMeetings.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="5">No meetings scheduled. Use the form below to create one.</td>`;
    tbody.appendChild(tr);
    return;
  }

  docMeetings.forEach((m) => {
    const patient = patients.find((p) => p.patient_id === m.patient_id);
    const patientName = patient ? patient.patient_name : m.patient_id;
    const zoomBtn =
      m.status === "Scheduled"
        ? `<a class="btn-secondary small" href="https://zoom.us" target="_blank" rel="noopener noreferrer">Connect via Zoom</a>`
        : "-";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${formatShortDate(m.datetime)}</td>
      <td>${patientName}</td>
      <td>${m.type}</td>
      <td>${m.status}</td>
      <td>${zoomBtn}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderDoctorNotifications(doctorId) {
  const list = document.getElementById("doctor-notifications-list");
  list.innerHTML = "";

  const docNotes = notifications
    .filter((n) => n.role === "doctor" && n.doctor_id === doctorId)
    .sort((a, b) => new Date(b.time) - new Date(a.time));

  if (!docNotes.length) {
    const li = document.createElement("li");
    li.className = "notification-item";
    li.innerHTML = `<div>No alerts yet. High severity RPM events will appear here.</div>`;
    list.appendChild(li);
    return;
  }

  docNotes.forEach((n) => {
    const li = document.createElement("li");
    li.className = "notification-item";
    li.innerHTML = `
      <div class="notification-meta">
        <span>${formatShortDate(n.time)}</span>
        ${badgeHtml(n.level)}
      </div>
      <div>${n.message}</div>
    `;
    list.appendChild(li);
  });
}

/* ----- Patient ----- */
function renderPatientDashboard() {
  const pat = state.patient;
  if (!pat) return;

  const doc = doctors.find((d) => d.doctor_id === pat.doctor_id);

  const key = `patient:${pat.patient_id.toUpperCase()}`;
  const ts = lastLogin[key];
  const lastEl = document.getElementById("patient-last-login");
  lastEl.textContent = ts ? `Last login: ${formatShortDate(ts)}` : "";

  const info = document.getElementById("patient-info");
  info.innerHTML = `
    <p><strong>${pat.patient_name}</strong> (${pat.patient_id})</p>
    <p>Age: <strong>${pat.age}</strong> · Gender: <strong>${pat.gender}</strong></p>
    <p>Condition: <strong>${pat.chronic_condition}</strong></p>
    <p>Device: <strong>${pat.device_type}</strong></p>
    <p>Doctor: <strong>${doc ? doc.doctor_name : pat.doctor_id}</strong></p>
    <p>City: <strong>${pat.city}</strong></p>
  `;

  state.patientEventsBase = rpmEvents
    .filter((e) => e.patient_id === pat.patient_id)
    .sort((a, b) => eventDate(b) - eventDate(a));
  state.patientEventsLimit = 10;
  state.patientEventsFilter = "all";

  renderPatientEvents();
  renderPatientMeetings(pat.patient_id);
  renderPatientNotifications(pat.patient_id);

  setupPatientEventsControls();
  setupCreateMeetingForPatient(pat.patient_id);
}

function renderPatientEvents() {
  const tbodyEvents = document.getElementById("patient-events-table");
  tbodyEvents.innerHTML = "";

  const filtered = applyTimeFilter(
    state.patientEventsBase,
    state.patientEventsFilter
  ).slice(0, state.patientEventsLimit);

  if (!filtered.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="7">No RPM events for the selected time window.</td>`;
    tbodyEvents.appendChild(tr);
    return;
  }

  filtered.forEach((e) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${formatShortDate(e.date || e.alert_time)}</td>
      <td>${e.event_id}</td>
      <td>${e.severity}</td>
      <td>${e.response_minutes}</td>
      <td>${e.heart_rate}</td>
      <td>${e.bp_sys}/${e.bp_dia}</td>
      <td>${e.uptime_minutes}</td>
    `;
    tbodyEvents.appendChild(tr);
  });
}

function renderPatientMeetings(patientId) {
  const tbody = document.getElementById("patient-meetings-table");
  tbody.innerHTML = "";

  const patMeetings = meetings
    .filter((m) => m.patient_id === patientId)
    .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

  if (!patMeetings.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="5">No meetings yet. Use the form below to request one.</td>`;
    tbody.appendChild(tr);
    return;
  }

  patMeetings.forEach((m) => {
    const doc = doctors.find((d) => d.doctor_id === m.doctor_id);
    const docName = doc ? doc.doctor_name : m.doctor_id;
    const zoomBtn =
      m.status === "Scheduled"
        ? `<a class="btn-secondary small" href="https://zoom.us" target="_blank" rel="noopener noreferrer">Connect via Zoom</a>`
        : "-";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${formatShortDate(m.datetime)}</td>
      <td>${docName}</td>
      <td>${m.type}</td>
      <td>${m.status}</td>
      <td>${zoomBtn}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderPatientNotifications(patientId) {
  const list = document.getElementById("patient-notifications-list");
  list.innerHTML = "";

  const patNotes = notifications
    .filter((n) => n.role === "patient" && n.patient_id === patientId)
    .sort((a, b) => new Date(b.time) - new Date(a.time));

  if (!patNotes.length) {
    const li = document.createElement("li");
    li.className = "notification-item";
    li.innerHTML = `<div>No notifications yet. New meetings and critical RPM alerts will appear here.</div>`;
    list.appendChild(li);
    return;
  }

  patNotes.forEach((n) => {
    const li = document.createElement("li");
    li.className = "notification-item";
    li.innerHTML = `
      <div class="notification-meta">
        <span>${formatShortDate(n.time)}</span>
        ${badgeHtml(n.level)}
      </div>
      <div>${n.message}</div>
    `;
    list.appendChild(li);
  });
}

// ===== DOCTOR / PATIENT EVENTS CONTROLS =====
function setupDoctorEventsControls() {
  const filterSelect = document.getElementById("doctor-events-filter");
  const patientSelect = document.getElementById("doctor-events-patient-filter");
  const moreBtn = document.getElementById("doctor-events-more");

  if (filterSelect) {
    filterSelect.onchange = () => {
      state.doctorEventsFilter = filterSelect.value;
      state.doctorEventsLimit = 10;
      renderDoctorEvents();
    };
  }

  if (patientSelect) {
    patientSelect.onchange = () => {
      state.doctorEventsPatientFilter = patientSelect.value;
      state.doctorEventsLimit = 10;
      renderDoctorEvents();
    };
  }

  if (moreBtn) {
    moreBtn.onclick = () => {
      state.doctorEventsLimit += 10;
      renderDoctorEvents();
    };
  }
}

function setupPatientEventsControls() {
  const filterSelect = document.getElementById("patient-events-filter");
  const moreBtn = document.getElementById("patient-events-more");

  if (filterSelect) {
    filterSelect.onchange = () => {
      state.patientEventsFilter = filterSelect.value;
      state.patientEventsLimit = 10;
      renderPatientEvents();
    };
  }

  if (moreBtn) {
    moreBtn.onclick = () => {
      state.patientEventsLimit += 10;
      renderPatientEvents();
    };
  }
}

// ===== CREATE MEETING (DOCTOR) =====
function setupCreateMeetingForDoctor(doctorId) {
  const form = document.getElementById("create-meeting-form");
  if (!form) return;

  if (form.dataset.bound === "true") return;
  form.dataset.bound = "true";

  const patientSelect = document.getElementById("create-meeting-patient");
  const datetimeInput = document.getElementById("create-meeting-datetime");
  const typeSelect = document.getElementById("create-meeting-type");
  const msgEl = document.getElementById("create-meeting-msg");

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    msgEl.textContent = "";

    const patientId = patientSelect.value;
    const dt = datetimeInput.value;
    const type = typeSelect.value;

    if (!patientId || !dt || !type) {
      msgEl.style.color = "#dc2626";
      msgEl.textContent = "Please fill all fields.";
      return;
    }

    const newId = "M-" + Date.now().toString().slice(-6);

    meetings.push({
      id: newId,
      doctor_id: doctorId,
      patient_id: patientId,
      datetime: dt,
      type,
      status: "Scheduled",
      createdBy: "doctor",
    });

    saveMeetingsToStorage();

    // Notify patient
    createNotification({
      role: "patient",
      patient_id: patientId,
      level: "medium",
      message: `New meeting scheduled with your doctor on ${formatShortDate(
        dt
      )} (${type}).`,
    });

    renderDoctorMeetings(doctorId);

    msgEl.style.color = "#15803d";
    msgEl.textContent = "Meeting created and added to your schedule.";
    form.reset();

    setTimeout(() => {
      msgEl.textContent = "";
    }, 4000);
  });
}

// ===== CREATE MEETING (PATIENT) =====
function setupCreateMeetingForPatient(patientId) {
  const form = document.getElementById("patient-create-meeting-form");
  if (!form) return;

  if (form.dataset.bound === "true") return;
  form.dataset.bound = "true";

  const datetimeInput = document.getElementById("patient-meeting-datetime");
  const typeSelect = document.getElementById("patient-meeting-type");
  const msgEl = document.getElementById("patient-create-meeting-msg");

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    msgEl.textContent = "";

    const dt = datetimeInput.value;
    const type = typeSelect.value;

    if (!dt || !type) {
      msgEl.style.color = "#dc2626";
      msgEl.textContent = "Please fill all fields.";
      return;
    }

    const patient = patients.find((p) => p.patient_id === patientId);
    if (!patient) {
      msgEl.style.color = "#dc2626";
      msgEl.textContent = "Patient record not found.";
      return;
    }

    const doctorId = patient.doctor_id;
    const newId = "M-" + Date.now().toString().slice(-6);

    meetings.push({
      id: newId,
      doctor_id: doctorId,
      patient_id: patientId,
      datetime: dt,
      type,
      status: "Scheduled",
      createdBy: "patient",
    });

    saveMeetingsToStorage();

    // Notify doctor
    createNotification({
      role: "doctor",
      doctor_id: doctorId,
      patient_id: patientId,
      level: "medium",
      message: `Patient ${patient.patient_name} requested a ${type} on ${formatShortDate(
        dt
      )}.`,
    });

    renderPatientMeetings(patientId);

    // If doctor currently logged in and matches, update doctor view
    if (state.role === "doctor" && state.doctor && state.doctor.doctor_id === doctorId) {
      renderDoctorMeetings(doctorId);
      renderDoctorNotifications(doctorId);
    }

    msgEl.style.color = "#15803d";
    msgEl.textContent = "Meeting request submitted.";
    form.reset();

    setTimeout(() => {
      msgEl.textContent = "";
    }, 4000);
  });
}

// ===== AUTH MODE TOGGLE =====
function setupAuthModeToggle() {
  const modeLoginBtn = document.getElementById("mode-login");
  const modeSignupBtn = document.getElementById("mode-signup");
  const loginForm = document.getElementById("login-form");
  const signupForm = document.getElementById("signup-form");

  function setMode(mode) {
    if (mode === "login") {
      modeLoginBtn.classList.add("active");
      modeSignupBtn.classList.remove("active");
      loginForm.classList.remove("hidden");
      signupForm.classList.add("hidden");
    } else {
      modeLoginBtn.classList.remove("active");
      modeSignupBtn.classList.add("active");
      loginForm.classList.add("hidden");
      signupForm.classList.remove("hidden");
    }
  }

  modeLoginBtn.addEventListener("click", () => setMode("login"));
  modeSignupBtn.addEventListener("click", () => setMode("signup"));
}

// ===== LOGIN =====
function setupLogin() {
  const form = document.getElementById("login-form");
  const roleSelect = document.getElementById("role-select");
  const idInput = document.getElementById("id-input");
  const idLabel = document.getElementById("id-label");
  const errorEl = document.getElementById("login-error");

  const adminFields = document.querySelectorAll(".admin-field");
  const adminEmailInput = document.getElementById("admin-email");
  const adminPasswordInput = document.getElementById("admin-password");

  const userPasswordInput = document.getElementById("user-password");
  const userPasswordFields = document.querySelectorAll(".user-password-field");

  const ADMIN_EMAIL = "admin@rcc.com";
  const ADMIN_PASSWORD = "Admin123!";

  function showAdminFields(show) {
    adminFields.forEach((el) => el.classList.toggle("hidden", !show));
  }

  function showUserPasswordFields(show) {
    userPasswordFields.forEach((el) => el.classList.toggle("hidden", !show));
  }

  roleSelect.addEventListener("change", () => {
    const role = roleSelect.value;
    errorEl.textContent = "";
    errorEl.style.color = "#dc2626";

    if (role === "admin") {
      showAdminFields(true);
      showUserPasswordFields(false);
      idInput.value = "";
      idInput.disabled = true;
      idLabel.textContent = "ID (not required for admin)";
    } else if (role === "doctor") {
      showAdminFields(false);
      showUserPasswordFields(true);
      idInput.disabled = false;
      idLabel.textContent = "Doctor ID";
      idInput.placeholder = "e.g., D001";
    } else if (role === "patient") {
      showAdminFields(false);
      showUserPasswordFields(true);
      idInput.disabled = false;
      idLabel.textContent = "Patient ID";
      idInput.placeholder = "e.g., P001";
    } else {
      showAdminFields(false);
      showUserPasswordFields(true);
      idInput.disabled = false;
      idLabel.textContent = "ID";
      idInput.placeholder = "e.g., D001 or P001";
    }
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    errorEl.textContent = "";
    errorEl.style.color = "#dc2626";

    const role = roleSelect.value;

    if (!role) {
      errorEl.textContent = "Please select a role.";
      return;
    }

    // ADMIN LOGIN
    if (role === "admin") {
      const email = adminEmailInput.value.trim();
      const password = adminPasswordInput.value;

      if (!email || !password) {
        errorEl.textContent = "Enter admin email and password.";
        return;
      }

      const key = "ADMIN:ADMIN@RCC.COM";

      if (isLockedOut("ADMIN", "ADMIN@RCC.COM")) {
        errorEl.textContent =
          "Admin account temporarily locked due to repeated failures. Try again in 1 minute.";
        return;
      }

      if (
        email.toLowerCase() !== ADMIN_EMAIL.toLowerCase() ||
        password !== ADMIN_PASSWORD
      ) {
        recordFailedAttempt("ADMIN", "ADMIN@RCC.COM");
        errorEl.textContent = "Invalid admin credentials.";
        return;
      }

      clearAttempts("ADMIN", "ADMIN@RCC.COM");
      state.role = "admin";
      state.doctor = null;
      state.patient = null;

      lastLogin[key] = new Date().toISOString();
      saveLastLogin();

      userPasswordInput.value = "";
      enterDashboard();
      return;
    }

    // DOCTOR / PATIENT LOGIN
    const id = idInput.value.trim();
    if (!id) {
      errorEl.textContent = "Please enter an ID.";
      return;
    }

    const userPassword = userPasswordInput.value;
    if (!userPassword) {
      errorEl.textContent = "Please enter your password.";
      return;
    }

    const idUpper = id.toUpperCase();
    const attemptsKeyRole = role;
    if (isLockedOut(attemptsKeyRole, idUpper)) {
      errorEl.textContent =
        "Too many failed attempts. Account temporarily locked for 1 minute.";
      return;
    }

    const creds = loadCredentials();
    const key = `${role}:${idUpper}`;
    const stored = creds[key];
    const expectedPass = stored
      ? stored.password
      : defaultPasswordForId(idUpper);

    if (role === "doctor") {
      const doc = doctors.find((d) => d.doctor_id.toUpperCase() === idUpper);
      if (!doc) {
        recordFailedAttempt(attemptsKeyRole, idUpper);
        errorEl.textContent = "Doctor ID not found. Try D001, D002, etc.";
        return;
      }

      if (userPassword !== expectedPass) {
        recordFailedAttempt(attemptsKeyRole, idUpper);
        errorEl.textContent = stored
          ? "Incorrect password for this doctor."
          : `Invalid password. Default is ID + "@123" (e.g., ${idUpper}@123)`;
        return;
      }

      clearAttempts(attemptsKeyRole, idUpper);
      state.role = "doctor";
      state.doctor = doc;
      state.patient = null;

      lastLogin[key] = new Date().toISOString();
      saveLastLogin();

      enterDashboard();
    } else if (role === "patient") {
      const pat = patients.find((p) => p.patient_id.toUpperCase() === idUpper);
      if (!pat) {
        recordFailedAttempt(attemptsKeyRole, idUpper);
        errorEl.textContent = "Patient ID not found. Try P001, P002, etc.";
        return;
      }

      if (userPassword !== expectedPass) {
        recordFailedAttempt(attemptsKeyRole, idUpper);
        errorEl.textContent = stored
          ? "Incorrect password for this patient."
          : `Invalid password. Default is ID + "@123" (e.g., ${idUpper}@123)`;
        return;
      }

      clearAttempts(attemptsKeyRole, idUpper);
      state.role = "patient";
      state.patient = pat;
      state.doctor = null;

      lastLogin[key] = new Date().toISOString();
      saveLastLogin();

      enterDashboard();
    }
  });
}

// ===== SIGNUP =====
function setupSignup() {
  const form = document.getElementById("signup-form");
  const roleSelect = document.getElementById("signup-role");
  const idInput = document.getElementById("signup-id");
  const nameInput = document.getElementById("signup-name");
  const passInput = document.getElementById("signup-password");
  const passConfirmInput = document.getElementById("signup-password-confirm");
  const errorEl = document.getElementById("signup-error");
  const successEl = document.getElementById("signup-success");

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    errorEl.textContent = "";
    successEl.textContent = "";

    const role = roleSelect.value;
    const id = idInput.value.trim();
    const name = nameInput.value.trim();
    const password = passInput.value;
    const passwordConfirm = passConfirmInput.value;

    if (!role) {
      errorEl.textContent = "Select a role (doctor or patient).";
      return;
    }

    if (!id) {
      errorEl.textContent = "Enter your ID.";
      return;
    }

    if (password.length < 6) {
      errorEl.textContent = "Password must be at least 6 characters.";
      return;
    }

    if (password !== passwordConfirm) {
      errorEl.textContent = "Passwords do not match.";
      return;
    }

    const idUpper = id.toUpperCase();

    if (role === "doctor") {
      const doc = doctors.find((d) => d.doctor_id.toUpperCase() === idUpper);
      if (!doc) {
        errorEl.textContent =
          "Doctor ID not found in dataset. Use an existing doctor ID.";
        return;
      }
      if (!name && doc.doctor_name) {
        nameInput.value = doc.doctor_name;
      }
    } else if (role === "patient") {
      const pat = patients.find((p) => p.patient_id.toUpperCase() === idUpper);
      if (!pat) {
        errorEl.textContent =
          "Patient ID not found in dataset. Use an existing patient ID.";
        return;
      }
      if (!name && pat.patient_name) {
        nameInput.value = pat.patient_name;
      }
    }

    const key = `${role}:${idUpper}`;
    const creds = loadCredentials();
    creds[key] = { password };
    saveCredentials(creds);

    successEl.textContent = `Account created for ${role} ${idUpper}. You can now log in.`;
    passInput.value = "";
    passConfirmInput.value = "";
  });
}

// ===== FORGOT / CHANGE PASSWORD =====
function setupPasswordHelpers() {
  const forgotBtn = document.getElementById("forgot-password-btn");
  const showChangeBtn = document.getElementById("show-change-password-btn");
  const changeSection = document.getElementById("change-password-section");
  const changeForm = document.getElementById("change-password-form");

  const loginRole = document.getElementById("role-select");
  const loginId = document.getElementById("id-input");
  const loginError = document.getElementById("login-error");

  // Forgot password: reset to default ID@123
  forgotBtn.addEventListener("click", () => {
    loginError.textContent = "";
    loginError.style.color = "#dc2626";

    const role = loginRole.value;
    const id = loginId.value.trim();

    if (!role || (role !== "doctor" && role !== "patient")) {
      loginError.textContent =
        "Select Doctor or Patient and enter ID before resetting password.";
      return;
    }
    if (!id) {
      loginError.textContent = "Enter your ID first.";
      return;
    }

    const idUpper = id.toUpperCase();
    if (role === "doctor") {
      const doc = doctors.find((d) => d.doctor_id.toUpperCase() === idUpper);
      if (!doc) {
        loginError.textContent = "Doctor ID not found in dataset.";
        return;
      }
    } else if (role === "patient") {
      const pat = patients.find((p) => p.patient_id.toUpperCase() === idUpper);
      if (!pat) {
        loginError.textContent = "Patient ID not found in dataset.";
        return;
      }
    }

    const key = `${role}:${idUpper}`;
    const creds = loadCredentials();
    creds[key] = { password: defaultPasswordForId(idUpper) };
    saveCredentials(creds);

    loginError.style.color = "#15803d";
    loginError.textContent = `Password reset to default (${idUpper}@123). Please log in again.`;
    setTimeout(() => {
      loginError.style.color = "#dc2626";
      loginError.textContent = "";
    }, 4000);
  });

  // Show / hide change password section
  showChangeBtn.addEventListener("click", () => {
    changeSection.classList.toggle("hidden");
  });

  // Change password form
  changeForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const roleEl = document.getElementById("cp-role");
    const idEl = document.getElementById("cp-id");
    const currentEl = document.getElementById("cp-current");
    const newEl = document.getElementById("cp-new");
    const confirmEl = document.getElementById("cp-confirm");
    const errEl = document.getElementById("cp-error");
    const successEl = document.getElementById("cp-success");

    errEl.textContent = "";
    successEl.textContent = "";

    const role = roleEl.value;
    const id = idEl.value.trim();
    const current = currentEl.value;
    const newPass = newEl.value;
    const confirm = confirmEl.value;

    if (!role || (role !== "doctor" && role !== "patient")) {
      errEl.textContent = "Role must be doctor or patient.";
      return;
    }
    if (!id) {
      errEl.textContent = "Enter your ID.";
      return;
    }
    if (!current || !newPass || !confirm) {
      errEl.textContent = "Fill in all password fields.";
      return;
    }
    if (newPass.length < 6) {
      errEl.textContent = "New password must be at least 6 characters.";
      return;
    }
    if (newPass !== confirm) {
      errEl.textContent = "New passwords do not match.";
      return;
    }

    const idUpper = id.toUpperCase();

    if (role === "doctor") {
      const doc = doctors.find((d) => d.doctor_id.toUpperCase() === idUpper);
      if (!doc) {
        errEl.textContent = "Doctor ID not found in dataset.";
        return;
      }
    } else {
      const pat = patients.find((p) => p.patient_id.toUpperCase() === idUpper);
      if (!pat) {
        errEl.textContent = "Patient ID not found in dataset.";
        return;
      }
    }

    const key = `${role}:${idUpper}`;
    const creds = loadCredentials();
    const stored = creds[key];
    const effectiveCurrent = stored
      ? stored.password
      : defaultPasswordForId(idUpper);

    if (current !== effectiveCurrent) {
      errEl.textContent = "Current password is incorrect.";
      return;
    }

    creds[key] = { password: newPass };
    saveCredentials(creds);

    successEl.textContent = "Password updated successfully.";
    currentEl.value = "";
    newEl.value = "";
    confirmEl.value = "";
  });
}

// ===== DETAILS TOGGLES =====
function setupDetailsToggles() {
  const docBtn = document.getElementById("doctor-details-btn");
  const docSection = document.getElementById("doctor-details-section");
  if (docBtn && docSection) {
    docBtn.addEventListener("click", () => {
      const hidden = docSection.classList.contains("hidden");
      docSection.classList.toggle("hidden");
      docBtn.textContent = hidden
        ? "Hide patient details & RPM events"
        : "View patient details & RPM events";
    });
  }

  const patBtn = document.getElementById("patient-details-btn");
  const patSection = document.getElementById("patient-details-section");
  if (patBtn && patSection) {
    patBtn.addEventListener("click", () => {
      const hidden = patSection.classList.contains("hidden");
      patSection.classList.toggle("hidden");
      patBtn.textContent = hidden ? "Hide RPM details" : "View RPM details";
    });
  }
}

// ===== ENTER DASHBOARD / LOGOUT =====
function enterDashboard() {
  const authSection = document.getElementById("auth-section");
  const dashSection = document.getElementById("dashboard-section");
  const title = document.getElementById("dashboard-title");
  const subtitle = document.getElementById("dashboard-subtitle");

  authSection.classList.add("hidden");
  dashSection.classList.remove("hidden");

  if (state.role === "admin") {
    title.textContent = "Admin dashboard";
    subtitle.textContent =
      "Monitor KPIs, notifications, and the global meeting audit log for the RPM program.";
    renderAdminDashboard();
    showPanel("admin-dashboard");
  } else if (state.role === "doctor") {
    title.textContent = `Doctor dashboard (${state.doctor.doctor_id})`;
    subtitle.textContent =
      "Review your patients, alerts, meetings, and RPM events in one view.";
    renderDoctorDashboard();
    showPanel("doctor-dashboard");
  } else if (state.role === "patient") {
    title.textContent = `Patient dashboard (${state.patient.patient_id})`;
    subtitle.textContent =
      "Track your readings, see alerts, and manage telehealth visits with your doctor.";
    renderPatientDashboard();
    showPanel("patient-dashboard");
  }

  resetSessionTimer();
}

function performLogout(message) {
  state.role = null;
  state.doctor = null;
  state.patient = null;

  if (sessionTimer) clearTimeout(sessionTimer);
  sessionTimer = null;

  document.getElementById("dashboard-section").classList.add("hidden");
  document.getElementById("auth-section").classList.remove("hidden");
  document.getElementById("login-form").reset();
  document.getElementById("signup-form").reset();

  const errorIds = [
    "login-error",
    "signup-error",
    "signup-success",
    "cp-error",
    "cp-success",
  ];
  errorIds.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = "";
  });

  const idInput = document.getElementById("id-input");
  idInput.disabled = false;

  const roleSelect = document.getElementById("role-select");
  if (roleSelect) roleSelect.value = "";

  const adminFields = document.querySelectorAll(".admin-field");
  adminFields.forEach((el) => el.classList.add("hidden"));

  const cpSection = document.getElementById("change-password-section");
  if (cpSection) cpSection.classList.add("hidden");

  const loginError = document.getElementById("login-error");
  if (message) {
    loginError.style.color = "#dc2626";
    loginError.textContent = message;
  }
}

function setupLogout() {
  const btn = document.getElementById("logout-btn");
  btn.addEventListener("click", () => {
    performLogout("");
  });
}

// ===== INIT =====
document.addEventListener("DOMContentLoaded", () => {
  loadData();
  loadMeetingsFromStorage();
  loadNotificationsFromStorage();
  loadLoginAttempts();
  loadLastLogin();

  setupAuthModeToggle();
  setupLogin();
  setupSignup();
  setupPasswordHelpers();
  setupDetailsToggles();
  setupLogout();

  document.addEventListener("click", resetSessionTimer);
  document.addEventListener("keydown", resetSessionTimer);
});
