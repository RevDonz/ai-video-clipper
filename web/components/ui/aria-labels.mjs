// Accessible names for the controls HeroUI and React Aria would otherwise name in English
// (React Aria has no Indonesian strings; 05-ui-dashboard.md §3.7). The keys are the ones the
// `aria` namespace of the message catalog will hold; i18n M0 moves these values to
// web/messages/id/aria.json and the wrappers read them from there.
export const ARIA = Object.freeze({
  close: "Tutup",
  clearSearch: "Hapus pencarian",
  selectAll: "Pilih semua",
  selectRow: "Pilih baris",
  removeTag: "Hapus",
  pagination: "Halaman",
  prev: "Sebelumnya",
  next: "Berikutnya",
  page: "Halaman",
  calendar: "Kalender",
  prevMonth: "Bulan sebelumnya",
  nextMonth: "Bulan berikutnya",
  dismiss: "Tutup notifikasi",
  notifications: "Notifikasi",
  loadingMore: "Memuat lagi",
  loading: "Memuat",
});
