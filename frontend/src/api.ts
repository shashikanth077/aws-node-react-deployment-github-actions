import type { Product } from './types';

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

export async function fetchProducts(signal?: AbortSignal): Promise<Product[]> {
  const res = await fetch(`${API_BASE}/api/products`, { signal });
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  const body = (await res.json()) as { products: Product[] };
  return body.products;
}
