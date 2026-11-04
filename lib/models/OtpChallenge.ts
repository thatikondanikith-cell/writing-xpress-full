import mongoose, { Document, Model, Schema } from 'mongoose';
import type { OtpEmailPurpose } from '@/lib/email';

export interface OtpChallengeDocument extends Document {
    subjectId: string;
    email: string;
    purpose: OtpEmailPurpose;
    otpHash: string;
    expiresAt: Date;
    failedAttempts: number;
    resendAvailableAt: Date;
    usedAt?: Date;
    createdAt: Date;
    registrationCompletion?: {
        role: 'user' | 'writer';
        name: string;
        detailsHash: string;
        claimedAt: Date;
    };
}

const OtpChallengeSchema = new Schema<OtpChallengeDocument>({
    subjectId: { type: String, required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    purpose: { type: String, enum: ['registration', 'email_change', 'password_reset'], required: true },
    otpHash: { type: String, required: true, select: false },
    expiresAt: { type: Date, required: true },
    failedAttempts: { type: Number, required: true, default: 0 },
    resendAvailableAt: { type: Date, required: true },
    usedAt: { type: Date },
    createdAt: { type: Date, required: true, default: Date.now },
    registrationCompletion: {
        role: { type: String, enum: ['user', 'writer'] },
        name: { type: String },
        detailsHash: { type: String, select: false },
        claimedAt: { type: Date },
    },
}, { versionKey: false });

OtpChallengeSchema.index({ subjectId: 1, email: 1, purpose: 1 }, { unique: true });
OtpChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default (mongoose.models.OtpChallenge as Model<OtpChallengeDocument> | undefined)
    || mongoose.model<OtpChallengeDocument>('OtpChallenge', OtpChallengeSchema);
