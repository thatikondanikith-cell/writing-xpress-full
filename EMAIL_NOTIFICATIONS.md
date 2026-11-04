# WRITING-XPRESS email notifications

Transactional notifications are sent server-side through the Nodemailer/Gmail SMTP wrapper in `lib/email.ts`. The wrapper sends a plain-text alternative and a responsive, table-based HTML email using inline styles. Action links are rendered only from internal paths and an explicitly configured application URL. Emails do not include authentication tokens or private delivery-file URLs.

## Server configuration

Set these environment variables in the server environment that sends mail:

- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM` configure the existing SMTP transport.
- `APP_BASE_URL` is the public application origin used to build notification links, for example `https://writing-xpress.example`. Production requires HTTPS. Localhost and other loopback hosts are rejected, and no URL is inferred from the request or deployment host. If this value is missing or invalid, notification email is still sent without an action button.
- `ADMIN_NOTIFICATION_EMAIL` is the configured mailbox for new-order, application, assignment, and submission notices. Set it to the server-side address that should receive operational notifications.

Keep all values server-side and out of source control. Automated mail tests use a mocked Nodemailer transport and do not contact recipients.

## Notification events

- Customer order submitted → customer email saved on that order; links to the existing order tracker with the order ID prefilled.
- New order received → configured admin mailbox after the order is committed; includes order handling details and links to the existing admin order page.
- Writer application submitted → configured admin mailbox; links to the application list.
- Writer application decision → applicant; links to the writer status/workspace page.
- Order assigned → assigned writer; links to the existing assignment details route.
- Assignment declined or expired → configured admin mailbox; links to the order page.
- Writer submission received → configured admin mailbox; links to the existing submission review page.
- Revision requested or submission approved → assigned writer; links to assignment details and feedback.
- Approved work or physical delivery confirmed → customer email saved on the order; links to authenticated order details.
- Registration, email-change, and password-reset OTP → requested email address; the code remains in the plain-text and HTML message body.

All action links lead to existing pages. Customer order details and writer assignment/review APIs retain their existing authentication and ownership checks. Buttons are not download links and do not bypass sign-in.

## Failure handling and duplicate prevention

Email failures do not roll back the database workflow. Missing SMTP configuration or invalid recipients are skipped; SMTP failures are logged without message content, addresses, or credentials. Workflow idempotency and in-flight duplicate suppression remain in the shared wrapper. Email delivery is not transactional with MongoDB and there is no durable outbox, so exactly-once delivery is not guaranteed.
