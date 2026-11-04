import mongoose, { Document, Model, Schema } from 'mongoose';
import type { OtpEmailPurpose } from '@/lib/email';

export interface OtpSendLimitDocument extends Document {
    emailKey: string;
    purpose: OtpEmailPurpose;
    sentAt: Date[];
    pendingSends: Array<{ reservationId: string; reservedAt: Date }>;
    nextAllowedAt: Date;
    expiresAt: Date;
}

const OtpSendLimitSchema = new Schema<OtpSendLimitDocument>({
    emailKey: { type: String, required: true },
    purpose: { type: String, enum: ['registration', 'email_change', 'password_reset'], required: true },
    sentAt: { type: [Date], required: true },
    pendingSends: {
        type: [{
            reservationId: { type: String, required: true },
            reservedAt: { type: Date, required: true },
        }],
        default: [],
    },
    nextAllowedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
}, { versionKey: false });

OtpSendLimitSchema.index({ emailKey: 1, purpose: 1 }, { unique: true });
OtpSendLimitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default (mongoose.models.OtpSendLimit as Model<OtpSendLimitDocument> | undefined)
    || mongoose.model<OtpSendLimitDocument>('OtpSendLimit', OtpSendLimitSchema);
