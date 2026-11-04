'use client';

import BrandMark from '@/components/BrandMark';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { hasMatchingDocumentFileType } from '@/lib/document-mime-types';

export default function SubmitPage() {
    const router = useRouter();
    const [formData, setFormData] = useState({
        userName: '',
        primaryPhone: '',
        alternatePhone: '',
        email: '',
        address: '',
        collegeName: '',
        yearOfStudying: '',
        branch: '',
        instructions: '',
    });
    const [files, setFiles] = useState<FileList | null>(null);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const MAX_FILES = 5;
    const MAX_FILE_BYTES = 3.5 * 1024 * 1024;
    const MAX_TOTAL_FILE_BYTES = 3.5 * 1024 * 1024;

    const validateFiles = (selected: FileList | null): string | null => {
        if (!selected || selected.length === 0) return 'Please upload at least one file';
        if (selected.length > MAX_FILES) return 'Upload up to 5 files at a time.';
        if (Array.from(selected).some((file) => file.size > MAX_FILE_BYTES)) {
            return 'Each file must be 3.5 MiB or smaller.';
        }
        if (Array.from(selected).reduce((total, file) => total + file.size, 0) > MAX_TOTAL_FILE_BYTES) {
            return 'Files must total no more than 3.5 MiB.';
        }
        return null;
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
        setFormData({
            ...formData,
            [e.target.name]: e.target.value,
        });
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const selected = e.target.files;
        setFiles(selected);
        const fileError = validateFiles(selected);
        setError(fileError || '');
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');

        // Validation
        if (!formData.userName || !formData.primaryPhone || !formData.email ||
            !formData.collegeName || !formData.yearOfStudying || !formData.branch || !formData.instructions) {
            setError('Please fill in all required fields');
            return;
        }

        if (!files) {
            setError('Please upload at least one file');
            return;
        }
        const fileError = validateFiles(files);
        if (fileError) {
            setError(fileError);
            return;
        }

        // Email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(formData.email)) {
            setError('Please enter a valid email address');
            return;
        }

        // File type validation
        for (let i = 0; i < files.length; i++) {
            if (!hasMatchingDocumentFileType(files[i].name, files[i].type)) {
                setError(`Invalid file type or extension: ${files[i].name}. Choose a supported PDF, Word, or PowerPoint file.`);
                return;
            }
        }

        setLoading(true);

        try {
            // Upload files first
            const uploadFormData = new FormData();
            uploadFormData.append('email', formData.email.trim());
            for (let i = 0; i < files.length; i++) {
                uploadFormData.append('files', files[i]);
            }

            const uploadResponse = await fetch('/api/upload', {
                method: 'POST',
                body: uploadFormData,
            });

            if (!uploadResponse.ok) {
                const errorData = await uploadResponse.json();
                throw new Error(errorData.error || 'Failed to upload files');
            }

            const { files: uploadedFiles, uploadToken } = await uploadResponse.json();
            if (!Array.isArray(uploadedFiles) || typeof uploadToken !== 'string') {
                throw new Error('Upload could not be secured. Please try uploading your files again.');
            }

            // Store original filenames alongside GridFS IDs for display
            const uploadedFileNames = Array.from(files).map((f) => f.name);

            // Store data in sessionStorage for next step
            const submissionData = {
                ...formData,
                uploadedFiles,       // GridFS IDs
                uploadToken,
                uploadedFileNames,   // original display names
            };
            sessionStorage.setItem('submissionData', JSON.stringify(submissionData));

            // Navigate to review page
            router.push('/submit/review');

        } catch (err: any) {
            setError(err.message || 'An error occurred');
            setLoading(false);
        }
    };

    return (
        <>
            <header className="header compact-mobile-header">
                <div className="header-content">
                    <BrandMark />
                    <nav>
                        <Link href="/">Home</Link>
                        <Link href="/track">Track Order</Link>
                    </nav>
                </div>
            </header>

            <div className="container submit-order-container">
                {/* Progress Steps */}
                <div className="progress-steps">
                    <div className="progress-step active">
                        <div className="progress-step-number">1</div>
                        <div className="progress-step-label">Details</div>
                    </div>
                    <div className="progress-step">
                        <div className="progress-step-number">2</div>
                        <div className="progress-step-label">Review</div>
                    </div>
                    <div className="progress-step">
                        <div className="progress-step-number">3</div>
                        <div className="progress-step-label">Payment</div>
                    </div>
                    <div className="progress-step">
                        <div className="progress-step-number">4</div>
                        <div className="progress-step-label">Confirmation</div>
                    </div>
                </div>

                <div className="card">
                    <h2>Submit Your Requirements</h2>

                    {error && <div className="error-message">{error}</div>}

                    <form onSubmit={handleSubmit}>
                        <div className="form-group">
                            <label>
                                Name <span className="required">*</span>
                            </label>
                            <input
                                type="text"
                                name="userName"
                                autoComplete="name"
                                value={formData.userName}
                                onChange={handleChange}
                                required
                            />
                        </div>

                        <div className="form-group">
                            <label>
                                Primary Phone <span className="required">*</span>
                            </label>
                            <input
                                type="tel"
                                name="primaryPhone"
                                autoComplete="tel"
                                value={formData.primaryPhone}
                                onChange={handleChange}
                                required
                            />
                        </div>

                        <div className="form-group">
                            <label>Alternate Phone</label>
                            <input
                                type="tel"
                                name="alternatePhone"
                                autoComplete="tel"
                                value={formData.alternatePhone}
                                onChange={handleChange}
                            />
                        </div>

                        <div className="form-group">
                            <label>
                                Email <span className="required">*</span>
                            </label>
                            <input
                                type="email"
                                name="email"
                                autoComplete="email"
                                value={formData.email}
                                onChange={handleChange}
                                required
                            />
                        </div>

                        <div className="form-group">
                            <label>Address</label>
                            <input
                                type="text"
                                name="address"
                                autoComplete="address"
                                value={formData.address}
                                onChange={handleChange}
                            />
                        </div>

                        <div className="form-group">
                            <label>
                                College Name <span className="required">*</span>
                            </label>
                            <input
                                type="text"
                                name="collegeName"
                                autoComplete="organization"
                                value={formData.collegeName}
                                onChange={handleChange}
                                required
                            />
                        </div>

                        <div className="form-group">
                            <label>
                                Year of Studying <span className="required">*</span>
                            </label>
                            <select
                                name="yearOfStudying"
                                value={formData.yearOfStudying}
                                onChange={handleChange}
                                required
                            >
                                <option value="">Select Year</option>
                                <option value="1st Year">1st Year</option>
                                <option value="2nd Year">2nd Year</option>
                                <option value="3rd Year">3rd Year</option>
                                <option value="4th Year">4th Year</option>
                                <option value="5th Year">5th Year</option>
                                <option value="Postgraduate">Postgraduate</option>
                            </select>
                        </div>

                        <div className="form-group">
                            <label>
                                Branch <span className="required">*</span>
                            </label>
                            <input
                                type="text"
                                name="branch"
                                autoComplete="department"
                                value={formData.branch}
                                onChange={handleChange}
                                placeholder="e.g., Computer Science, Mechanical Engineering"
                                required
                            />
                        </div>

                        <div className="form-group">
                            <label>
                                Upload Files (PDF, Word, PPT) <span className="required">*</span>
                            </label>
                            <input
                                type="file"
                                autoComplete="file"
                                onChange={handleFileChange}
                                accept=".pdf,.doc,.docx,.ppt,.pptx"
                                multiple
                                required
                            />
                            <small style={{ color: '#6b7280', marginTop: '0.25rem', display: 'block' }}>
                                Upload up to 5 files, with each file and all files combined no larger than 3.5 MiB. Accepted formats: PDF, Word, PowerPoint.
                            </small>
                        </div>

                        <div className="form-group">
                            <label>
                                Instructions/Description <span className="required">*</span>
                            </label>
                            <textarea
                                name="instructions"
                                value={formData.instructions}
                                onChange={handleChange}
                                required
                                placeholder="Provide detailed instructions for your writing requirements..."
                            ></textarea>
                        </div>

                        <button type="submit" className="btn btn-primary btn-block" disabled={loading}>
                            {loading ? 'Uploading...' : 'Continue to Review'}
                        </button>
                    </form>
                </div>
            </div>
        </>
    );
}
