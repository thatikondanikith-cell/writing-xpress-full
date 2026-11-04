# Writer assignment acceptance expiration

Each new assignment attempt is persisted as `pending_acceptance` with an ISO response deadline 30 minutes after its assignment timestamp. The writer response API validates the current writer, attempt version, status, and deadline in its database update. A response received at or after the deadline is rejected even if the scheduled expiration job has not run yet.

`vercel.json` schedules `/api/cron/expire-writer-assignments` every minute. The endpoint requires the `CRON_SECRET` environment variable and an exact `Authorization: Bearer <CRON_SECRET>` header; it fails closed if the variable is missing. Configure a long, random `CRON_SECRET` in the Vercel project before deployment. Do not put its value in this file or source control.

The scheduled job expires due assignments idempotently and records the outcome in assignment history. Admin and writer workspace reads also run the same expiration sweep, so due work is cleared when either dashboard is used. If no dashboard is open, the Vercel Cron job performs the sweep.

Vercel Cron activation requires a production deployment. The per-minute schedule requires a Vercel plan that supports minute-level cron schedules; confirm the project's plan and cron availability before deploying. Cron execution can be delayed, so the database deadline check remains authoritative. No cron is active until the environment variable is configured and a production deployment registers the schedule.
