import mongoose, { Document, Model, Schema } from 'mongoose';

export type FileRetentionReason = 'completed-order' | 'abandoned-upload' | 'replaced-delivery' | 'orphaned-writer-submission';
export type FileRetentionState = 'pending' | 'retained-shared';

export interface FileRetentionTaskDocument extends Document {
    fileId: mongoose.Types.ObjectId;
    reason: FileRetentionReason;
    sourceOrderId?: mongoose.Types.ObjectId;
    eligibleAt: Date;
    state: FileRetentionState;
    attempts: number;
    createdAt: Date;
    lastAttemptAt?: Date;
}

const FileRetentionTaskSchema = new Schema<FileRetentionTaskDocument>({
    fileId: { type: Schema.Types.ObjectId, required: true },
    reason: { type: String, enum: ['completed-order', 'abandoned-upload', 'replaced-delivery', 'orphaned-writer-submission'], required: true },
    sourceOrderId: { type: Schema.Types.ObjectId },
    eligibleAt: { type: Date, required: true },
    state: { type: String, enum: ['pending', 'retained-shared'], default: 'pending', required: true },
    attempts: { type: Number, default: 0, required: true },
    createdAt: { type: Date, default: Date.now, required: true },
    lastAttemptAt: { type: Date },
}, { versionKey: false });

FileRetentionTaskSchema.index({ fileId: 1 }, { unique: true });
FileRetentionTaskSchema.index({ state: 1, createdAt: 1 });

export default (mongoose.models.FileRetentionTask as Model<FileRetentionTaskDocument> | undefined)
    || mongoose.model<FileRetentionTaskDocument>('FileRetentionTask', FileRetentionTaskSchema);
