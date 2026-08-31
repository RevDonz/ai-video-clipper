# Storage retention and capacity operations

## Retention policy: never delete jobs automatically

The application does **not** expire, evict, or delete jobs or their artifacts on its own. This includes completed, failed, malformed, incomplete, and old jobs. There is no oldest-first eviction, failed-job cleanup, quota-triggered deletion, or automated retention cron.

Reaching the application quota or minimum-free-space watermark blocks admission of new jobs. It never makes room by deleting an existing job. A storage admission failure must leave existing job directories and artifacts unchanged.

## The one exception: explicit user-initiated deletion

An authenticated person may delete a specific project through `DELETE /api/jobs/<id>`, from the delete control on the project history page. This is the only path that removes job data, and it is deliberately the opposite of automated retention: one named job, chosen by a person, never triggered by age, quota, failure, or a schedule. Nothing in the application may call it on its own behalf.

Deletion is permanent and asynchronous:

1. Under the primary queue lock the job is marked `deleting`, a tombstone is written to `.deletions/<id>.json`, and any lease is revoked. The tombstone records `safeAfter`, the moment the revoked lease would have expired.
2. Revoking the lease is what stops the workers. The primary runner's next fenced write raises `LeaseLostError` and terminates its process group; the Python render worker's heartbeat stops validating and sets its `lost` event. Neither needs a new cancellation protocol.
3. The purge runs in the primary worker's poll loop, and once immediately in the deleting request. It refuses while `safeAfter` is in the future or while any render reservation for the job still has a fresh heartbeat, so bytes are never removed from under a live writer.
4. When the purge does run it removes the job's render reservation records **before** the job directory, then the primary reservation record, then the directory, then the tombstone.

Step 4's order matters and must not be reversed. Storage accounting resolves each `.render-reservations/<id>.json` through `analysis/render-requests/<render_id>.json` inside the job directory. A reservation record left behind after its job directory is gone can never resolve again, so `declaredBytes + workReserveBytes` would be charged against the quota permanently, and admission is fail-closed. Removing reservation records first is the conservative direction: the bytes on disk are still counted by the scanner until the directory goes.

A crash between any two steps is safe. The tombstone survives, and the next purge pass finishes the work; a tombstone whose directory is already gone is simply retired.

## What is and is not retained job data

A published job root and everything beneath it are retained job data, including inputs, download results, analysis, attempt work, partial artifacts, outputs, metadata, and terminal failure evidence. Hidden, malformed, or incomplete directories beneath the jobs root still consume quota and must not be treated as disposable.

The queue protocol may clean up only protocol metadata that is not a job or artifact:

- a uniquely named, unpublished temporary file created solely for an atomic metadata write;
- an expired queue lock; or
- a reservation record before any job root or job bytes exist.

That narrow protocol cleanup is not a retention mechanism. Once bytes have been written to a UUID job root, the root and partial data must be preserved; protocol cleanup must never recurse into it.

## Capacity planning

Operators must monitor both application-owned allocated bytes and filesystem free space. `JOBS_STORAGE_ACTIVE_RESERVE_BYTES` is a future-growth allowance for each active job and must conservatively cover expected YouTube downloads, upload/input growth, attempt work, analysis artifacts, and rendered outputs. Sparse files are charged by allocated blocks, while all filesystem objects are inspected by the bounded scanner. On Linux, the jobs root must remain on one mount identity: nested mounts, including bind mounts backed by the same filesystem/device, cause admission to fail closed. Mount metadata must remain readable and consistent throughout the descriptor-anchored scan.

A measured safe initial deployment baseline (existing jobs: `741670783` bytes; filesystem available: `40858787840` of `127776755712` bytes) is:

```dotenv
JOBS_STORAGE_QUOTA_BYTES=32212254720
JOBS_STORAGE_MIN_FREE_BYTES=16106127360
JOBS_STORAGE_ACTIVE_RESERVE_BYTES=2147483648
JOBS_STORAGE_SCAN_MAX_ENTRIES=200000
JOBS_STORAGE_SCAN_MAX_DEPTH=16
JOBS_STORAGE_SCAN_DEADLINE_MS=30000
JOBS_STORAGE_RECHECK_BYTES=8388608
JOBS_STORAGE_RECHECK_INTERVAL_MS=5000
```

Compose requires every value for both the app and primary worker and intentionally fails deployment when one is omitted. Re-measure and revise these values after volume migration or workload changes; the baseline is not an unlimited default.

Before capacity is exhausted:

1. Back up **all** job roots and artifacts, not only successful outputs.
2. Expand the existing jobs volume, or provision a larger replacement volume.
3. For migration, stop admissions and workers, copy the complete jobs tree while preserving metadata, verify the copy, switch the jobs root/volume, and verify the application against the migrated data before resuming work.
4. Keep the source volume and backup until migration and restore checks have succeeded.

Bulk or policy-driven removal, if ever required by an operator's separate data-governance process, must happen out of band: only after a verified backup and with the application and workers stopped. It is intentionally not implemented or scheduled by this application. The per-project delete described above is a user action on a single named job, not a retention mechanism, and must never be automated into one.
