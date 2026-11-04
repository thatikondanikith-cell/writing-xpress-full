import mongoose, { Schema, Document, Model } from 'mongoose';
import { Order } from '../types';

export interface OrderDocument extends Omit<Order, 'orderId'>, Document {
    orderId: string;
}

const OrderSchema = new Schema<OrderDocument>(
    {
        orderId: { type: String, required: true, unique: true },
        userName: { type: String, required: true },
        primaryPhone: { type: String, required: true },
        alternatePhone: { type: String },
        ownerEmail: { type: String },
        email: { type: String, required: true },
        address: { type: String },
        collegeName: { type: String, required: true },
        yearOfStudying: { type: String, required: true },
        branch: { type: String, required: true },
        uploadedFiles: { type: [String], required: true },
        instructions: { type: String, required: true },
        priceAmount: { type: Number },
        transactionId: { type: String },
        orderStatus: {
            type: String,
            enum: ['Submitted', 'In Progress', 'Completed'],
            default: 'Submitted',
            required: true,
        },
        createdDate: { type: String, required: true },
        completedAt: { type: String },
        deliveryFile: { type: String },
        physicalDeliveryStatus: {
            type: String,
            enum: ['Pending', 'Delivered'],
            default: 'Pending',
        },
        completedByWriterId: { type: String },
        completedAssignmentVersion: { type: Number },
        writerCompletedAt: { type: String },
        customerReview: {
            writerId: { type: String },
            reviewerUserId: { type: String },
            rating: { type: Number, min: 1, max: 5, validate: Number.isInteger },
            displayName: { type: String, trim: true, minlength: 2, maxlength: 60 },
            text: { type: String, trim: true, minlength: 10, maxlength: 1000 },
            submittedAt: { type: String },
        },
        writerWorkflowStatus: {
            type: String,
            enum: ['not_started', 'assigned', 'submitted_for_review', 'revision_required', 'approved'],
            default: 'not_started',
        },
        currentWriterSubmissionId: { type: String },
        approvedSubmissionId: { type: String },
        writerSubmissions: {
            type: [{
                submissionId: { type: String, required: true },
                writerId: { type: String, required: true },
                assignmentVersion: { type: Number, required: true },
                fileId: { type: String, required: true },
                submittedAt: { type: String, required: true },
                reviewStatus: { type: String, enum: ['pending_review', 'revision_required', 'approved', 'superseded'], required: true },
                reviewedAt: { type: String },
                reviewedByAdminId: { type: String },
                reviewFeedback: { type: String, maxlength: 2000 },
                supersededAt: { type: String },
            }],
            default: [],
        },
        assignedWriterId: { type: String },
        assignedAt: { type: String },
        assignedByAdminId: { type: String },
        assignmentStatus: { type: String, enum: ['pending_acceptance', 'accepted'] },
        assignmentResponseDeadline: { type: String },
        assignmentRespondedAt: { type: String },
        assignmentOverrideReason: { type: String, maxlength: 500 },
        assignmentOverrideAt: { type: String },
        assignmentOverrideByAdminId: { type: String },
        assignmentVersion: { type: Number, default: 0 },
        assignmentHistory: {
            type: [{
                writerId: { type: String, required: true },
                assignedAt: { type: String, required: true },
                assignedByAdminId: { type: String, required: true },
                assignmentVersion: { type: Number },
                status: { type: String, enum: ['pending_acceptance', 'accepted', 'declined', 'expired', 'reassigned'] },
                responseDeadline: { type: String },
                respondedAt: { type: String },
                declinedAt: { type: String },
                expiredAt: { type: String },
                reassignedAt: { type: String },
                reassignedByAdminId: { type: String },
                completedAt: { type: String },
                overrideReason: { type: String, maxlength: 500 },
            }],
            default: [],
        },
    },
    {
        // Don't use Mongoose's default _id as the main identifier;
        // we keep our custom orderId (WX-YYYYMMDD-XXXX) as the public ID.
        versionKey: false,
    }
);

OrderSchema.index({ orderStatus: 1, completedAt: 1 });

// Prevent model recompilation on hot reloads
const OrderModel: Model<OrderDocument> =
    mongoose.models.Order || mongoose.model<OrderDocument>('Order', OrderSchema);

export default OrderModel;
