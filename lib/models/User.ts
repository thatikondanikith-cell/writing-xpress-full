import mongoose, { Schema, Document, Model } from 'mongoose';

export interface UserDocument extends Document {
    name: string;
    email: string;
    passwordHash: string;
    createdAt: string;
    role: 'user' | 'writer';
    applicationStatus?: 'pending' | 'approved' | 'rejected';
    applicationSubmittedAt?: string;
    applicationReviewedAt?: string;
    applicationReviewedBy?: string;
    applicationRejectionReason?: string;
    isAvailable?: boolean;
    assignmentValidationVersion?: number;
}

const UserSchema = new Schema<UserDocument>(
    {
        name: { type: String, required: true },
        email: { type: String, required: true, unique: true, lowercase: true, trim: true },
        passwordHash: { type: String, required: true },
        createdAt: { type: String, required: true },
        // Existing customer documents without a role continue to be treated as users.
        role: { type: String, enum: ['user', 'writer'], default: 'user', required: true },
        applicationStatus: { type: String, enum: ['pending', 'approved', 'rejected'] },
        applicationSubmittedAt: { type: String },
        applicationReviewedAt: { type: String },
        applicationReviewedBy: { type: String },
        applicationRejectionReason: { type: String, maxlength: 500 },
        // Missing values on existing writer accounts are treated as unavailable.
        isAvailable: { type: Boolean, default: false },
        // Incremented within assignment transactions to serialize eligibility changes.
        assignmentValidationVersion: { type: Number, default: 0 },
    },
    { versionKey: false }
);

const UserModel: Model<UserDocument> =
    mongoose.models.User || mongoose.model<UserDocument>('User', UserSchema);

export default UserModel;
