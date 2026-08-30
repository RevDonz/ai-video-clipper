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
    return { available: false, candidates: [] };
  }
  const candidates = payload.candidates
    .filter((item) => item && typeof item === "object")
    .slice()
    .sort((left, right) => Number(left.displayOrder) - Number(right.displayOrder));
  return { available: true, candidates };
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
  const [jobResult, candidateResult] = await Promise.allSettled([
    fetchImpl(`/api/jobs/${id}`, { cache: "no-store", signal }),
    fetchImpl(`/api/jobs/${id}/candidates`, { cache: "no-store", signal }),
  ]);
  const jobResponse = jobResult.status === "fulfilled" ? jobResult.value : null;
  const candidateResponse = candidateResult.status === "fulfilled" ? candidateResult.value : null;
  if (jobResponse?.status === 401 || candidateResponse?.status === 401) {
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

  if (!candidateResponse) {
    return {
      type: "loaded",
      job: jobPayload.job,
      candidateView: { available: false, candidates: [] },
      candidateNotice: "Kandidat V2 tidak dapat dimuat karena gangguan jaringan. Klip lama tetap tersedia.",
    };
  }

  const candidatePayload = await readJson(candidateResponse);
  if (candidateResponse.ok) {
    return {
      type: "loaded",
      job: jobPayload.job,
      candidateView: buildCandidateView(candidatePayload),
      candidateNotice: "",
    };
  }

  let candidateNotice = candidatePayload.error || "Kandidat V2 tidak dapat dimuat saat ini.";
  if (candidateResponse.status === 422) candidateNotice = "Artifact kandidat V2 tersedia tetapi tidak valid, sehingga tidak ditampilkan.";
  if (candidateResponse.status === 404) candidateNotice = "Artifact kandidat tidak ditemukan untuk proyek ini.";
  return {
    type: "loaded",
    job: jobPayload.job,
    candidateView: { available: false, candidates: [] },
    candidateNotice,
  };
}
