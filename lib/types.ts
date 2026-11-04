export type OrderStatus = 'Submitted' | 'In Progress' | 'Completed';
export type WriterWorkflowStatus = 'not_started' | 'assigned' | 'submitted_for_review' | 'revision_required' | 'approved';
export type WriterSubmissionStatus = 'pending_review' | 'revision_required' | 'approved' | 'superseded';

export interface WriterSubmission {
    submissionId: string;
    writerId: string;
    assignmentVersion: number;
    fileId: string;
    submittedAt: string;
    reviewStatus: WriterSubmissionStatus;
    reviewedAt?: string;
    reviewedByAdminId?: string;
    reviewFeedback?: string;
    supersededAt?: string;
}

export interface Order {
    orderId: string;
    userName: string;
    primaryPhone: string;
    alternatePhone?: string;
    /** Authenticated account that owns this order; absent on legacy orders. */
    ownerEmail?: string;
    /** Customer contact address used for order communications. */
    email: string;
    address?: string;
    collegeName: string;
    yearOfStudying: string;
    branch: string; // Mandatory academic branch field
    uploadedFiles: string[]; // GridFS ObjectId strings (served via /api/files/[id])
    instructions: string;
    priceAmount?: number;
    transactionId?: string;
    orderStatus: OrderStatus;
    createdDate: string; // ISO string
    completedAt?: string; // ISO string; set/cleared with the order status transition
    deliveryFile?: string; // GridFS ObjectId string (served via /api/files/[id])
    physicalDeliveryStatus?: 'Pending' | 'Delivered';
    completedByWriterId?: string;
    completedAssignmentVersion?: number;
    writerCompletedAt?: string;
    customerReview?: {
        writerId: string;
        reviewerUserId: string;
        rating: number;
        displayName?: string;
        text?: string;
        submittedAt: string;
    };
    writerWorkflowStatus?: WriterWorkflowStatus;
    currentWriterSubmissionId?: string;
    approvedSubmissionId?: string;
    writerSubmissions?: WriterSubmission[];
    assignedWriterId?: string;
    assignedAt?: string;
    assignedByAdminId?: string;
    assignmentStatus?: 'pending_acceptance' | 'accepted';
    assignmentResponseDeadline?: string;
    assignmentRespondedAt?: string;
    assignmentOverrideReason?: string;
    assignmentOverrideAt?: string;
    assignmentOverrideByAdminId?: string;
    assignmentVersion?: number;
    assignmentHistory?: Array<{
        writerId: string;
        assignedAt: string;
        assignedByAdminId: string;
        assignmentVersion?: number;
        status?: 'pending_acceptance' | 'accepted' | 'declined' | 'expired' | 'reassigned';
        responseDeadline?: string;
        respondedAt?: string;
        declinedAt?: string;
        expiredAt?: string;
        reassignedAt?: string;
        reassignedByAdminId?: string;
        completedAt?: string;
        overrideReason?: string;
    }>;
}

export interface SubmissionFormData {
    userName: string;
    primaryPhone: string;
    alternatePhone?: string;
    email: string;
    address?: string;
    collegeName: string;
    yearOfStudying: string;
    branch: string; // Mandatory academic branch field
    instructions: string;
    files: File[];
}
