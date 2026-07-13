import { cacheLife, cacheTag, revalidatePath, revalidateTag, updateTag } from 'next/cache';
import { Suspense } from 'react';
import { newsCacheKeyFactory, newsCacheLifeFactory, NewsPageBody } from '@pages/news';
import { type RoutingParameters } from '../../../../src/shared/types';
import { LayoutWrapper } from '@shared/ui/layoutWrapper';

const revalidateNewsPath = async () => {
    'use server';
    revalidatePath('/[country]/[lang]/news', 'page');
};

const updateTranslationsTag = async () => {
    'use server';
    updateTag('data:translations:pl');
};

const revalidateTranslationsTag = async () => {
    'use server';
    revalidateTag('data:translations:pl', 'max');
};

const revalidateNewsTag = async () => {
    'use server';
    revalidateTag('ui:news:pl', 'max');
};

const updateNewsTag = async () => {
    'use server';
    updateTag('ui:news:pl');
};

const updateProductsTag = async () => {
    'use server';
    updateTag('data:products');
};

const revalidateProductsTag = async () => {
    'use server';
    revalidateTag('data:products', 'max');
};

const updateProductsUiTag = async () => {
    'use server';
    updateTag('ui:products');
};

interface DummyProduct {
    id: number;
    price: number;
    thumbnail: string;
    title: string;
}

const getRandomProducts = async (): Promise<DummyProduct[]> => {
    // 'use cache: remote';
    // cacheLife('hours');
    // cacheTag('data:products');
    const randomSkip = Math.floor(Math.random() * 90);
    const res = await fetch(`https://dummyjson.com/products?limit=3&skip=${randomSkip}`);
    const data = await res.json();
    return data.products;
};

const CachedProducts = async () => {
    'use cache: remote';
    cacheLife('hours');
    cacheTag('ui:products');
    const products = await getRandomProducts();
    const fetchedAt = new Date().toISOString();

    return (
        <>
            <div style={{ color: '#858585', fontFamily: 'monospace' }}>
                {`products fetched at › ${fetchedAt}`}
            </div>
            <div style={{ display: 'flex', gap: '12px', marginBottom: '16px' }}>
                {products.map(product => (
                    <div key={product.id} style={{ border: '1px solid #333', borderRadius: '6px', padding: '12px', width: '160px' }}>
                        <img alt={product.title} src={product.thumbnail} style={{ borderRadius: '4px', width: '100%' }} />
                        <div style={{ fontSize: '13px', marginTop: '8px' }}>{product.title}</div>
                        <div style={{ color: '#4ec9b0', fontWeight: 'bold' }}>{`$${product.price}`}</div>
                    </div>
                ))}
            </div>
        </>
    );
};

const NewsPageShell = async ({ lang }: { lang: string }) => {
    'use cache: remote';
    cacheLife(newsCacheLifeFactory.newsPageCacheLife);
    cacheTag(newsCacheKeyFactory.newsPage(lang));

    const renderedAt = new Date().toISOString();

    return (
        <div style={{ background: '#1e1e1e', borderRadius: '6px', color: '#4ec9b0', fontFamily: 'monospace', marginBottom: '16px', padding: '12px' }}>
            <span style={{ color: '#858585' }}>{'page rendered at › '}</span>
            {renderedAt}
        </div>
    );
};

const NewsPage = async ({ params }: { params: RoutingParameters }) => {
    const { lang } = await params;

    return (
        <LayoutWrapper>
            <NewsPageShell lang={lang} />
            <Suspense fallback={<span>{'Loading...'}</span>}>
                <CachedProducts />
            </Suspense>
            <NewsPageBody />
            <form action={revalidateNewsPath}>
                <button type={'submit'}>{'revalidatePath /news'}</button>
            </form>
            <form action={updateTranslationsTag}>
                <button type={'submit'}>{'updateTag data:translations'}</button>
            </form>
            <form action={revalidateTranslationsTag}>
                <button type={'submit'}>{'revalidateTag data:translations'}</button>
            </form>
            <form action={revalidateNewsTag}>
                <button type={'submit'}>{'revalidateTag ui:news'}</button>
            </form>
            <form action={updateNewsTag}>
                <button type={'submit'}>{'updateTag ui:news'}</button>
            </form>
            <form action={updateProductsTag}>
                <button type={'submit'}>{'updateTag data:products'}</button>
            </form>
            <form action={revalidateProductsTag}>
                <button type={'submit'}>{'revalidateTag data:products'}</button>
            </form>
            <form action={updateProductsUiTag}>
                <button type={'submit'}>{'revalidateTag ui:products'}</button>
            </form>
        </LayoutWrapper>
    );
};

export default NewsPage;
