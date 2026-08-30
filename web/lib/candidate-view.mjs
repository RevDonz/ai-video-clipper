const PROFILE_LABELS = Object.freeze({
  "viral-short": "Klip singkat",
  standard: "Standar",
  "deep-dive": "Pembahasan mendalam",
});

export const FEATURE_LABELS = Object.freeze({
  hookStrength: "Kekuatan pembuka",
  hookRelevance: "Relevansi pembuka",
  standaloneContext: "Konteks mandiri",
  payoffCompleteness: "Kelengkapan payoff",
  informationDensity: "Kepadatan informasi",
  emotionEnergy: "Energi bahasa (teks)",
  dialogueDynamics: "Dinamika dialog (teks)",
  visualActivity: "Aktivitas visual",
  topicValue: "Nilai topik",
  boundaryQuality: "Kualitas batas",
  penalty: "Penalti",
});

export const CONTRIBUTION_LABELS = Object.freeze({
  hook_strength: "Kekuatan pembuka",
  hook_relevance: "Relevansi pembuka",
  standalone_context: "Konteks mandiri",
  payoff_completeness: "Kelengkapan payoff",
  information_density: "Kepadatan informasi",
  topic_value: "Nilai topik",
  boundary_quality: "Kualitas batas",
  audio_energy: "Aktivitas energi audio",
  audio_energy_change: "Perubahan energi audio",
  scene_activity: "Perubahan adegan",
  motion: "Aktivitas gerak visual",
  face_activity: "Aktivitas visual wajah",
});

export const MEDIA_LABELS = Object.freeze({
  audioEnergy: "Energi audio",
  energyChange: "Perubahan energi audio",
  sceneActivity: "Perubahan adegan",
  motion: "Gerak visual",
  faceActivity: "Aktivitas visual wajah",
});

export function formatDuration(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "—";
  const minutes = Math.floor(value / 60);
  const seconds = value - minutes * 60;
  const rendered = seconds.toFixed(1).padStart(4, "0");
  return `${minutes}:${rendered}`;
}

