import { useCallback, useEffect, useState } from 'react';
import { fetchProducts } from './api';
import { ProductCard } from './components/ProductCard';
import type { Product } from './types';

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; products: Product[] };

export default function App() {
  const [state, setState] = useState<State>({ status: 'loading' });

  const load = useCallback((signal?: AbortSignal) => {
    setState({ status: 'loading' });
    fetchProducts(signal)
      .then((products) => setState({ status: 'ready', products }))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setState({ status: 'error', message: err instanceof Error ? err.message : 'Unknown error' });
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return (
    <main className="page">
      <header>
        <h1>Product List</h1>
        <p className="sub">React on S3 + CloudFront · Node.js on ECS Fargate · MySQL on RDS</p>
      </header>

      {state.status === 'loading' && <p className="status">Loading products…</p>}

      {state.status === 'error' && (
        <div className="status error" role="alert">
          <p>Could not load products ({state.message}).</p>
          <button onClick={() => load()}>Try again</button>
        </div>
      )}

      {state.status === 'ready' && (
        <section className="grid">
          {state.products.map((p) => (
            <ProductCard key={p.id} product={p} />
          ))}
        </section>
      )}
    </main>
  );
}
