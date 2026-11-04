import mongoose, { Document, Model, Schema } from 'mongoose';

export interface DailyOrderCounterDocument extends Document<string> {
    sequence: number;
}

const DailyOrderCounterSchema = new Schema<DailyOrderCounterDocument>({
    _id: { type: String, required: true },
    sequence: { type: Number, required: true, min: 0 },
}, { versionKey: false });

const DailyOrderCounter = (mongoose.models.DailyOrderCounter as Model<DailyOrderCounterDocument> | undefined)
    || mongoose.model<DailyOrderCounterDocument>('DailyOrderCounter', DailyOrderCounterSchema);

export default DailyOrderCounter;
