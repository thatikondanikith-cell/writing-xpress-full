import Link from 'next/link';
import BrandMark from '@/components/BrandMark';

export default function PublicFooter() {
    return (
        <footer className="public-footer">
            <div className="public-footer__inner">
                <div>
                    <BrandMark />
                    <p>Clear requirements. Visible progress. A simpler way to manage your writing support.</p>
                </div>
                <nav aria-label="Footer navigation">
                    <Link href="/user/login">Customer sign in</Link>
                    <Link href="/writer/signup">Apply as a writer</Link>
                </nav>
            </div>
            <div className="public-footer__bottom">© {new Date().getFullYear()} Writing Xpress</div>
        </footer>
    );
}