export function formatScore(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return value.toLocaleString("id-ID", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

export function profileLabel(profile) {
  return PROFILE_LABELS[profile] || "Profil kandidat";
}

export function buildCandidateView(payload) {
  if (payload?.available !== true || !Array.isArray(payload.candidates)) {
    return { available: false, selectionVersion: "", candidates: [] };
  }
  const candidates = payload.candidates
    .filter((item) => item && typeof item === "object")
    .slice()
    .sort((left, right) => Number(left.displayOrder) - Number(right.displayOrder));
  return {
    available: true,
    selectionVersion: typeof payload.selectionVersion === "string" ? payload.selectionVersion : "",
    candidates,
  };
}

const FEEDBACK_DECISIONS = new Set(["accepted", "rejected", "undecided"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;

export function buildFeedbackView(payload) {
  const empty = { available: false, selectionVersion: "", eventCount: 0, latestByCandidate: {} };
  const state = payload?.state && typeof payload.state === "object" ? payload.state : payload;
  if (state?.available !== true || !state.latestByCandidate || typeof state.latestByCandidate !== "object" || Array.isArray(state.latestByCandidate)) return empty;
  const latestByCandidate = {};
  for (const [candidateId, item] of Object.entries(state.latestByCandidate)) {
    if (!item || typeof item !== "object" || item.candidateId !== candidateId || !FEEDBACK_DECISIONS.has(item.decision)) continue;
    latestByCandidate[candidateId] = {
      candidateId,
      decision: item.decision,
      note: typeof item.note === "string" ? Array.from(item.note).slice(0, 500).join("") : "",
      createdAt: typeof item.createdAt === "string" ? item.createdAt : "",
    };
  }
  return {
    available: true,
    selectionVersion: typeof state.selectionVersion === "string" ? state.selectionVersion : "",
    eventCount: Number.isSafeInteger(state.eventCount) && state.eventCount >= 0 ? state.eventCount : 0,
    latestByCandidate,
  };
}

export function validateFeedbackPayload(payload) {
  let error = "";
  if (!payload || typeof payload !== "object") error = "Payload feedback tidak valid.";
  else if (typeof payload.candidateId !== "string" || !payload.candidateId.trim()) error = "Kandidat tidak valid.";
  else if (!FEEDBACK_DECISIONS.has(payload.decision)) error = "Pilih keputusan feedback yang valid.";
  else if (typeof payload.note !== "string") error = "Catatan feedback tidak valid.";
  else if (CONTROL_CHARACTER_PATTERN.test(payload.note)) error = "Catatan tidak mendukung karakter kontrol atau baris baru.";
  else if (Array.from(payload.note.trim()).length > 500) error = "Catatan maksimal 500 karakter Unicode.";
  else if (typeof payload.clientRequestId !== "string" || !UUID_PATTERN.test(payload.clientRequestId)) error = "ID permintaan feedback tidak valid.";
  return { valid: !error, error };
}

export function createFeedbackSaveAttempt(previousAttempt, payload, createUuid = () => crypto.randomUUID()) {
  const normalized = {
    ...payload,
    candidateId: typeof payload?.candidateId === "string" ? payload.candidateId.trim() : payload?.candidateId,
    note: typeof payload?.note === "string" ? payload.note.trim() : payload?.note,
  };
  const samePayload = previousAttempt?.retryable === true
    && previousAttempt.candidateId === normalized.candidateId
    && previousAttempt.decision === normalized.decision
    && previousAttempt.note === normalized.note;
  return {
    ...normalized,
    clientRequestId: samePayload ? previousAttempt.clientRequestId : createUuid(),
  };
}

export function classifyFeedbackSaveFailure(status, payload) {
  const code = typeof payload?.code === "string" ? payload.code : "";
  const generic = {
    status: "error",
    message: "Feedback tidak dapat disimpan. Coba lagi dengan tindakan baru.",
    retryable: false,
    clearPending: true,
    reloadRequired: false,
  };
  if (status === 409 && code === "selection_changed") {
    return { ...generic, status: "reload-required", message: "Pilihan kandidat telah berubah. Muat ulang halaman sebelum menyimpan feedback lagi.", reloadRequired: true };
  }
  if (status === 409 && code === "idempotency_conflict") {
    return { ...generic, message: "ID permintaan sudah dipakai untuk feedback berbeda. Coba simpan lagi untuk membuat tindakan baru yang aman." };
  }
  if (status === 422 && code === "invalid_artifact") {
    return { ...generic, status: "reload-required", message: "Artifact kandidat tidak valid atau sudah usang. Muat ulang halaman sebelum menyimpan feedback lagi.", reloadRequired: true };
  }
  if (status === 400 && code === "invalid_request") {
    return { ...generic, message: "Permintaan feedback tidak valid. Periksa pilihan dan catatan sebelum membuat tindakan baru." };
  }
  if (status >= 500) {
    return {
      ...generic,
      message: code === "backend_unavailable"
        ? "Layanan feedback sementara tidak tersedia. Coba lagi; ID permintaan yang sama akan digunakan."
        : "Feedback belum dipastikan tersimpan. Coba lagi; ID permintaan yang sama akan digunakan.",
      retryable: true,
      clearPending: false,
    };
  }
  return generic;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

export class ProjectDetailLoadError extends Error {
  constructor(message, kind = "request") {
    super(message);
    this.name = "ProjectDetailLoadError";
    this.kind = kind;
  }
}

export async function loadProjectDetail(id, { fetchImpl = fetch, signal } = {}) {
  const [jobResult, candidateResult, feedbackResult] = await Promise.allSettled([
    fetchImpl(`/api/jobs/${id}`, { cache: "no-store", signal }),
    fetchImpl(`/api/jobs/${id}/candidates`, { cache: "no-store", signal }),
    fetchImpl(`/api/jobs/${id}/candidate-feedback`, { cache: "no-store", signal }),
  ]);
  const jobResponse = jobResult.status === "fulfilled" ? jobResult.value : null;
  const candidateResponse = candidateResult.status === "fulfilled" ? candidateResult.value : null;
  const feedbackResponse = feedbackResult.status === "fulfilled" ? feedbackResult.value : null;
  if ([jobResponse, candidateResponse, feedbackResponse].some((response) => response?.status === 401)) {
    return {
      type: "redirect",
      location: `/login?next=${encodeURIComponent(`/projects/${id}`)}`,
    };
  }
  if (jobResult.status === "rejected") {
    if (jobResult.reason?.name === "AbortError") throw jobResult.reason;
    throw new ProjectDetailLoadError("Terjadi gangguan jaringan saat memuat detail proyek.", "network");
  }

  const jobPayload = await readJson(jobResponse);
  if (jobResponse.status === 404) {
    throw new ProjectDetailLoadError("Proyek tidak ditemukan atau sudah tidak tersedia.", "not-found");
  }
  if (!jobResponse.ok) {
    throw new ProjectDetailLoadError(jobPayload.error || "Detail proyek tidak dapat dimuat.");
  }

  let candidateView = { available: false, selectionVersion: "", candidates: [] };
  let candidateNotice = "";
  if (!candidateResponse) {
    candidateNotice = "Kandidat V2 tidak dapat dimuat karena gangguan jaringan. Klip lama tetap tersedia.";
  } else {
    const candidatePayload = await readJson(candidateResponse);
    if (candidateResponse.ok) {
      candidateView = buildCandidateView(candidatePayload);
    } else {
      candidateNotice = candidatePayload.error || "Kandidat V2 tidak dapat dimuat saat ini.";
      if (candidateResponse.status === 422) candidateNotice = "Artifact kandidat V2 tersedia tetapi tidak valid, sehingga tidak ditampilkan.";
      if (candidateResponse.status === 404) candidateNotice = "Artifact kandidat tidak ditemukan untuk proyek ini.";
    }
  }

  let feedbackView = { available: false, selectionVersion: "", eventCount: 0, latestByCandidate: {} };
  let feedbackNotice = "";
  if (!feedbackResponse) {
    feedbackNotice = "Feedback kandidat tidak dapat dimuat karena gangguan jaringan. Kandidat dan klip tetap dapat ditinjau.";
  } else {
    const feedbackPayload = await readJson(feedbackResponse);
    if (feedbackResponse.ok) {
      feedbackView = buildFeedbackView(feedbackPayload);
    } else if (feedbackResponse.status !== 404) {
      feedbackNotice = "Feedback kandidat tidak dapat dimuat saat ini. Kandidat dan klip tetap dapat ditinjau.";
    }
  }

  return {
    type: "loaded",
    job: jobPayload.job,
    candidateView,
    candidateNotice,
    feedbackView,
    feedbackNotice,
  };
}
