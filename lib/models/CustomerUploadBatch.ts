import mongoose, { Document, Model, Schema } from 'mongoose';

export interface CustomerUploadBatchDocument extends Document {
    batchId: string;
    tokenHash: string;
    fileIds: string[];
    email: string;
    expiresAt: Date;
    claimedOrderId?: string;
    claimedAt?: Date;
    requestFingerprint?: string;
    purgeAt: Date;
    createdAt: Date;
}

const CustomerUploadBatchSchema = new Schema<CustomerUploadBatchDocument>({
    batchId: { type: String, required: true, unique: true },
    tokenHash: { type: String, required: true, unique: true },
    fileIds: { type: [String], required: true },
    email: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    claimedOrderId: { type: String },
    claimedAt: { type: Date },
    requestFingerprint: { type: String },
    purgeAt: { type: Date, required: true },
    createdAt: { type: Date, default: Date.now, required: true },
}, { versionKey: false });

CustomerUploadBatchSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export default (mongoose.models.CustomerUploadBatch as Model<CustomerUploadBatchDocument> | undefined)
    || mongoose.model<CustomerUploadBatchDocument>('CustomerUploadBatch', CustomerUploadBatchSchema);
