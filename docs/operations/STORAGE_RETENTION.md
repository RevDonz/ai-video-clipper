# Storage retention and capacity operations

## Retention policy: never delete jobs automatically

The application does **not** expire, evict, or delete jobs or their artifacts automatically. This includes completed, failed, malformed, incomplete, and old jobs. There is no oldest-first eviction, failed-job cleanup, quota-triggered deletion, application delete command, or automated retention cron.

Reaching the application quota or minimum-free-space watermark blocks admission of new jobs. It never makes room by deleting an existing job. A storage admission failure must leave existing job directories and artifacts unchanged.

## What is and is not retained job data

A published job root and everything beneath it are retained job data, including inputs, download results, analysis, attempt work, partial artifacts, outputs, metadata, and terminal failure evidence. Hidden, malformed, or incomplete directories beneath the jobs root still consume quota and must not be treated as disposable.

The queue protocol may clean up only protocol metadata that is not a job or artifact:

- a uniquely named, unpublished temporary file created solely for an atomic metadata write;
- an expired queue lock; or
- a reservation record before any job root or job bytes exist.

That narrow protocol cleanup is not a retention mechanism. Once bytes have been written to a UUID job root, the root and partial data must be preserved; protocol cleanup must never recurse into it.

## Capacity planning

Operators must monitor both application-owned allocated bytes and filesystem free space. `JOBS_STORAGE_ACTIVE_RESERVE_BYTES` is a future-growth allowance for each active job and must conservatively cover expected YouTube downloads, upload/input growth, attempt work, analysis artifacts, and rendered outputs. Sparse files are charged by allocated blocks, while all filesystem objects are inspected by the bounded scanner. On Linux, the jobs root must remain on one mount identity: nested mounts, including bind mounts backed by the same filesystem/device, cause admission to fail closed. Mount metadata must remain readable and consistent throughout the descriptor-anchored scan.

Before capacity is exhausted:

1. Back up **all** job roots and artifacts, not only successful outputs.
2. Expand the existing jobs volume, or provision a larger replacement volume.
3. For migration, stop admissions and workers, copy the complete jobs tree while preserving metadata, verify the copy, switch the jobs root/volume, and verify the application against the migrated data before resuming work.
4. Keep the source volume and backup until migration and restore checks have succeeded.

Manual out-of-band removal, if ever required by an operator's separate data-governance process, must happen only after a verified backup and with the application and workers stopped. It is intentionally not implemented or scheduled by this application.
