This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Server environment

Copy `.env.example` to `.env.local` for local development, then replace its placeholders with your local configuration. Never commit `.env.local` or put secret values in source control. `.env.example` contains placeholders only.

### Database and authentication

Configure `MONGODB_URI` with a transaction-capable MongoDB deployment. Order creation and GridFS retention workflows require MongoDB transactions. Use a separate database for local development, Preview, and Production.

Set `JWT_SECRET` to a strong random, server-only value and keep it stable within each environment so existing sessions remain verifiable. Set `OTP_HASH_SECRET` to a strong random value of at least 32 characters; keep it stable within that environment so outstanding OTP challenges remain verifiable. Do not use the same secrets across Production, Preview, and Development.

Admin login requires `ADMIN_USERNAME` and `ADMIN_PASSWORD_HASH`. The hash must be a bcrypt cost-12 hash in the `$2b$12$...` format accepted by the application. Store only the hash, never the plaintext password.

### Gmail SMTP and application links

Email notifications and OTP delivery use the Gmail SMTP transport configured by `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM`. For Gmail, use the Gmail SMTP host and an account app password in `SMTP_PASS`; the sender address must be valid. `ADMIN_NOTIFICATION_EMAIL` is the mailbox for admin operational notifications.

`APP_BASE_URL` is the public application origin used by email action links. For local development, set it to `http://localhost:3000`. In Production, set it to the final HTTPS Vercel domain. The application does not infer this URL from the incoming request or Vercel deployment URL. If it is missing or invalid, notifications can still be sent without their action links.

The current email implementation uses Gmail SMTP through Nodemailer.

### Scheduled jobs

`vercel.json` schedules writer-assignment expiry and file cleanup. Set `CRON_SECRET` in the Vercel environment so the cron routes can authenticate requests. Vercel sends this value in the `Authorization: Bearer ...` header for cron invocations. Use a long, random, server-only secret, with a different value per environment. Both endpoints fail closed when it is missing.

OTP challenges and send limits are stored in MongoDB. The database user must be allowed to create indexes for the OTP collections. Registration OTP IP throttling also uses the `OtpIpRateLimit` collection. Before enabling registration OTP, verify the unique indexes on `OtpChallenge(subjectId, email, purpose)`, `OtpSendLimit(emailKey, purpose)`, `OtpIpRateLimit(ipKey, action)`, and the existing unique `User.email` index, plus the TTL indexes on each OTP collection. This change does not migrate existing data or create indexes manually.

After a registration code is consumed, its challenge retains an immutable registration-details fingerprint for up to seven days so the same registration can be retried after an account-creation failure. The OTP remains consumed and cannot authorize different registration details.

In production, the ingress proxy must overwrite or sanitize `x-real-ip` / `x-forwarded-for`; these headers supply the IP key for registration OTP throttling.

GridFS file retention and cleanup behavior, including the daily cron and MongoDB transaction requirement, is documented in [FILE_RETENTION.md](./FILE_RETENTION.md).

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
