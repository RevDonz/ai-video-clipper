const UINT64_MAX = (1n << 64n) - 1n;
const BYTE_FIELDS = [
  "quotaBytes",
  "allocatedBytes",
  "projectedBytes",
  "availableBytes",
  "minimumFreeBytes",
  "activeReserveBytes",
  "reservedBytes",
  "anticipatedWriteBytes",
  "availableAfterWritesBytes",
];
const CODES = new Set([
  null,
  "storage_quota_exhausted",
  "storage_free_space_low",
  "storage_admission_unavailable",
]);

function decimalBytes(value, field) {
  let parsed;
  if (typeof value === "bigint") parsed = value;
  else if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) parsed = BigInt(value);
  else throw new TypeError(`${field} must be a strict decimal byte value`);
  if (parsed < 0n || parsed > UINT64_MAX) throw new RangeError(`${field} is outside the supported range`);
  return parsed.toString();
}

export function toStorageStatusDto(value) {
  if (!value || typeof value !== "object" || typeof value.allowed !== "boolean" || !CODES.has(value.code ?? null)) {
    throw new TypeError("Invalid storage admission status");
  }
  const code = value.code ?? null;
  if ((value.allowed && code !== null) || (!value.allowed && code === null)) {
    throw new TypeError("Storage admission status and code disagree");
  }
  const dto = { allowed: value.allowed, code };
  for (const field of BYTE_FIELDS) {
    if (value[field] !== undefined) dto[field] = decimalBytes(value[field], field);
  }
  return dto;
}
