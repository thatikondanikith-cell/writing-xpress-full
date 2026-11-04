import Link from 'next/link';

export default function BrandMark({ href = '/', label = 'Writing Xpress home', currentPage = false }: { href?: string; label?: string; currentPage?: boolean }) {
    return (
        <Link href={href} className="brand-wordmark" aria-label={label} aria-current={currentPage ? 'page' : undefined}>
            <span>WRITING</span><span className="brand-wordmark__x">X</span><span>PRESS</span>
        </Link>
    );
}
