import mongoose, { Document, Model, Schema } from 'mongoose';

export type OtpIpAction = 'request' | 'verify' | 'upload';

export interface OtpIpRateLimitDocument extends Document {
    ipKey: string;
    action: OtpIpAction;
    events: Date[];
    expiresAt: Date;
}

const OtpIpRateLimitSchema = new Schema<OtpIpRateLimitDocument>({
    ipKey: { type: String, required: true },
    action: { type: String, enum: ['request', 'verify', 'upload'], required: true },
    events: { type: [Date], required: true },
    expiresAt: { type: Date, required: true },
}, { versionKey: false });

OtpIpRateLimitSchema.index({ ipKey: 1, action: 1 }, { unique: true });
OtpIpRateLimitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default (mongoose.models.OtpIpRateLimit as Model<OtpIpRateLimitDocument> | undefined)
    || mongoose.model<OtpIpRateLimitDocument>('OtpIpRateLimit', OtpIpRateLimitSchema);
