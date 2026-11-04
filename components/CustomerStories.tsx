'use client';

import { useEffect, useRef, useState, type PointerEvent } from 'react';

type PublicReview = { displayName: string; rating: number; text: string; verifiedCustomer: true };

export default function CustomerStories() {
    const [reviews, setReviews] = useState<PublicReview[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const [moving, setMoving] = useState(false);
    const [paused, setPaused] = useState(false);
    const [loopWidth, setLoopWidth] = useState(0);
    const viewportRef = useRef<HTMLDivElement>(null);
    const groupRef = useRef<HTMLDivElement>(null);
    const touchResumeTimer = useRef<number | null>(null);

    useEffect(() => {
        let active = true;
        fetch('/api/public/reviews', { cache: 'no-store' })
            .then(async (response) => {
                if (!response.ok) throw new Error('Could not load reviews');
                return response.json() as Promise<{ reviews?: PublicReview[] }>;
            })
            .then((data) => {
                if (active) setReviews(Array.isArray(data.reviews) ? data.reviews : []);
            })
            .catch(() => { if (active) setError(true); })
            .finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, []);

    useEffect(() => {
        const viewport = viewportRef.current;
        const group = groupRef.current;
        if (!viewport || !group || reviews.length < 3) {
            setMoving(false);
            setLoopWidth(0);
            if (viewport) viewport.scrollLeft = 0;
            return;
        }
        const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
        const update = () => {
            const groupWidth = group.scrollWidth;
            const shouldMove = !motionPreference.matches && groupWidth > viewport.clientWidth + 32;
            setMoving(shouldMove);
            setLoopWidth(shouldMove ? groupWidth : 0);
            if (!shouldMove) viewport.scrollLeft = 0;
        };
        update();
        const observer = new ResizeObserver(update);
        observer.observe(viewport);
        observer.observe(group);
        motionPreference.addEventListener('change', update);
        return () => {
            observer.disconnect();
            motionPreference.removeEventListener('change', update);
        };
    }, [reviews]);

    useEffect(() => {
        const viewport = viewportRef.current;
        if (!moving || paused || !viewport || loopWidth <= 0) return;

        let frame = 0;
        let previousFrameTime = 0;
        const pixelsPerSecond = 42;
        const animate = (frameTime: number) => {
            if (previousFrameTime === 0) previousFrameTime = frameTime;
            const elapsed = Math.min(frameTime - previousFrameTime, 50);
            previousFrameTime = frameTime;

            let nextScrollLeft = viewport.scrollLeft + (elapsed / 1000) * pixelsPerSecond;
            while (nextScrollLeft >= loopWidth * 2) nextScrollLeft -= loopWidth;
            while (nextScrollLeft < loopWidth) nextScrollLeft += loopWidth;
            viewport.scrollLeft = nextScrollLeft;
            frame = window.requestAnimationFrame(animate);
        };

        // Start in the middle copy so swipes can scroll in either direction and
        // the identical neighboring copies keep every wrap visually seamless.
        if (viewport.scrollLeft < loopWidth) viewport.scrollLeft += loopWidth;
        frame = window.requestAnimationFrame(animate);
        return () => window.cancelAnimationFrame(frame);
    }, [moving, paused, loopWidth]);

    useEffect(() => () => {
        if (touchResumeTimer.current !== null) window.clearTimeout(touchResumeTimer.current);
    }, []);

    const pauseForTouch = (event: PointerEvent<HTMLDivElement>) => {
        if (event.pointerType === 'mouse') return;
        if (touchResumeTimer.current !== null) window.clearTimeout(touchResumeTimer.current);
        setPaused(true);
    };

    const resumeAfterTouch = (event: PointerEvent<HTMLDivElement>) => {
        if (event.pointerType === 'mouse') return;
        if (touchResumeTimer.current !== null) window.clearTimeout(touchResumeTimer.current);
        touchResumeTimer.current = window.setTimeout(() => setPaused(false), 1600);
    };

    const renderReview = (review: PublicReview, index: number) => (
        <article className="story-card" key={`${review.displayName}-${index}`}>
            <div className="story-card__stars" aria-label={`${review.rating} out of 5 stars`}>
                <span aria-hidden="true">{'★'.repeat(review.rating)}{'☆'.repeat(5 - review.rating)}</span>
                <span className="story-card__rating">{review.rating}.0</span>
            </div>
            <blockquote>{review.text}</blockquote>
            <div className="story-card__person">
                <span className="story-card__avatar" aria-hidden="true">{review.displayName.trim().charAt(0).toUpperCase()}</span>
                <span><strong>{review.displayName}</strong><small><span aria-hidden="true">✓</span> Verified customer</small></span>
            </div>
        </article>
    );

    return (
        <section
            className="landing-stories"
            aria-labelledby="customer-stories-title"
            onPointerEnter={(event) => { if (event.pointerType === 'mouse') setPaused(true); }}
            onPointerLeave={(event) => { if (event.pointerType === 'mouse') setPaused(false); }}
        >
            <div className="landing-stories__heading">
                <p className="stories-eyebrow">Kind words, shared</p>
                <h2 id="customer-stories-title">Customer Stories</h2>
                <p>Real experiences from customers who trusted WRITING-XPRESS.</p>
            </div>
            {loading ? <p className="landing-stories__message" role="status">Loading customer stories…</p> : error ? (
                <p className="landing-stories__message" role="alert">Customer stories could not be loaded right now. Please try again later.</p>
            ) : reviews.length === 0 ? (
                <p className="landing-stories__message">Customer stories will appear here as customers share their experiences.</p>
            ) : (
                <div
                    className={`stories-viewport${reviews.length === 1 ? ' stories-viewport--single' : ''}`}
                    ref={viewportRef}
                    onPointerDown={pauseForTouch}
                    onPointerUp={resumeAfterTouch}
                    onPointerCancel={resumeAfterTouch}
                    onFocus={() => setPaused(true)}
                    onBlur={() => setPaused(false)}
                    tabIndex={0}
                    aria-label="Customer testimonials. Swipe or scroll horizontally to read more."
                >
                    <div className="stories-track">
                        <div className="stories-group" ref={groupRef}>{reviews.map(renderReview)}</div>
                        {moving && <>
                            <div className="stories-group" aria-hidden="true">{reviews.map((review, index) => renderReview(review, index + reviews.length))}</div>
                            <div className="stories-group" aria-hidden="true">{reviews.map((review, index) => renderReview(review, index + reviews.length * 2))}</div>
                        </>}
                    </div>
                </div>
            )}
        </section>
    );
}
