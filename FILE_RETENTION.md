# GridFS file retention

WRITING-XPRESS retains files until they are no longer needed by the order workflow:

- Customer reference files, writer submissions (including previous revisions), and delivery files become eligible 15 days after an order's current completion timestamp.
- Unassociated customer uploads become eligible 15 days after GridFS records their server-side `uploadDate`.
- Order and user records, ratings, assignment history, and payment references are retained.

The protected `GET /api/cron/cleanup-files` endpoint uses the same exact `Authorization: Bearer <CRON_SECRET>` check as assignment expiry. `vercel.json` schedules it daily at 03:00 UTC. Configure the same server-only `CRON_SECRET` for the deployment. The endpoint reports aggregate counts only; it does not log file IDs, customer details, or file contents.

Cleanup tasks are durable. A GridFS file and its `uploads.chunks` are deleted in one MongoDB transaction. Failed transactions leave a task for the next scheduled run. A reference check is repeated inside that transaction. Files referenced by multiple order records are retained because order records and their file references are preserved.

Order creation now validates that every submitted file ID is unique, valid, and present in `uploads.files`. It updates each GridFS file document and creates the order in one transaction. Cleanup writes the same file document before deletion, so order attachment and cleanup conflict rather than race. Order status changes also touch referenced GridFS file documents in their transaction, so a concurrent reopen cannot pass cleanup's final eligibility check. **Order creation, admin order updates, and cleanup therefore require a transaction-capable MongoDB deployment**, such as a replica set or sharded cluster. Configure the `FileRetentionTask` indexes (`fileId` unique and `{ state, createdAt }`) and the `Order` index `{ orderStatus, completedAt }` before enabling the cron if automatic index creation is disabled; the cleanup endpoint initializes the task model indexes before processing.

`completedAt` is recorded when the order enters `Completed` and cleared when it is reopened. Orders already completed before this field exists are not inferred from `createdDate` or file upload time, because those values are not reliable completion times. Such legacy orders require a reviewed completion-time backfill before their files can be automatically removed. Legacy customer GridFS uploads are recognized by their existing timestamp-prefixed filenames and GridFS `uploadDate`.
